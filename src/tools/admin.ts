/**
 * admin tool 注册（v0.6 M0.6 新增，parse7 §3.5 —— 单 tool + action-enum 折叠 9 action）
 *
 * 设计原则（parse7 §3.5 + 13 §3.1 #1 必改）：
 *  - 单 admin tool + action-enum，禁注册 admin_capability_disable 等拆分 tool
 *    （与 INV-17 desktop action-enum 同范式）
 *  - destructiveHint=true（与 desktop_act / browse_logged_in 同级风险）
 *  - 所有 mutation 必须传 reason 字段（强制思考；R-RT-8 风险缓解）
 *  - description 明确标「ONLY when user explicitly asks」
 *
 * INV-37（task v0.6）：admin 是 v0.6 新 tool，**必经 ToolManager.register**（不直调
 *                     server.tool）—— 这样 admin 自身被 ToolManager 跟踪，
 *                     channel="admin" 永不被 disable（admin 不能 disable 自己）。
 *                     注意：admin.ts 在 src/tools/ 不在 src/runtime/，INV-37 必要条件 4
 *                     （runtime/ 内禁 server.tool）不直接管辖，但精神一致 —— 走 ToolManager。
 *
 * 安全约束（parse7 §3.5）：
 *  - provider_add 时 keys 必须从 process.env.<PROVIDER>_API_KEYS 读，禁直接传 key 字面量
 *    （INV-10 衍生：anti-gaming；admin input schema 不接受 keys 字段）
 *  - provider_remove / capability_disable 必须传 reason（audit log 必填）
 *  - 所有 mutation 写 audit log（logger.info {evt:"admin_audit", ...}）
 *
 * 返回值约定：
 *  - 全部 action 返 { content: [{ type: "text", text: JSON }] } 标准 MCP 形状
 *  - JSON 内含 { action, ok: boolean, ...payload } 三件套
 *  - mutation 失败时 ok=false + error 字段（不抛异常，让 CC 收到结构化错误）
 */
import { z } from "zod";
import type { ProviderConfig } from "../types.js";
import type { CapabilityBag } from "../runtime/CapabilityBag.js";
import type { ToolManager } from "../runtime/ToolManager.js";
import type { CallerTierTracker } from "../runtime/CallerTierTracker.js";
import type { ProviderRegistry } from "../config/provider-registry.js";
import type { AdminAction } from "../runtime/runtime-types.js";
import {
  addProvider,
  removeProvider,
} from "../runtime/hot-reload.js";
import { ADMIN_DESCRIPTION } from "./descriptions.js";
import { adminAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";

// ============================================================
// Schema（parse7 §3.5 action-enum 折叠）
// ============================================================
/**
 * 9 action union（与 runtime-types.ts AdminAction 对齐）。
 *
 * 折叠原则（INV-17 desktop action-enum 同范式）：
 *  - 单 tool + action enum 避免污染 CC tool palette
 *  - mutation action 在 handler 内强制 reason 字段（schema 层 optional，handler 层 required）
 *  - tos_ack 字段 Phase A 实装为 boolean（与 types.ts ProviderConfig.tos_ack 对齐）
 */
export const adminSchema = {
  action: z.enum([
    "capability_list",
    "capability_disable",
    "capability_enable",
    "tool_list",
    "provider_add",
    "provider_remove",
    "provider_set_tos",
    "caller_cap_set",
    "caller_cap_list",
  ]),
  name: z.string().min(1).optional(),
  /**
   * provider_add 入参（parse7 §3.5）。
   *
   * INV-10 衍生：**不接受 keys 字段**（即使调用方传也忽略 + 从 env 读）；
   * handler 内显式 delete config.keys 后才进 registry.add。
   */
  config: z
    .object({
      name: z.string().min(1),
      type: z.enum(["api_key", "broker", "self_hosted"]),
      endpoint_url: z.string().nullable().optional(),
      free_quota_per_month: z.number().int().nonnegative().optional(),
      quota_model: z
        .enum(["monthly", "rpm", "token", "request"])
        .optional(),
      fallback_order: z.number().int().nonnegative().optional(),
      tags: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
      policy_risk: z.enum(["safe", "acquired", "watched"]).optional(),
      tos_url: z.string().optional(),
      tos_ack: z.boolean().optional(),
    })
    .passthrough() // 允许其他字段透传（free_tier_level 等）—— 但 keys 在 handler 内强制剔除
    .optional(),
  /** provider_set_tos 用（Phase A boolean，与 types.ts 对齐） */
  tos_ack: z.boolean().optional(),
  /** caller_cap_set 用 */
  callerId: z.string().min(1).optional(),
  cap: z.number().int().nonnegative().optional(),
  /** mutation action 强制（handler 层校验） */
  reason: z.string().min(1).optional(),
};

// ============================================================
// admin tool 依赖（注入接口）
// ============================================================
/**
 * registerAdminTool 的依赖集合（index.ts 装配时注入）。
 *
 * 守 INV-35（task v0.6）：admin.ts 不 import runtime/ 之外 BrowseChannel/DesktopChannel
 *                        internal；只经此接口持 CapabilityBag / ToolManager /
 *                        CallerTierTracker / ProviderRegistry 句柄。
 */
export interface AdminToolDeps {
  bag: CapabilityBag;
  toolManager: ToolManager;
  callerTier: CallerTierTracker;
  registry: ProviderRegistry;
}

// ============================================================
// admin tool 注册
// ============================================================
/**
 * 注册 admin tool —— 经 toolManager.register（INV-37 task v0.6 精神一致）。
 *
 * channel="admin" 是 v0.6 新引入的虚拟 channel —— ToolManager 管它，但 bag 的
 * CHANNEL_TO_SPEC 不映射它（admin 无子进程）； CapabilityBag.initial 不包含 "admin"
 * （admin 永远 enabled，不能 disable 自己）。
 *
 * @returns RegisteredTool 句柄（ToolManager 内部已记录）
 */
export function registerAdminTool(
  deps: AdminToolDeps,
): void {
  deps.toolManager.register(
    "admin",
    {
      name: "admin",
      description: ADMIN_DESCRIPTION,
      schema: adminSchema,
      annotations: adminAnnotations,
      handler: async (argsRaw: unknown) => {
        // SDK 已据 schema 校验 + 应用 default；args 形状保证
        const args = argsRaw as {
          action: string;
          name?: string;
          config?: Record<string, unknown>;
          tos_ack?: boolean;
          callerId?: string;
          cap?: number;
          reason?: string;
        };
        const action = args.action as AdminAction;

        // callerId：admin 自身的 callerId 优先从 args 读（admin 主动传则用之）；
        // 否则 fallback "admin"（区别于 caller-tier 的 "anonymous"）。
        const callerId = args.callerId ?? "admin";

        try {
          switch (action) {
            // ---------- 只读 action ----------
            case "capability_list":
              return ok(action, {
                capabilities: deps.bag.snapshot(),
              });
            case "tool_list": {
              const byChannel = deps.toolManager.listByChannel();
              const out: Record<string, string[]> = {};
              for (const [ch, names] of byChannel) out[ch] = names;
              return ok(action, {
                channels: out,
                total_tools: deps.toolManager.size(),
              });
            }
            case "caller_cap_list":
              return ok(action, {
                callers: deps.callerTier.snapshot(),
              });

            // ---------- channel/provider 启停 ----------
            case "capability_disable": {
              const err = requireArgs(action, args, ["name", "reason"]);
              if (err) return err;
              const changed = await deps.bag.disable(args.name!, {
                callerId,
                reason: args.reason,
              });
              audit(action, callerId, args.reason, {
                name: args.name,
                changed,
              });
              return ok(action, {
                name: args.name,
                changed,
                note: changed
                  ? undefined
                  : "already disabled or unknown name (no-op)",
              });
            }
            case "capability_enable": {
              const err = requireArgs(action, args, ["name"]);
              if (err) return err;
              const changed = await deps.bag.enable(args.name!, { callerId });
              audit(action, callerId, args.reason, {
                name: args.name,
                changed,
              });
              return ok(action, {
                name: args.name,
                changed,
                note: changed
                  ? undefined
                  : "already enabled or unknown name (no-op)",
              });
            }

            // ---------- provider 热插拔 ----------
            case "provider_add": {
              if (!args.config) {
                return fail(action, "config required for provider_add");
              }
              const cfg = buildProviderConfig(args.config, action);
              if ("error" in cfg) {
                return fail(action, cfg.error);
              }
              try {
                await addProvider(cfg.config, deps.registry, deps.bag, deps.toolManager);
              } catch (e) {
                audit(action, callerId, args.reason, {
                  name: cfg.config.name,
                  error: String(e),
                });
                return fail(action, `registry.add failed: ${String(e)}`);
              }
              audit(action, callerId, args.reason, {
                name: cfg.config.name,
              });
              return ok(action, {
                name: cfg.config.name,
                keys_from_env: cfg.keys_from_env,
              });
            }
            case "provider_remove": {
              const err = requireArgs(action, args, ["name", "reason"]);
              if (err) return err;
              let removed = false;
              try {
                removed = await removeProvider(
                  args.name!,
                  deps.registry,
                  deps.bag,
                  deps.toolManager,
                  { callerId, reason: args.reason },
                );
              } catch (e) {
                audit(action, callerId, args.reason, {
                  name: args.name,
                  error: String(e),
                });
                return fail(action, `removeProvider failed: ${String(e)}`);
              }
              audit(action, callerId, args.reason, {
                name: args.name,
                removed,
              });
              return ok(action, { name: args.name, removed });
            }
            case "provider_set_tos": {
              const err = requireArgs(action, args, ["name", "tos_ack"]);
              if (err) return err;
              const entry = deps.registry.get(args.name!);
              if (!entry) {
                return fail(
                  action,
                  `provider not found: ${args.name}`,
                );
              }
              // 直接 mutate entry.config（ProviderConfig 是 mutable 对象引用）
              entry.config.tos_ack = args.tos_ack;
              audit(action, callerId, args.reason, {
                name: args.name,
                tos_ack: args.tos_ack,
              });
              return ok(action, {
                name: args.name,
                tos_ack: args.tos_ack,
              });
            }

            // ---------- caller-tier cap ----------
            case "caller_cap_set": {
              const err = requireArgs(action, args, ["callerId", "cap"]);
              if (err) return err;
              deps.callerTier.setCap(args.callerId!, args.cap!);
              audit(action, callerId, args.reason, {
                target_caller: args.callerId,
                cap: args.cap,
              });
              return ok(action, {
                callerId: args.callerId,
                cap: args.cap,
              });
            }

            default: {
              // 类型穷尽性守护（zod enum 已过滤，但 TS narrowing 兜底）
              const _exhaustive: never = action;
              return fail(String(_exhaustive), "unreachable");
            }
          }
        } catch (e) {
          // 任何未捕获异常 → 结构化错误返（不抛给 SDK）
          logger.error({
            evt: "admin_handler_error",
            action,
            error: String(e),
          });
          return fail(action, `unexpected error: ${String(e)}`);
        }
      },
    },
  );
}

// ============================================================
// helpers（模块私有）
// ============================================================

/**
 * 标准成功响应形状：{ ok: true, action, ...payload, timestamp }
 */
function ok(
  action: string,
  payload: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { ok: true, action, ...payload, timestamp: Date.now() },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * 标准失败响应形状：{ ok: false, action, error, timestamp }
 *
 * 不抛异常给 SDK，让 CC 收到结构化错误（admin 失败是预期场景，非 crash）。
 */
function fail(
  action: string,
  error: string,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { ok: false, action, error, timestamp: Date.now() },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * mutation action 字段必填校验（schema 层 optional，handler 层强制）。
 *
 * parse7 §3.5：capability_disable / provider_remove 必须传 reason（强制思考，R-RT-8）。
 *
 * @returns 失败响应（直接返给 SDK）；成功返 null
 */
function requireArgs(
  action: string,
  args: { name?: string; reason?: string; callerId?: string; cap?: number; tos_ack?: boolean },
  required: Array<"name" | "reason" | "callerId" | "cap" | "tos_ack">,
): { content: Array<{ type: "text"; text: string }> } | null {
  for (const f of required) {
    if (args[f] === undefined || args[f] === null || args[f] === "") {
      return fail(action, `field required: ${f}`);
    }
  }
  return null;
}

/**
 * 从 admin input 构造安全的 ProviderConfig（INV-10 衍生：keys 从 env 读，不接受 body）。
 *
 * parse7 §3.5 红线：
 *  - 调用方传 config.keys 即使存在也忽略 + 强制从 process.env.<NAME>_API_KEYS 读
 *  - env keys 解析为 string[]（CSV split + trim + filter）
 *
 * @returns {config, keys_from_env} 或 {error}
 */
function buildProviderConfig(
  input: Record<string, unknown>,
  action: string,
):
  | { config: ProviderConfig; keys_from_env: boolean }
  | { error: string } {
  const name = input.name as string | undefined;
  if (!name) {
    return { error: `${action}: config.name required` };
  }

  // INV-10 衍生：强制从 env 读 keys（不接受 body 字面量）
  const envKey =
    process.env[`${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEYS`] ??
    process.env[`${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`] ??
    "";
  const keys = envKey
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const config: ProviderConfig = {
    name,
    type: (input.type as ProviderConfig["type"]) ?? "api_key",
    endpoint_url: (input.endpoint_url as string | null | undefined) ?? null,
    keys,
    free_quota_per_month:
      (input.free_quota_per_month as number | undefined) ?? 0,
    quota_model:
      (input.quota_model as ProviderConfig["quota_model"] | undefined) ??
      "monthly",
    fallback_order: (input.fallback_order as number | undefined) ?? 100,
    tags: (input.tags as string[] | undefined) ?? ["search"],
    enabled: (input.enabled as boolean | undefined) ?? true,
    policy_risk:
      (input.policy_risk as ProviderConfig["policy_risk"] | undefined) ??
      "safe",
    tos_url: input.tos_url as string | undefined,
    tos_ack: input.tos_ack as boolean | undefined,
  };

  return { config, keys_from_env: keys.length > 0 };
}

/**
 * 写 audit log（parse7 §3.5）。
 *
 * 复用 logger.info（v0.3.5 desktop audit log 范式 —— 实际是 logger，非独立 audit.log 文件；
 * parse7 §3.5 「10MB 轮转」由 logger 的轮转配置管，v0.6 不另造 audit 子系统）。
 */
function audit(
  action: string,
  callerId: string,
  reason: string | undefined,
  payload: Record<string, unknown>,
): void {
  logger.info({
    evt: "admin_audit",
    action,
    callerId,
    reason,
    ...payload,
    ts: Date.now(),
  });
}
