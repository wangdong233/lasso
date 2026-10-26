/**
 * login_bridge tool 注册（v1.31，doc/方案-login_bridge-登录接力-v1-2026-10-17.md）
 *
 * 形态：单工具 `login_bridge(action: start|status|stop[, wipe])` action-enum 折叠
 * （download/admin 正典，INV-17 家族）；独立工具族，无 channel/fallback（INV-23）。
 *
 * 用户流程契约（方案 §〇）：agent 遇登录墙 → start → 把返回的 url+指引交给用户 →
 * 用户浏览器打开亲手登录（DevTools screencast 投屏）→ 轮询 status 看 cookieDelta
 * → 登录态已落 → browse_logged_in + LASSO_CDP_PORT=<cdpPort> attach 续跑 →
 * stop（可选 wipe 清登录资产）。
 *
 * 诚实信号面（description 与本文件同源）：
 *  - cookieDelta 是启发式事实（非登录判定）；agent 终判
 *  - CJK 输入/密码管理器在投屏内不可用（DevTools screencast 结构性死穴）
 *  - Google 系登录对 headless 不稳（调研 §三）+ 云 IP 信誉风险自担
 *  - relay 无鉴权：绑定接口内任意进程可全控该 Chrome（tailnet 私有性=唯一防线）
 *  - 登录 profile 的 cookie 明文落盘（云 Linux 无 keyring；stop wipe=关闭即删）
 *
 * 四处联动（download 范式）：本注册器 + index.ts 注册调用 + V5_TOOL_TO_CHANNEL +
 * descriptions.ts。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InteractResult } from "../types.js";
import { LOGIN_BRIDGE_DESCRIPTION } from "./descriptions.js";
import { loginBridgeAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";
import { CdpClient, type CdpCookie } from "../logged-in/CdpClient.js";
import {
  loginCdpPort,
  loginRelayPort,
  loginRelayIdleMs,
  loginProfileNs,
  LOGIN_PROFILE_PREFIX,
} from "../login-bridge/login-flags.js";
import { resolveBridgeHost } from "../login-bridge/host.js";
import { mergedEnv } from "../config/config.js";
import { parseExtraArgsEnvValue } from "../launcher/launch-chrome.js";
import { createLoginRelay, type LoginRelayHandle } from "../login-bridge/relay.js";
import { ensureLoginChrome } from "../login-bridge/launcher.js";
import { snapshotCookieKeys, cookieDelta, type CookieDelta } from "../login-bridge/detect.js";
import { touchChromePort } from "../launcher/chrome-touch.js";
import { stopLaunchedChromes } from "../launcher/chrome-stop.js";

// ============================================================
// 依赖注入（未接线=诚实 didnt——download 范式）
// ============================================================
export interface LoginBridgeDeps {
  ensureChrome: typeof ensureLoginChrome;
  createRelay: typeof createLoginRelay;
  resolveHost: typeof resolveBridgeHost;
  /** CDP cookie 读取（默认经 CdpClient；测试注入桩）。 */
  getCookies: (cdpPort: number) => Promise<CdpCookie[]>;
  touch: (port: number) => Promise<void>;
  stopChromes: (opts: { port: number }) => Promise<unknown>;
  /** profile 删除（wipe 用；默认 rmSync 带归属守卫）。 */
  removeProfile: (profileDir: string, ns: string) => void;
}

let deps: LoginBridgeDeps | null = null;

export function wireLoginBridgeTools(d: LoginBridgeDeps): void {
  deps = d;
}

function defaultDeps(): LoginBridgeDeps {
  return {
    ensureChrome: ensureLoginChrome,
    createRelay: createLoginRelay,
    resolveHost: resolveBridgeHost,
    getCookies: async (cdpPort: number) => {
      const cdp = new CdpClient(cdpPort);
      try {
        return await cdp.getAllCookies();
      } finally {
        await cdp.close();
      }
    },
    touch: touchChromePort,
    stopChromes: stopLaunchedChromes,
    removeProfile: (profileDir: string, ns: string) => {
      // 归属守卫（chrome-stop cleanupRenderProfile 范式）：父目录名=LOGIN_PROFILE_PREFIX
      // 且叶子=ns（loginProfileNs 已禁分隔符/..）——三重验证后才 rm
      const parent = path.basename(path.dirname(profileDir));
      const leaf = path.basename(profileDir);
      if (parent !== LOGIN_PROFILE_PREFIX || leaf !== ns || /[/\\]/.test(ns)) {
        logger.warn({ evt: "login_wipe_refused_guard", profileDir });
        return;
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

// ============================================================
// 桥状态（进程内单例；relay 自关时清空）
// ============================================================
interface BridgeState {
  ns: string;
  cdpPort: number;
  relayPort: number;
  host: string;
  url: string;
  profileDir: string;
  wsEndpoint: string;
  startedAt: number;
  baseline: Set<string>;
  relay: LoginRelayHandle;
}

let state: BridgeState | null = null;

function envelope<T>(outcome: "worked" | "didnt", data: T | null, note?: string): InteractResult<T> {
  return {
    outcome,
    data,
    served_by: "login_bridge",
    fallback_used: false,
    retrieval_method: note ? `login_bridge:${note}` : "login_bridge",
  };
}

const GUIDANCE_STEPS = [
  "1) 浏览器打开 url（Chrome/Edge 最佳）——这是远端 Chrome 的调试面板",
  "2) 在页面列表点击目标页（about:blank 可先navigate到登录页再回来）",
  "3) 在 DevTools 里点设备工具栏（Toggle device toolbar）开启 screencast 投屏",
  "4) 在投屏里亲手登录；完成后再回来调 status 看 cookieDelta",
].join("；");

const GUIDANCE_CAVEATS =
  "投屏内不可用：中文输入法/本机密码管理器（手输 ASCII 密码）；Google 系登录对 headless 不稳（云 IP 信誉风险自担）；relay 无鉴权——绑定接口内任意进程可全控该 Chrome（tailnet 私有性=唯一防线，建议 Tailscale ACL）；登录 cookie 明文落盘于 Linux profile（stop wipe=关闭即删）。";

// ============================================================
// 注册
// ============================================================
// ============================================================
// schema（导出——tool-examples-truth 闸 1d 消费；与注册处同一对象）
// ============================================================
export const loginBridgeSchema = {
  action: z.enum(["start", "status", "stop"]).describe("start=拉起登录档 Chrome+relay 并返回 URL；status=查 cookieDelta/健康；stop=关 relay（wipe=true 连 Chrome 与登录资产一并清）"),
  wipe: z.boolean().optional().describe("stop 时一并删除持久 profile（登录资产关闭即删）"),
};

export function registerLoginBridgeTools(server: McpServer): void {
  server.tool(
    "login_bridge",
    LOGIN_BRIDGE_DESCRIPTION,
    loginBridgeSchema,
    loginBridgeAnnotations,
    async (args: { action: "start" | "status" | "stop"; wipe?: boolean }) => {
      const d = deps ?? defaultDeps();
      const result = await handle(args, d);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}

/** 测试出口（闸 1d/工具行为测共用；生产路径唯一入口仍是 MCP tool handler）。 */
export async function handleLoginBridgeAction(
  args: { action: "start" | "status" | "stop"; wipe?: boolean },
  depsOverride?: LoginBridgeDeps,
): Promise<InteractResult<Record<string, unknown>>> {
  return handle(args, depsOverride ?? deps ?? defaultDeps());
}

async function handle(
  args: { action: "start" | "status" | "stop"; wipe?: boolean },
  d: LoginBridgeDeps,
): Promise<InteractResult<Record<string, unknown>>> {

  // ---- start ----
  if (args.action === "start") {
    if (state) {
      return envelope("worked", {
        reused: true,
        url: state.url,
        cdpPort: state.cdpPort,
        relayPort: state.relayPort,
        host: state.host,
        ns: state.ns,
        wsEndpoint: state.wsEndpoint,
        guidance: GUIDANCE_STEPS,
        caveats: GUIDANCE_CAVEATS,
      }, "already_active");
    }
    const cdpPort = loginCdpPort();
    const relayPort = loginRelayPort();
    const ns = loginProfileNs();
    // P31 移交2：resolveBridgeHost 异步化（host.ts）——await（B3 核验 :204 的
    // mergedEnv() 白盒锚不受本行影响）
    const hostRes = await d.resolveHost({ relayPort });
    if (!hostRes) {
      return envelope("didnt", {
        error:
          "login_bridge_host_not_found:no tailscale/private interface IP detected — set LASSO_LOGIN_BRIDGE_HOST explicitly (e.g. your LAN/tailnet IP)",
      });
    }
    // R1：跨档单键（与日常档 launch-chrome CLI 同键同源——mergedEnv file→env 合并；
    // EXTRA_ARGS 空白拆分：window-size 类含逗号参数保真）
    const launchEnv = mergedEnv();
    const launchExtra = parseExtraArgsEnvValue(launchEnv.LASSO_LAUNCH_EXTRA_ARGS);
    const chrome = await d.ensureChrome({
      port: cdpPort,
      ns,
      allowOrigins: hostRes.allowOrigins,
      ...(launchEnv.LASSO_LAUNCH_LOCALE ? { locale: launchEnv.LASSO_LAUNCH_LOCALE } : {}),
      ...(launchExtra.length > 0 ? { extraArgs: launchExtra } : {}),
    });
    if (!chrome.ok) {
      return envelope("didnt", { error: chrome.error });
    }
    let relay: LoginRelayHandle;
    try {
      relay = await d.createRelay({
        host: hostRes.host,
        port: relayPort,
        cdpPort,
        idleMs: loginRelayIdleMs(),
        onIdleClose: () => {
          state = null;
          logger.info({ evt: "login_relay_idle_closed", relayPort });
        },
      });
    } catch (e) {
      return envelope("didnt", { error: (e as { message?: string }).message ?? String(e) });
    }
    // 基线快照（Chrome 刚拉起/复用时已有 cookie=基线，增量才是信号）
    let baseline = new Set<string>();
    try {
      baseline = snapshotCookieKeys(await d.getCookies(cdpPort));
    } catch (e) {
      logger.warn({ evt: "login_baseline_failed", error: String(e) });
    }
    state = {
      ns,
      cdpPort,
      relayPort,
      host: hostRes.host,
      url: `http://${hostRes.host}:${relayPort}/`,
      profileDir: chrome.profileDir,
      wsEndpoint: chrome.wsEndpoint,
      startedAt: Date.now(),
      baseline,
      relay,
    };
    logger.info({ evt: "login_bridge_started", cdpPort, relayPort, host: hostRes.host, source: hostRes.source, reused: chrome.reused });
    return envelope("worked", {
      reused: chrome.reused,
      url: state.url,
      cdpPort,
      relayPort,
      host: state.host,
      hostSource: hostRes.source,
      ns,
      wsEndpoint: chrome.wsEndpoint,
      attachHint: `browse_logged_in via LASSO_CDP_PORT=${cdpPort}（热生效）`,
      guidance: GUIDANCE_STEPS,
      caveats: GUIDANCE_CAVEATS,
    });
  }

  // ---- status ----
  if (args.action === "status") {
    if (!state) {
      return envelope("didnt", { error: "login_bridge_not_started:call action=start first" });
    }
    const relayState = state.relay.state();
    let delta: CookieDelta = { domains: {}, totalNew: 0 };
    let chromeHealthy = false;
    try {
      const cookies = await d.getCookies(state.cdpPort);
      delta = cookieDelta(state.baseline, cookies);
      chromeHealthy = true;
    } catch {
      chromeHealthy = false;
    }
    // status 轮询=touch 唯一源（方案 §二 C1 spec 显式）
    await d.touch(state.cdpPort);
    return envelope("worked", {
      url: state.url,
      cdpPort: state.cdpPort,
      ns: state.ns,
      relay: relayState,
      chromeHealthy,
      cookieDelta: delta,
      note: "cookieDelta 是启发式事实（按域新增非噪声 cookie 计数），非登录判定——agent 结合目标站登录标志终判",
    });
  }

  // ---- stop ----
  if (!state) {
    return envelope("didnt", { error: "login_bridge_not_started:nothing to stop" });
  }
  const snapshot = state;
  await snapshot.relay.stop();
  state = null;
  let wiped = false;
  if (args.wipe === true) {
    await d.stopChromes({ port: snapshot.cdpPort });
    d.removeProfile(snapshot.profileDir, snapshot.ns);
    wiped = true;
  }
  logger.info({ evt: "login_bridge_stopped", cdpPort: snapshot.cdpPort, wiped });
  return envelope("worked", {
    stopped: true,
    cdpPort: snapshot.cdpPort,
    wiped,
    note: wiped
      ? "Chrome 已停+持久 profile 已删（登录资产清零）"
      : "relay 已关；Chrome 留守台账常规回收（登录态保留，下次 start 复用）",
  });
}
