/**
 * browse tools 注册（parse1 §3.12 + §4.3 SSRF + §4.4 fallback）
 *
 * 注册两个 tool：browse_headless / browse_logged_in。
 *
 *  - browse_headless:
 *      SSRF guard → fallback 链默认 [browse_headless]（terminal；C3，
 *      doc/bugs/09 决议 C3：headless→logged_in 跨通道边默认移除——登录态
 *      通道须用户显式选择；LASSO_FALLBACK_CROSS_CHANNEL=1 可恢复旧行为）
 *
 *  - browse_logged_in:
 *      SSRF guard → 终端通道（无下一跳；2FA 检测命中时 outcome=didnt
 *      + NEEDS_MANUAL_2FA，由 isFallbackWorthy 判定为"不 fallback"）
 *
 * 注意：SSRF 检查只在 tool 入口做（不进 channel）—— 因为 channel 内部的
 * navigate_page 是 chrome-devtools-mcp 调用，URL 透传到 Chrome 的导航；
 * SSRF 在 Lasso 这一层拦截，绝不让 chrome-devtools-mcp 看到私网 URL。
 *
 * 借鉴：parse1 §3.12 registerBrowseTools；附录 B BROWSE_*_DESCRIPTION；
 * mcp-chrome 浏览器层 SSRF 实践。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowseOptions, BrowseResult, InteractResult } from "../types.js";
import type { HeadlessChannel } from "../channels/HeadlessChannel.js";
import type { LoggedInChannel } from "../channels/LoggedInChannel.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import type { CallerTierTracker } from "../runtime/CallerTierTracker.js";
import {
  callerIdFromMeta,
  callerCapExceededResult,
} from "../runtime/CallerTierTracker.js";
import { ssrfGuard, ssrfDenial, type SsrfConfig } from "../ssrf/ssrf-guard.js";
// BUG-05 决议 B（doc/bugs/05 §4）：file:// 旁路白名单（LASSO_ALLOW_FILE_FROM，
// 默认关）。只在此入口路由——ssrfGuard 本体零改动（INV-90 红线）。
import {
  checkFileUrl,
  isFileProtocol,
  fileGuardHint,
} from "../ssrf/file-guard.js";
import {
  BROWSE_HEADLESS_DESCRIPTION,
  BROWSE_LOGGED_IN_DESCRIPTION,
} from "./descriptions.js";
// doc/usage/04 决议 D（2026-09-16）：L2 schema describe 的作用域枚举一律从
// BrowseChannel 运行时真源派生（合法 action 表 / 消费表 / 白名单），禁手写
// 字符串——真源增删，describe 自动同步（drift-free by construction）。
import {
  BROWSE_ACTIONS,
  CONSUMED_OPTIONS,
  CURRENT_PAGE_ACTIONS,
  ENTRY_CONSUMED_OPTION_KEYS,
} from "../channels/BrowseChannel.js";
import {
  browseHeadlessAnnotations,
  browseLoggedInAnnotations,
} from "./annotations.js";

// ============================================================
// L2 describe 派生层（doc/usage/04 决议 D.1/D.2，单一真源拼装）
// ============================================================
/** 反查：消费某 option 键的 action 集（CONSUMED_OPTIONS 单一真源）。 */
const actionsConsuming = (key: string): string[] =>
  Object.entries(CONSUMED_OPTIONS)
    .filter(([, keys]) => keys.includes(key))
    .map(([a]) => a);

/** D.2：合法 action 表 + url 可省略族（第二句是杀 url_required 猜错环的最高价值一行）。 */
const BROWSE_ACTION_DESCRIBE = `one of: ${BROWSE_ACTIONS.join(" | ")}. url-optional (current-page) actions: ${[...CURRENT_PAGE_ACTIONS].join(" | ")}`;

/** D.3：url 三态语义（省略=current-page / 在场=ensure-navigation）。 */
const BROWSE_URL_DESCRIBE = `omit + ${[...CURRENT_PAGE_ACTIONS].join("/")} = act on the current page (active session required); present = ensure-navigation (navigates only if different; echoes data.did_navigate)`;

/** D.4：js 三形态如实（house 惯例先行——与 BROWSE_HEADLESS 描述同一断言双层锚）。 */
const JS_DESCRIBE =
  "THREE forms all work: function expression () => document.title (passed through); IIFE (async () => {...})() (wrapped, its result returned); statement body return document.title (wrapped and invoked)";

/** D.5：freshProfile（入口级消费键，从 ENTRY_CONSUMED_OPTION_KEYS 拼作用域）。 */
const FRESH_PROFILE_DESCRIBE = `entry-level option (${[...ENTRY_CONSUMED_OPTION_KEYS].join(" | ")} — consumed at browse() entry before dispatch, all actions on supporting channels); headless-only: browse_logged_in rejects it (your real Chrome identity is never rotated)`;

/** D.5：no_reload（作用域从 CONSUMED_OPTIONS 反查拼出）。
 * bug11 决议 D-2（doc/bugs/11，2026-09-17）：补「不是跳过导航旗标」语义澄清句
 * ——下午实机报告 P3「no_reload:true 仍 did_navigate:true」实测误会：该形态是
 * 行为正确（实质不同 URL 恒导航——no_reload 只作用于 hash-only same-document
 * 的补 reload）；同 URL（规范化含 hash）恒零导航是规则 2，与本键无关。顺带去
 * 句内重复（"on hash-only targets" 与前半 hash-only 范围语同义——预算工序
 * §5.1：mandated +133 − 句内去重 20）。 */
const NO_RELOAD_DESCRIBE = `hash-only same-document opt-out (default = reload; this is NOT a skip-navigation flag — navigation still happens whenever the url differs; identical-URL targets never navigate at all); consumed by: ${actionsConsuming("no_reload").join(" | ")}; no-navigation calls echo it in data.ignored_options`;

/** D.5：budget_ms 双语义（steps 链预算 + 单 action evaluate 的 MCP 超时——
 * 作用域从 CONSUMED_OPTIONS 反查拼出；r1 修正：禁「仅 steps 链」谎言）。 */
const BUDGET_MS_DESCRIBE = `steps-chain time budget AND single-action MCP timeout for: ${actionsConsuming("budget_ms").join(" | ")} (default 120s, env LASSO_EVAL_TIMEOUT_MS, zod cap 600s); other single actions echo it in data.ignored_options`;

/** E14（BUG-05 决议 A3）：screenshot.filePath 作用域（L2 半行）。 */
const SCREENSHOT_FILEPATH_DESCRIBE = `output path for the PNG; the screenshot sub-object is consumed only by: ${actionsConsuming("screenshot").join(" | ")} — other actions echo it in data.ignored_options`;

/** selectors 作用域（uid 映射）。 */
const SELECTORS_DESCRIBE = `uid map from a prior snapshot, e.g. {click:"<uid>"}; consumed by: ${actionsConsuming("selectors").join(" | ")}`;

// expect 四条件共享字段（原 options.expect 与 steps[].expect 两处内联重复的同
// 形状抽出——R-CI-02 同一 schema 单一真源；describe 的条件枚举从本对象派生）。
const expectConditionFields = {
  text: z.string().optional(),
  selector: z.string().optional(),
  url_contains: z.string().optional(),
  gone: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
};

/** D.5：expect 四条件 + timeout_ms（条件键从共享字段对象派生）。 */
const EXPECT_DESCRIBE = `at least one of ${Object.keys(expectConditionFields)
  .filter((k) => k !== "timeout_ms")
  .join(" / ")} (+ timeout_ms); action=wait + step postconditions`;

/** steps 链语义（入口分流——非空即取代单 action 路径）。 */
const STEPS_DESCRIBE =
  "multi-step chain (replaces the single action when non-empty; semantics as in the tool description)";

// ============================================================
// Schema
// ============================================================
// W2（doc/bugs/09）：export 供 tools/headed.ts 复用（browse_headed 与
// browse_headless 同 action surface——R-CI-02 同一 schema 单一真源，禁复制漂移）。
export const browseSchema = {
  // BUG-07 决议 A⁺（doc/bugs/07 §5.2①）：url 可选化——省略 + action=screenshot
  // = current-page 模式（对当前受管页面直接截屏，零导航）；省略 + 其它任何
  // action = 显式拒 url_required_for_action:<action>（channel browse() 门）。
  // BUG-08 决议 D-3：白名单 += wait；决议 B（doc/bugs/09）：+= evaluate
  //（「导航完立即对当前页跑 JS」SPA 驱动主形态；descriptions 早已承诺）。
  // 禁 .default()（absent 必须=undefined，不得注入 ""——extract_mode 同款纪律，
  // 守 byte-identical 断言）。有 url = 决议 B 统一 ensure-navigation 语义
  //（≠当前页先导航 → did_navigate:true；=当前页零导航直执行 → did_navigate:
  // false——NAV_FIRST 时代的无条件 reload 消灭）。
  url: z.string().url().optional().describe(BROWSE_URL_DESCRIBE),
  action: z.string().default("snapshot").describe(BROWSE_ACTION_DESCRIBE),
  options: z
    .object({
      selectors: z.record(z.string()).optional().describe(SELECTORS_DESCRIBE),
      js: z.string().optional().describe(JS_DESCRIBE),
      // review-r2：wait_until / screenshot.element / timeout_ms 已从 schema 删除——
      // 三者自 v0.1 起「schema 接受 → channel 零消费」（doNavigate 只读 no_cache、
      // doScreenshot 只读 screenshot.full；grep waitUntil 全 src=0），调用方传
      // wait_until=networkidle 期望等待语义会静默无效（review-r1 F3 同类死角）。
      // 未来接入时须连同 doNavigate 的 navigate_page 映射一起实装后再回 schema。
      screenshot: z
        .object({
          full: z.boolean().optional(),
          // E②（BUG-03 决议 E②）：指定截图落盘路径（上游 1.7.0 take_screenshot
          // filePath 直写；缺省 /tmp/lasso-screenshot-<uuid>.png；上游未兑现回退
          // image-block 路径——两路径同校验）。schema 与 doScreenshot 消费面同 commit。
          // BUG-05 决议 A3（doc/bugs/05 §3）作用域标注：本字段**仅 action=screenshot
          // 消费**（doScreenshot；该 action NAV_FIRST 先导航后截屏 = 一步导航+截图）；
          // navigate 等其余 action 传入零消费 → 响应 data.ignored_options 诚实标注
          //（消费表单一真源 = BrowseChannel CONSUMED_OPTIONS，INV-91）。
          // doc/usage/04 E14：作用域半行走 L2 describe（派生自消费表）。
          // 注：链式保持单行——e2-screenshot-dual-path spec 7 的源锚正则匹配
          // `filePath: z.string().min(1).optional()` 单行形态。
          filePath: z.string().min(1).optional().describe(SCREENSHOT_FILEPATH_DESCRIBE),
        })
        .optional(),
      no_cache: z.boolean().optional(),
      // BUG-08 决议 D-1（doc/bugs/08，2026-09-15）：navigate 的 same-document
      //（hash-only）形态 opt-out——true = 检测命中也只标注（same_document_
      // navigated:true + same_document_reloaded:false）不补 reload。缺省
      //（false/不填）= hash-only 导航默认 reload（数据正确性优先——SPA 状态
      // 残留假数据根治）。仅 action=navigate 消费。
      no_reload: z.boolean().optional().describe(NO_RELOAD_DESCRIBE),
      // BUG-08 决议 C（doc/bugs/08，2026-09-15）：反爬逃生门——本次调用前换完整
      // 新一致身份（新临时 profile + stealth 宿主适用集确定性轮换 + 完整栈
      // respawn）。仅 browse_headless 生效（logged_in 传入即拒 didnt + 专用错误
      // 码——用户真实 Chrome 红线）。身份服务后续调用直至 idle 回收/下次换脸/
      // server 退出。缺省 false/缺省不填 = 现状字节级不变。
      freshProfile: z.boolean().optional().describe(FRESH_PROFILE_DESCRIBE),
      // v1.18.2（doc/governance/10 F3+Y1）+ BUG-08 决议 A-2：双语义时间预算（ms）——
      // steps 链 = 整链预算（缺省 120s，钳制上限 600s；慢站/长 SPA/多步表单等
      // 合法长链显式放宽，预算耗尽终止语义=unknown 可重试）；单 action evaluate
      // = 本次调用的 MCP 超时（budget_ms ?? LASSO_EVAL_TIMEOUT_MS ?? 120s，
      // BrowseChannel.doEvaluate 传导 callTool）。其余单 action 传入 →
      // data.ignored_options 诚实回显（消费表单一真源，CONSUMED_OPTIONS.evaluate）。
      //（doc/usage/04 决议 D.1 r1：本注释原只写「steps 链预算」——过时注释正是
      // D.5 初稿事实错误的衍生源，随 L2 describe 一并修正。）
      budget_ms: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe(BUDGET_MS_DESCRIBE),
      // v1.8 Phase D（D2）：steps 多步链入参。BrowseChannel v0.3 起已实装 steps 分流
      // （browse() 入口 options.steps 非空 → StepEngine.runChain），但 MCP schema 缺此键
      // → zod strip → U-03 多步链经 MCP 不可达。形状对照 src/browse/steps-types.ts Step。
      steps: z
        .array(
          z.object({
            action: z.string().describe(BROWSE_ACTION_DESCRIBE),
            selectors: z.record(z.string()).optional(),
            js: z.string().optional(),
            expect: z.object(expectConditionFields).optional(),
            timeout_ms: z.number().int().positive().optional(),
            label: z.string().optional(),
          }),
        )
        .optional()
        .describe(STEPS_DESCRIBE),
      // v1.1（parse12 §1.3 + §3.3.1）：extract action 的 markdown 抽取模式。
      // .optional() 无 default（防 zod 自动注入致 raw byte-identical 断言失真）。
      // 仅 action="extract" 读此字段；snapshot/navigate/screenshot 等忽略。
      extract_mode: z.enum(["raw", "markdown", "markdown_cited"]).optional(),
      // v1.17 Phase F（parse24 §6.2 C2）：extract 的交互句柄 opt-in（缺省关 =
      // byte-identical，INV-66 手法）。markdown* 档注入 data-lasso-uid ref +
      // 附录；raw 档运行时忽略 + ignored_include_refs:true 标注（冲突 #8）。
      include_refs: z.boolean().optional(),
      // action=wait 消费（doWait 读 expect——决议 C1 三键统一：text/selector/
      // url_contains 至少一项，与 ExpectPoll.validateCondition 同一契约；
      // selector/url_contains/gone 走 100ms evaluate 轮询，text-only 走上游
      // wait_for）；其余 action 忽略。steps 内的 expect 是 step 自有字段
      //（StepEngine 三态消费）。
      expect: z.object(expectConditionFields).optional().describe(EXPECT_DESCRIBE),
      // ============================================================
      // D2（BUG-05 决议 D，doc/bugs/05 §6）：schema 反向补全——types.ts
      // BrowseOptions 已有且 channel 真消费、但 schema 未声明（MCP 入参被 zod
      // strip → action 经 MCP 不可参数化，U-03「schema 缺键致不可达」同族、
      // 方向相反）。全部 .optional() 无 .default()（extract_mode 同款纪律：
      // 防 zod 自动注入破坏 byte-identical 断言）。
      // 🔴 network_timeout_ms / network_include_bodies 不进 schema（决议 r1）：
      // v1.11 起二者「字段保留（进程内契约稳定），值被忽略」（cdp-actions.ts
      // 注释明载）——MCP 面不宣传死参数（v1.18.7 删死参数同纪律）；未声明键经
      // MCP 边界即被 zod strip = 标准边界行为，非静默失效。
      // ============================================================
      network_filter: z
        .enum(["xhr", "fetch", "img", "3rd-party", "all"])
        .optional(),
      // 决议 C（§5）：console action 参数化（severity 阈值 + 最近 N 条）
      console_level: z.enum(["error", "warn", "info", "debug"]).optional(),
      console_limit: z.number().int().min(1).max(500).optional(),
      // doPdf 消费（cdp-actions.ts；上游 1.7.0 无 pdf 工具 → action=pdf 恒
      // upstream_unsupported——参数面照实声明供未来上游升级，描述不宣传）
      pdf_format: z.enum(["A4", "Letter", "Legal", "Tabloid"]).optional(),
      pdf_landscape: z.boolean().optional(),
      pdf_print_background: z.boolean().optional(),
      pdf_margin_top: z.number().optional(),
      pdf_margin_bottom: z.number().optional(),
      pdf_margin_left: z.number().optional(),
      pdf_margin_right: z.number().optional(),
    })
    .default({}),
};

// ============================================================
// 工具
// ============================================================
function ssrfBlocked(reason: string, hint?: string) {
  // v1.18.2（doc/governance/10 F1）：reason 二分——策略确定性拒 → didnt（不可重试）；
  // DNS 环境瞬态（dns_failed/dns_empty，TUN 断网/DNS 抖动）→ unknown（可重试）。
  // BUG-05 决议 B3：file: 族拒绝附加可选 hint（opt-in 指引）；error 字符串
  // 字节不变（hint 是 InteractResult additive 字段，缺省不填=byte-identical）。
  const d = ssrfDenial(reason);
  const payload: InteractResult<never> = {
    outcome: d.outcome,
    data: null,
    served_by: "lasso.ssr_guard",
    fallback_used: false,
    retrieval_method: d.retrieval_method,
    error: d.error,
    ...(hint ? { hint } : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * BUG-05 决议 B（doc/bugs/05 §4）：工具入口守卫路由。
 * file: → checkFileUrl（目录白名单旁路，默认空白名单=拒且 reason 与旧
 * ssrfGuard 输出逐字节相等）；非 file: → ssrfGuard 原样（本体零改动）。
 * 全部 file: 族 reason 走 ssrfDenial → policy 确定性（didnt）——已核
 * isSsrfEnvTransientReason 对它们恒 false。
 */
async function guardEntryUrl(
  url: string,
  cfg: SsrfConfig,
): Promise<{ result: ReturnType<typeof checkFileUrl> | Awaited<ReturnType<typeof ssrfGuard>>; fileAllow: string[] }> {
  const fileAllow = cfg.fileAllowFrom ?? [];
  if (isFileProtocol(url)) {
    return { result: checkFileUrl(url, fileAllow), fileAllow };
  }
  return { result: await ssrfGuard(url, cfg), fileAllow };
}

function browseResultContent(result: InteractResult<BrowseResult>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

/**
 * v1.8 Phase E（W1-DEF-10）：caller-tier 事前 gate。
 * 未注入 callerTier → 放行（零回归）；超额 → tri-state didnt +
 * retrieval_method="caller_cap_exceeded"（与 search.ts 同范式，parse7 §3.3）。
 * 返回 null 表示放行（调用方继续主路径）。
 */
function callerTierGate(
  callerTier: CallerTierTracker | null | undefined,
  meta: unknown,
): ReturnType<typeof browseResultContent> | null {
  if (!callerTier) return null;
  const callerId = callerIdFromMeta(meta);
  if (callerTier.tryAcquire(callerId)) return null;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          callerCapExceededResult(
            callerId,
            callerTier.currentUsage(callerId),
            callerTier.currentCap(callerId),
          ),
          null,
          2,
        ),
      },
    ],
  };
}

// ============================================================
// 注册器
// ============================================================
/**
 * @param server    MCP server
 * @param headless  HeadlessChannel（chrome-devtools-mcp --headless --isolated）
 * @param logged_in LoggedInChannel（chrome-devtools-mcp --browser-url :9222）
 * @param decider   单一 fallback 引擎
 * @param ssrfConfig  SSRF allowRanges / denyRanges（从 env 加载）
 * @param callerTier
 *        v1.8 Phase E（W1-DEF-10）：CallerTierTracker per-caller 滑动窗配额。
 *        未注入 / null / undefined → 无事前 gate（零回归，byte-identical v1.7）。
 *        注入          → 两个 handler 入口 tryAcquire（callerId 取 request
 *                       _meta.callerId，CC 不传则 "anonymous"）；超额 → tri-state
 *                       didnt + retrieval_method="caller_cap_exceeded" 透明返回。
 * @param crossChannelFallback
 *        C3（doc/bugs/09 决议 C3，2026-09-16）：browse_headless→browse_logged_in
 *        跨通道 fallback 逃生门。**默认（false/未传）边已移除**——登录态通道
 *        须用户显式选择（INV-23 精神扩展）+ 无 9222 环境必死加时 + fallback
 *        污染旧账（D-ε：headless evaluate 超时被 logged_in 连接错误串染）。
 *        LASSO_FALLBACK_CROSS_CHANNEL=1 可恢复 v1.26.0 行为（index.ts 装配层
 *        传 config.crossChannelFallback）。
 */
export function registerBrowseTools(
  server: McpServer,
  headless: HeadlessChannel,
  logged_in: LoggedInChannel,
  decider: FallbackDecider,
  ssrfConfig: SsrfConfig,
  callerTier?: CallerTierTracker | null,
  crossChannelFallback: boolean = false,
): void {
  // ----- browse_headless -----
  server.tool(
    "browse_headless",
    BROWSE_HEADLESS_DESCRIPTION,
    browseSchema,
    browseHeadlessAnnotations,
    async (args, extra) => {
      const url: string | undefined = args.url;
      const action: string = args.action;
      const options: BrowseOptions = args.options ?? {};

      // caller-tier 事前 gate 在 SSRF guard 之前（parse7 §3.3「handler 入口」）
      const denied = callerTierGate(callerTier, extra?._meta);
      if (denied) return denied;

      // BUG-07 决议 A⁺（§5.4）：url 省略（current-page 请求）——
      //  ① SSRF 整体跳过（无导航目标可守，空集守卫=形式主义）；url 存在则
      //     BUG-05 决议 B 入口守卫路由原样照跑（file: 白名单旁路 + ssrfGuard）。
      //  ② fallback 钉通道：fallbacks=[]（仅 primary）。否则 headless 中途
      //     unknown 会 fallback 到 logged_in——静默截**用户 Chrome 当前 tab**
      //     （跨浏览器状态伪造，比失败更糟；INV-23「不跨 surface fallback」
      //     同哲学的通道内收紧）。无会话/越界由 channel 的 didnt 短路（decider
      //     recordSuccess——零熔断污染）。
      if (url !== undefined) {
        const { result: ssrfResult, fileAllow } = await guardEntryUrl(url, ssrfConfig);
        if (!ssrfResult.allowed) {
          return ssrfBlocked(
            ssrfResult.reason,
            fileGuardHint(ssrfResult.reason, fileAllow),
          );
        }
      }

      const plan = {
        primary: "browse_headless",
        // C3（doc/bugs/09 决议 C3）：跨通道边默认移除；url 缺省（current-page）
        // 本就钉通道（BUG-07 A⁺）。逃生门 = LASSO_FALLBACK_CROSS_CHANNEL=1
        //（config.crossChannelFallback，装配层注入——一键恢复 v1.26.0 行为）。
        fallbacks:
          url !== undefined && crossChannelFallback ? ["browse_logged_in"] : [],
        cross_modal: false,
      };

      const result = await decider.runWithFallback(plan, async (name) => {
        if (name === "browse_headless") {
          return headless.browse(url, action, options);
        }
        if (name === "browse_logged_in") {
          return logged_in.browse(url, action, options);
        }
        throw new Error(`unknown_channel:${name}`);
      });

      return browseResultContent(result);
    },
  );

  // ----- browse_logged_in -----
  server.tool(
    "browse_logged_in",
    BROWSE_LOGGED_IN_DESCRIPTION,
    browseSchema,
    browseLoggedInAnnotations,
    async (args, extra) => {
      const url: string | undefined = args.url;
      const action: string = args.action;
      const options: BrowseOptions = args.options ?? {};

      // caller-tier 事前 gate 在 SSRF guard 之前（与 browse_headless 同范式）
      const denied = callerTierGate(callerTier, extra?._meta);
      if (denied) return denied;

      // BUG-05 决议 B：入口守卫路由（file: → 目录白名单旁路；非 file: → ssrfGuard）
      // BUG-07 决议 A⁺（§5.4）：url 省略（current-page 请求）SSRF 整体跳过
      //（无导航目标可守）；本通道终端无 fallback，钉通道天然成立。
      if (url !== undefined) {
        const { result: ssrfResult, fileAllow } = await guardEntryUrl(url, ssrfConfig);
        if (!ssrfResult.allowed) {
          return ssrfBlocked(
            ssrfResult.reason,
            fileGuardHint(ssrfResult.reason, fileAllow),
          );
        }
      }

      // 终端通道：v0.1 不再 fallback（no next hop）。2FA 命中走 outcome=didnt
      // + NEEDS_MANUAL_2FA，调用方据此决定是否中止。
      const result = await logged_in.browse(url, action, options);
      return browseResultContent(result);
    },
  );
}
