#!/usr/bin/env node
/**
 * Lasso 架构不变量检查（parse1 §3.14 + 08 F3.9.8 + parse2 §5.4 v0.2 加 INV-9/10/11
 *                     + parse3 §5.3 v0.3 加 INV-12..15
 *                     + parse4 §1.4 v0.3.5 改写 INV-8 + 加 INV-16..23
 *                     + parse5 §2.3 v0.4 M0.4a 加 INV-24/25/26 forest 调度层 + 政策 gate）
 *                     + parse5 §2.3 v0.4 M0.4b 改写 INV-22 占位 + 加 INV-27/28/29 + 收紧 INV-21 regex）
 *                     + parse5 §2.3 v0.4 M0.4c 加 INV-30 stealth-profiles 顶级 const）
 *                     + parse6 §1.5 v0.5 M0.5a 加 INV-31/32 fetch_url SSRF + 连接池守门）
 *                     + parse6 §1.5 v0.5 M0.5b 加 INV-33/34 pdf/console/network actionDispatch + 二进制 envelope）
 *                     + parse9 §2.2 v0.8 加 INV-48..53 cookie AES-256-GCM 隐私红线）
 *                     + parse10 §1 v0.9 Phase A 加 INV-54..59 search 兜底层增量 + Bing 第三源 + wayback 独立 tool）
 *
 * Phase D 状态：INV-14 收紧到 HighRiskGate 端（HIGH_RISK_PATTERNS 顶级 const）。
 * 至此 v0.3 的 4 条 INV-12..15 全部上线。
 *
 * v0.3.5 Phase C 状态（parse4 §1.4）：
 *  - INV-8 改写为「fallback 链不跨 surface」语义（旧「禁止 DesktopChannel 类存在」作废）
 *  - 新增 INV-16..23（F3.9.9 (a)-(h) 可执行断言形式）
 *
 * v0.4 M0.4a 状态（parse5 §2.3 + §6.1 #8）：
 *  - 新增 INV-24（forest RootRegistry 单一真源，类比 INV-3/9）
 *  - 新增 INV-25（PolicyGate cloud 浏览器通道必经 manual-switch LASSO_ALLOW_CLOUD_BROWSER）
 *  - 新增 INV-26（forest 调度层不渗 channel internal：禁 import browse/desktop 内部）
 *
 * v0.4 M0.4b 状态（parse5 §2.3 + §3.5 + §4.4 appleScript/cgEvent 4-tier）：
 *  - 改写 INV-22（解除占位，正向断言 AppleScriptProvider typed action + 白名单）
 *  - 新增 INV-27（apple-script-whitelist.ts 顶级 const，不从 env 读）
 *  - 新增 INV-28（CGEventProvider 不暴露 raw keycode）
 *  - 新增 INV-29（DesktopChannel act 4 档 plan 全 desktop.*）
 *  - 收紧 INV-21 regex（CGEvent 段精确化）
 *
 * v0.4 M0.4c 状态（parse5 §2.3 + §3.3.2 + §6.3 #20）：
 *  - 新增 INV-30（stealth-profiles.ts 顶级 const，不从 config/env 读；类比 INV-14/27 anti-gaming）
 *  - 共 **30 条** invariants（INV-1..30 顺序编号）
 *
 * v0.5 M0.5a 状态（parse6 §1.5 + §3.1）：
 *  - 新增 INV-31（fetch_url 必经 ssrfGuard；与 browse_headless 同函数同 config）
 *  - 新增 INV-32（fetch_url 必经 SubprocessManager.acquireHttpClient；禁 new Agent / 禁裸 fetch）
 *  - 共 **32 条** invariants（INV-1..32 顺序编号；INV-33/34 推 M0.5b/c screenshot/pdf/network 时加）
 *
 * v0.5 M0.5b 状态（parse6 §1.5 + §3.2 + §3.3）：
 *  - 新增 INV-33（pdf/console/network 三 action 必在 BrowseChannel.actionDispatch Map；
 *                INV-6 衍生：禁第二 dispatch Map）
 *  - 新增 INV-34（screenshot/pdf 两个独立 tool handler 的返回路径必经 applyOutputEnvelope
 *                或经 BrowseChannel.browse 入口（隐式经 writeState）；INV-15 衍生到二进制内容）
 *  - 共 **34 条** invariants（INV-1..34 顺序编号；M0.5c network 时 INV-33/34 自动覆盖 network）
 *
 * 32 条铁律：
 *  INV-1 browse 是唯一 browse 入口
 *  INV-2 BaseChannel 不被绕过（所有 XxxChannel 必须 extends）
 *  INV-3 ProviderConfig 单一真源（types.ts）
 *  INV-4 不复用第二套 fallback 范式（FallbackDecider ≤1）
 *  INV-5 MCP ToolAnnotations 完整（每 server.tool 注册文件含 hint 字段）
 *  INV-6 dispatch 走注册表 Map（BrowseChannel.actionDispatch）
 *  INV-7 SubprocessManager 不含协议帧解析
 *  INV-8 fallback 链不跨 surface 类型（v0.3.5 改写：DesktopChannel fallback plan 必须全 desktop.*）
 *  INV-9 ProviderRegistry 类单一真源（只在 config/provider-registry.ts）—— v0.2
 *  INV-10 BraveChannel 禁直接读 process.env.BRAVE_API_KEYS，必须经 QuotaLedger —— v0.2
 *  INV-11 SearchCache key 必须含 engine + region + limit（防跨 provider 误命中）—— v0.2
 *  INV-12 BrowseChannel.browse()/runChain() 入口必须经 withOperation() ALS 包裹 —— v0.3
 *  INV-13 expect failed 必须 outcome=didnt + 终止（铁律：event delivery ≠ semantic success）—— v0.3
 *  INV-14 HIGH_RISK_PATTERNS 模块顶级 const，不从 config/env 读 —— v0.3
 *  INV-15 output-envelope spill 文件必须 mode 0o600（隐私适合 logged_in cookie）—— v0.3
 *  INV-16 DesktopChannel 必须 extends UiChannel（13 §2.4 R-CI-02 兄弟分层）—— v0.3.5
 *  INV-17 单 desktop tool 注册（action-enum 折叠，禁注册 desktop_snapshot 等拆分工具）—— v0.3.5
 *  INV-18 desktop fallback 经 FallbackDecider（禁自造 fallback 循环；R-CI-02）—— v0.3.5
 *  INV-19 OutlineNode 类型定义无 surface 字段（同形异源，统一形状）—— v0.3.5
 *  INV-20 desktop provider 名形如 desktop.*（grep DESKTOP_AX/DESKTOP_VLM + FallbackPlan）—— v0.3.5
 *  INV-21 src tree（.ts 全树）无 AXUIElement/CGEvent/AXPress/AXUIElementCreate 字面量 —— v0.3.5
 *  INV-22 appleScript/cgEvent provider 占位禁接（v0.3.5 grep desktop/ 无实装类；为 v0.4 预留）—— v0.3.5
 *  INV-23 = 改写后的 INV-8 内容（fallback 链不跨 surface，desktop 永不 fallback browse）—— v0.3.5
 *  INV-24 RootRegistry 类单一真源（forest 调度层；只在 src/forest/RootRegistry.ts）—— v0.4 M0.4a
 *  INV-25 PolicyGate cloud 浏览器通道必经 manual-switch（LASSO_ALLOW_CLOUD_BROWSER + ProviderConfig.policy_risk）—— v0.4 M0.4a
 *  INV-26 forest 调度层（src/forest/*.ts）不 import BrowseChannel/DesktopChannel internal —— v0.4 M0.4a
 *  INV-27 apple-script-whitelist.ts 顶级 const（不从 config/env 读；anti-gaming，类比 INV-14）—— v0.4 M0.4b
 *  INV-28 CGEventProvider 不暴露 raw keycode（typed logical key name only；INV-21 衍生）—— v0.4 M0.4b
 *  INV-29 DesktopChannel act 4 档 plan 全 desktop.*，顺序 ax→appleScript→cgEvent→screenshotVlm —— v0.4 M0.4b
 *  INV-30 stealth-profiles.ts 顶级 const（不从 config/env 读；anti-gaming，类比 INV-14/27）—— v0.4 M0.4c
 *  INV-31 fetch_url 必经 ssrfGuard（与 browse_headless 同函数；URL 入 fetch 前必命中）—— v0.5 M0.5a
 *  INV-32 fetch_url 必经 SubprocessManager.acquireHttpClient（禁 new Agent / 禁裸 fetch）—— v0.5 M0.5a
 *  INV-33 pdf/console/network 三 action 必以 entry 形式在 BrowseChannel.actionDispatch Map（INV-6 衍生：禁第二 dispatch）—— v0.5 M0.5b/M0.5c
 *  INV-34 screenshot/pdf/network 独立 tool handler 返回路径必经 applyOutputEnvelope 或经 BrowseChannel.browse 入口（INV-15 衍生到二进制内容）—— v0.5 M0.5b/M0.5c
 *
 * 注：INV-8 与 INV-23 同槽（parse4 §1.4「INV-8 改写为 INV-23」语义保留槽位）。
 *     INV-8 自身已含「fallback 链不跨 surface」语义；INV-23 编号在文档中保留为别名，
 *     实际 npm run check-invariants 报 30 条全绿。
 *
 * Phase A 语义：骨架阶段。对尚未实装的模块（BrowseChannel /
 * SubprocessManager / FallbackDecider），断言取「允许缺失 = 合规」，
 * 等 Phase C-E 实装后这些断言自动收紧（TDD red→green）。
 *
 * Phase B 状态：INV-13 收紧到 ExpectPoll 端（源端契约：failed 三态必须存在）；
 * 等 Phase C StepEngine 落地后再追加调用端 regex 检查。
 *
 * Phase C 状态（v0.3.5）：INV-8 改写 + INV-16..23 全部上线。
 * Phase v0.4 M0.4a 状态：INV-24/25/26 全部上线（forest 调度层 + 政策 gate）。
 * Phase v0.4 M0.4b 状态：INV-22 改写 + INV-27/28/29 全部上线。
 * Phase v0.4 M0.4c 状态：INV-30 上线（stealth-profiles 顶级 const）。
 * Phase v0.5 M0.5a 状态：INV-31/32 上线（fetch_url SSRF + 连接池守门）。
 * Phase v0.5 M0.5b 状态：INV-33/34 上线（pdf/console actionDispatch + screenshot/pdf 二进制 envelope）。
 *
 * Node 20+：readdirSync recursive 选项（v20.17+），不依赖 Array.fromAsync。
 *
 * 运行：node src/invariants/check-invariants.mjs   或   npm run check-invariants
 * CI ：exit 0 = 全绿；exit 1 = 至少一条红线。
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));

function listTsFiles(root) {
  return readdirSync(root, { recursive: true })
    .map((p) => join(root, String(p)))
    .filter((p) => p.endsWith(".ts"));
}

const TS_FILES = listTsFiles(SRC_ROOT);
const SRC = TS_FILES.map((f) => ({ f: relative(SRC_ROOT, f), text: readFileSync(f, "utf8") }));

function countMatches(re) {
  return SRC.reduce((n, s) => n + (s.text.match(re) || []).length, 0);
}

/**
 * 去掉 line-comment（双斜杠）和 block-comment（斜杠星），仅留代码本体
 * （INV-21 平台字面量扫代码用）。
 *
 * v0.5 改进：string-aware（守 INV-31/32 fetch_url 的 Accept 头部含星号-斜杠-星号字串
 * 不被误判为 block-comment 终止符）。
 * 用单遍正则交替匹配：先匹配字符串字面量（原子，内部含星斜杠序列也不被打断），
 * 再匹配注释。字符串原样保留，注释（以斜杠开头）替换为空。
 *
 * 处理：双引号串、单引号串、反引号模板串 三种字符串 + 双斜杠行注释 + 斜杠星块注释。
 * Template literal 的 ${...} 内部不再扫描（边界 case，不影响现有 INV）。
 */
function stripComments(text) {
  const tokenRegex =
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return text.replace(tokenRegex, (match) => {
    // 字符串字面量原样保留；注释（以斜杠开头）替换为空
    if (match.startsWith("/")) return "";
    return match;
  });
}

const assertions = [
  {
    id: "INV-1-browse-single-entry",
    desc: "browse 唯一入口：browse_headless / browse_logged_in 各注册恰好一次",
    check: () =>
      countMatches(/server\.tool\(\s*["']browse_headless["']/g) === 1 &&
      countMatches(/server\.tool\(\s*["']browse_logged_in["']/g) === 1,
  },
  {
    id: "INV-2-basechannel-not-bypassed",
    desc: "BaseChannel 不被绕过：任何具体（非 abstract）XxxChannel 类必须 extends",
    check: () => {
      // 任何 "class XxxChannel {" 没跟 extends 的都算绕过；
      // 但允许 abstract 基类（BaseChannel / UiChannel / BrowseChannel 是根，无 extends 合规）。
      // JS lookbehind 在 Node 20+ 支持。
      const bypass = SRC.some((s) =>
        /(?<!abstract\s)class\s+\w*Channel\s*\{/.test(s.text),
      );
      return !bypass;
    },
  },
  {
    id: "INV-3-providerconfig-single-source",
    desc: "ProviderConfig 单一真源：interface/type 定义只在 types.ts",
    check: () => {
      const offSource = SRC.filter(
        (s) =>
          s.f !== "types.ts" &&
          /interface\s+ProviderConfig|type\s+ProviderConfig\s*=/.test(s.text),
      );
      return offSource.length === 0;
    },
  },
  {
    id: "INV-4-single-fallback-paradigm",
    desc: "单一 fallback 范式：class FallbackDecider 定义 ≤1（Phase A 允许 0）",
    check: () => countMatches(/class\s+FallbackDecider/g) <= 1,
  },
  {
    id: "INV-5-toolannotations-complete",
    desc: "MCP ToolAnnotations 完整：server.tool( 调用必须携带 annotations（直写 hint 或从 annotations 模块导入）",
    check: () => {
      // 全局至少出现 4 个 hint 关键字（保证 annotations 模块存在且有内容）
      const totalHints = countMatches(
        /readOnlyHint|openWorldHint|destructiveHint|idempotentHint/g,
      );
      if (totalHints < 4) return false;

      // 每个含 server.tool( 的文件必须二选一：
      //   (a) 自己文件里出现 hint 关键字（直写），或
      //   (b) 从 annotations 模块导入并使用（grep 到 annotations 标识符 + import 自 ./annotations）
      for (const s of SRC) {
        if (!s.text.includes("server.tool(")) continue;
        const hasHintInline =
          /readOnlyHint|openWorldHint|destructiveHint|idempotentHint/.test(
            s.text,
          );
        if (hasHintInline) continue;
        const importsAnnotations =
          /from\s+["'][^"']*annotations(\.js)?["']/.test(s.text) &&
          /\bannotations\b/.test(s.text);
        if (!importsAnnotations) return false;
      }
      return true;
    },
  },
  {
    id: "INV-6-dispatch-registry-map",
    desc: "dispatch 走注册表 Map：BrowseChannel 实装后 actionDispatch 必须是 new Map（Phase A 允许未实装）",
    check: () => {
      const hasBrowseChannel = SRC.some((s) =>
        /class\s+BrowseChannel/.test(s.text),
      );
      if (!hasBrowseChannel) return true; // 允许尚未实装
      return SRC.some((s) =>
        /actionDispatch\s*=\s*new\s+Map/.test(s.text),
      );
    },
  },
  {
    id: "INV-7-subproc-no-protocol-frames",
    desc: "SubprocessManager 不含协议帧解析：禁 Content-Length/readFrame/parseFrame（Phase A 允许未实装）",
    check: () => {
      const sub = SRC.find((s) => s.f.includes("SubprocessManager"));
      if (!sub) return true; // 允许尚未实装
      return !/write\(\s*["']Content-Length|readFrame|parseFrame/.test(
        sub.text,
      );
    },
  },
  {
    id: "INV-8-fallback-no-cross-surface",
    desc: "v0.3.5 改写：fallback 链不跨 surface —— DesktopChannel 的 FallbackPlan primary+fallbacks 必须全 desktop.*，禁 browse_*（INV-23 同槽）",
    check: () => {
      // DesktopChannel.ts 必须存在（v0.3.5 Phase C 落地）
      const dc = SRC.find((s) => /channels\/DesktopChannel\.ts$/.test(s.f.replace(/\\/g, "/")));
      if (!dc) return false;
      // 抽出 DesktopChannel 内的 FallbackPlan 字面量（包含 primary + fallbacks 的对象）
      // primary 必须以 "desktop." 开头；fallbacks 数组里每项必须以 "desktop." 开头
      const planMatch = dc.text.match(
        /primary\s*:\s*["'](desktop\.[^"']+)["'][^}]*fallbacks\s*:\s*\[([^\]]*)\]/s,
      );
      if (!planMatch) return false;
      const fallbacksBlob = planMatch[2];
      const fallbackNames = [...fallbacksBlob.matchAll(/["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      if (fallbackNames.length === 0) return false;
      const allDesktop =
        planMatch[1].startsWith("desktop.") &&
        fallbackNames.every((n) => n.startsWith("desktop."));
      const hasBrowseLeak = /\b(browse_headless|browse_logged_in)\b/.test(
        fallbacksBlob,
      );
      return allDesktop && !hasBrowseLeak;
    },
  },
  // ============================================================
  // v0.2 新增（parse2 §5.4）
  // ============================================================
  {
    id: "INV-9-provider-registry-single-source",
    desc: "ProviderRegistry 类单一真源：定义只在 config/provider-registry.ts",
    check: () => {
      // 精确匹配「class ProviderRegistry」（不允许 ProviderRegistryX 等子串误中）
      const filesWithDef = SRC.filter((s) =>
        /class\s+ProviderRegistry\b/.test(s.text),
      );
      if (filesWithDef.length === 0) return true; // 允许尚未实装
      // 必须只在 config/provider-registry.ts 定义
      return filesWithDef.every((s) => s.f.replace(/\\/g, "/") === "config/provider-registry.ts");
    },
  },
  {
    id: "INV-10-brave-keys-via-ledger",
    desc: "BraveChannel 禁直接读 process.env.BRAVE_API_KEYS / BRAVE_API_KEY，必须经 QuotaLedger",
    check: () => {
      const brave = SRC.find((s) => s.f.includes("BraveChannel"));
      if (!brave) return true; // 允许尚未实装（Phase A 之后 Phase B 落地）
      return !/process\.env\.BRAVE_API_KEYS|process\.env\.BRAVE_API_KEY/.test(
        brave.text,
      );
    },
  },
  {
    id: "INV-11-cache-key-attributed",
    desc: "SearchCache key 必须含 engine + region + limit（防跨 provider 误命中）",
    check: () => {
      const cache = SRC.find((s) => s.f.includes("SearchCache"));
      if (!cache) return true; // 允许尚未实装（Phase D 落地）
      // key 计算函数的入参签名 / sha1 输入必须同时出现 engine / region / limit
      const txt = cache.text;
      const hasEngine = /\bengine\b/.test(txt);
      const hasRegion = /\bregion\b/.test(txt);
      const hasLimit = /\blimit\b/.test(txt);
      return hasEngine && hasRegion && hasLimit;
    },
  },
  // ============================================================
  // v0.3 新增（parse3 §5.3）—— Phase A 上线 INV-12 + INV-15
  // ============================================================
  {
    id: "INV-12-browse-als-scoped",
    desc: "BrowseChannel 的 browse/runChain 必须在 withOperation() ALS 内执行（F3.2.10）",
    check: () => {
      // 必要条件 1：state-store.ts 定义了 class StateStore（LRU + ALS 落地）
      // 必要条件 2：项目里出现 withOperation 标识符（导出 + 后续 Phase C 调用）
      // 注：export function withOperation(  也会被 withOperation\s*\( 匹配到，
      // 所以 Phase A 只要导出存在即合规；Phase C 起 BrowseChannel 接入真正调用。
      const hasStateStoreClass = SRC.some(
        (s) => /class\s+StateStore/.test(s.text),
      );
      const hasWithOp = SRC.some((s) => /withOperation\s*\(/.test(s.text));
      return hasStateStoreClass && hasWithOp;
    },
  },
  {
    id: "INV-13-expect-failed-forces-didnt",
    desc: "ExpectPoll 返回 'failed' 时调用方必须强制 outcome=didnt + 终止 chain（铁律：event delivery ≠ semantic success）",
    check: () => {
      // Phase B（本阶段）：ExpectPoll.ts 必须存在且暴露 'failed' 判定 + ExpectVerdict 三态。
      //   这是 expect failed → outcome=didnt 契约的「源端」保证 —— 没有正确的 failed，
      //   调用方无从触发强制 didnt。
      // Phase C（StepEngine 落地后）：再追加检查 StepEngine 中 failed → outcome=didnt
      //   的强制写入（parse3 §5.3 原始 regex）。
      const poll = SRC.find((s) =>
        s.f.replace(/\\/g, "/").includes("browse/ExpectPoll"),
      );
      if (!poll) return false; // Phase B 起 ExpectPoll 必须存在
      const hasFailed = /["']failed["']/.test(poll.text);
      const hasVerdict = /ExpectVerdict/.test(poll.text);
      if (!hasFailed || !hasVerdict) return false;

      // 若 StepEngine 已实装（Phase C），追加检查 failed → outcome=didnt 强制
      const eng = SRC.find((s) => s.f.includes("StepEngine"));
      if (eng) {
        return /failed.*didnt|outcome.*=.*["']didnt["'].*failed|expect_check.*failed/.test(
          eng.text,
        );
      }
      return true; // Phase B：StepEngine 尚未实装，仅检查 ExpectPoll 端
    },
  },
  {
    id: "INV-14-highrisk-patterns-const",
    desc: "HIGH_RISK_PATTERNS 必须是模块顶级 const，不从 config/env 读（anti-gaming，parse3 §3.5）",
    check: () => {
      // Phase D（本阶段）：HighRiskGate.ts 必须存在且：
      //   1) 顶级出现 const HIGH_RISK_PATTERNS（Object.freeze 也算）
      //   2) 不出现 process.env.HIGH_RISK / config 读取（防 LLM 通过 config 绕过自己）
      //   3) 必须出现 anti-gaming 关键字（让 invariant 自我文档化）
      const g = SRC.find((s) =>
        s.f.replace(/\\/g, "/").includes("browse/HighRiskGate"),
      );
      if (!g) return false; // Phase D 起 HighRiskGate 必须存在
      const hasConst = /(?:const|readonly)\s+HIGH_RISK_PATTERNS/.test(g.text);
      const noEnv = !/process\.env\.HIGH_RISK/.test(g.text);
      return hasConst && noEnv;
    },
  },
  {
    id: "INV-15-output-spill-mode-0o600",
    desc: "output-envelope spill 文件必须 mode 0o600（隐私适合 logged_in cookie 内容）",
    check: () => {
      const o = SRC.find((s) =>
        s.f.replace(/\\/g, "/").includes("util/output-envelope"),
      );
      if (!o) return true; // 允许尚未实装（Phase A 后必须存在）
      // 必须出现 0o600（文件 mode）或 0o700（目录 mode）；二者至少其一
      return /0o600|0o700/.test(o.text);
    },
  },
  // ============================================================
  // v0.3.5 新增（parse4 §1.4 + §3.x F3.9.9 (a)-(h)）
  // ============================================================
  {
    id: "INV-16-desktopchannel-extends-uichannel",
    desc: "DesktopChannel 必须 extends UiChannel（13 §2.4 R-CI-02：兄弟不是父子，避免 BaseChannel 被 AXAPI 污染）",
    check: () =>
      SRC.some((s) =>
        /class\s+DesktopChannel\s+extends\s+UiChannel\b/.test(s.text),
      ),
  },
  {
    id: "INV-17-single-desktop-tool-action-enum",
    desc: "单 desktop tool 注册：「desktop」恰好注册一次；禁注册 desktop_snapshot/desktop_act/desktop_find 等拆分工具",
    check: () => {
      // 仅计代码本体（去注释）—— 注释里讨论 server.tool("desktop") 不算注册
      let totalDesktopRegistrations = 0;
      let splitToolLeak = false;
      for (const s of SRC) {
        const codeOnly = stripComments(s.text);
        totalDesktopRegistrations +=
          (codeOnly.match(/server\.tool\(\s*["']desktop["']/g) || []).length;
        if (
          /server\.tool\(\s*["']desktop_(snapshot|find|act|wait|screenshot|doctor)["']/.test(
            codeOnly,
          )
        ) {
          splitToolLeak = true;
        }
      }
      if (totalDesktopRegistrations !== 1) return false;
      return !splitToolLeak;
    },
  },
  {
    id: "INV-18-desktop-fallback-via-decider",
    desc: "desktop fallback 必须经 FallbackDecider.runWithFallback（禁自造 fallback 循环；R-CI-02）",
    check: () => {
      const dc = SRC.find((s) => /channels\/DesktopChannel\.ts$/.test(s.f.replace(/\\/g, "/")));
      if (!dc) return false;
      // 必须 grep 到 decider.runWithFallback（注入 + 调用）；不能是注释提及
      // 去注释后判定更严（防 // decider.runWithFallback 假阳）
      const codeOnly = stripComments(dc.text);
      return /decider\.runWithFallback\s*\(/.test(codeOnly);
    },
  },
  {
    id: "INV-19-outlinenode-no-surface-field",
    desc: "OutlineNode 类型定义无 surface 字段（同形异源；统一形状不分 browse/desktop）",
    check: () => {
      const dt = SRC.find((s) => /desktop\/desktop-types\.ts$/.test(s.f.replace(/\\/g, "/")));
      if (!dt) return false;
      // 找到 OutlineNode interface 块；块内禁出现 "surface" 字段名
      const block = dt.text.match(
        /interface\s+OutlineNode\s*\{([\s\S]*?)\n\}/,
      )?.[1] ?? "";
      // 允许在块外讨论（注释 / 其他类型）；块内禁字段定义 surface?
      return !/^\s*surface\s*[:?]/m.test(block);
    },
  },
  {
    id: "INV-20-desktop-provider-name-dot-namespace",
    desc: "desktop provider 名形如 desktop.*：DESKTOP_AX / DESKTOP_VLM 必须以 desktop. 开头；FallbackPlan primary+fallbacks 同样",
    check: () => {
      // 1. providers.ts 中 DESKTOP_AX.name + DESKTOP_VLM.name 必须以 "desktop." 开头
      const prov = SRC.find((s) => /config\/providers\.ts$/.test(s.f.replace(/\\/g, "/")));
      if (!prov) return false;
      const axName = prov.text.match(
        /DESKTOP_AX[^}]*?name\s*:\s*["']([^"']+)["']/s,
      )?.[1];
      const vlmName = prov.text.match(
        /DESKTOP_VLM[^}]*?name\s*:\s*["']([^"']+)["']/s,
      )?.[1];
      if (!axName || !axName.startsWith("desktop.")) return false;
      if (!vlmName || !vlmName.startsWith("desktop.")) return false;
      // 2. DesktopChannel 的 FallbackPlan primary/fallbacks 也必须以 desktop. 开头
      const dc = SRC.find((s) => /channels\/DesktopChannel\.ts$/.test(s.f.replace(/\\/g, "/")));
      if (!dc) return false;
      const plan = dc.text.match(
        /primary\s*:\s*["'](desktop\.[^"']+)["'][^}]*fallbacks\s*:\s*\[([^\]]*)\]/s,
      );
      if (!plan) return false;
      const fallbacksAllDesktop = [...plan[2].matchAll(/["'](desktop\.[^"']+)["']/g)]
        .length > 0;
      return fallbacksAllDesktop;
    },
  },
  {
    id: "INV-21-no-platform-literals-in-ts",
    desc: "src/**/*.ts 代码本体无 AXUIElement/CGEvent FFI/AXPress/AXUIElementCreate 平台字面量（隔离在 rust-helper；v0.4 M0.4b 收紧 CGEvent regex）",
    check: () => {
      // 去注释后扫所有 .ts 文件代码本体（含字符串字面量也算——铁律是 TS 不引用平台符号）
      // 例外：rust-helper/ 不在 src/ 下；本扫描自动只覆盖 src/**/*.ts
      // v0.4 M0.4b：CGEvent 段从 `\bCGEvent\w*` 收紧为枚举 FFI 符号
      //   `\bCGEvent(?:Source|Flags|Type|TapLocation|SourceStateID|Create|Post|Tap)?\b`
      //   原因：parse5 §3.5.3 明确 TS 端类名是 `CGEventProvider`、类型名 `CGEventAction`，
      //   这些是 TS 抽象（不调平台 API），不应被误判为平台字面量；而真正的 FFI 符号
      //   （CGEventSource / CGEventFlags / CGEventType / CGEventTapLocation / ...）
      //   仍被精准禁止。AXUIElement 段保持 `\bAXUIElement\w*`（AxProvider 不匹配该前缀）。
      const PLATFORM_RE =
        /\bAXUIElement\w*|\bAXPress\b|\bAXUIElementCreateSystemWide\b|\bAXIsProcessTrustedWithOptions\b|\bCGPreflightScreenCaptureAccess\b|\bCGWindowListCreateImage\b|\bCGEvent(?:Source|Flags|Type|TapLocation|SourceStateID|Create|Post|Tap)?\b/;
      return SRC.every((s) => !PLATFORM_RE.test(stripComments(s.text)));
    },
  },
  {
    id: "INV-22-applescript-typed-action-whitelist",
    desc: "v0.4 M0.4b 改写（解除占位）：AppleScriptProvider 必须 typed action enum + 白名单（禁 raw 脚本串；INV-27 镜像）",
    check: () => {
      // v0.3.5 占位语义（「desktop/ 下无 AppleScriptProvider 实装类」）已解除；
      // v0.4 M0.4b 起改为正向断言：实装必须在，且必须守 typed action enum + 白名单契约。
      //
      // 必要条件 1：desktop/AppleScriptProvider.ts 存在且定义 class AppleScriptProvider
      const provider = SRC.find((s) =>
        /desktop\/AppleScriptProvider\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!provider) return false;
      const providerCode = stripComments(provider.text);
      if (!/class\s+AppleScriptProvider\b/.test(providerCode)) return false;

      // 必要条件 2：apple-script-whitelist.ts 存在且导出 APPLE_SCRIPT_WHITELIST 顶级 const
      const wl = SRC.find((s) =>
        /desktop\/apple-script-whitelist\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!wl) return false;
      const wlCode = stripComments(wl.text);
      // 顶级 const 导出（export const APPLE_SCRIPT_WHITELIST = {...}）
      if (!/export\s+const\s+APPLE_SCRIPT_WHITELIST\b/.test(wlCode)) return false;

      // 必要条件 3：AppleScriptProvider 必须 import 白名单并显式校验
      //   （grep `from "./apple-script-whitelist` 或 `from "../apple-script-whitelist`）
      if (
        !/from\s+["'][^"']*apple-script-whitelist(\.js)?["']/.test(providerCode)
      ) {
        return false;
      }
      // 必须出现 isKnownAction / findDisallowedParamKey / APPLE_SCRIPT_WHITELIST 之一
      // （说明真的在校验白名单，而不只是 import 未用）
      const usesWhitelist =
        /\bisKnownAction\b|\bfindDisallowedParamKey\b|\bAPPLE_SCRIPT_WHITELIST\b/.test(
          providerCode,
        );
      if (!usesWhitelist) return false;

      // 必要条件 4：禁 raw 脚本串入口 —— AppleScriptProvider 不接受 opts.script 字段
      //   grep `script:` 作为 DesktopOptions 字段（字面量属性定义）必须不出现
      //   注：这里用代码本体；允许在 error 信息 / retrieval_method 字符串里提到 "script"
      //   （如 "script_not_in_whitelist"），那些是诊断字符串不是入口字段。
      //   入口字段定义形式：`script:` 或 `script?:` 后跟类型。
      const hasRawScriptField = /\b\s*script\?\s*:/.test(providerCode);
      if (hasRawScriptField) return false;

      // 必要条件 5：AppleScriptProvider 经 RustBridge.call("applescript_run") 调 helper
      //   （INV-21 衍生：TS 端不直接碰 osascript/OSAKit）
      if (!/rust\.call\s*\(\s*["']applescript_run["']/.test(providerCode)) {
        return false;
      }
      // AppleScriptProvider 代码本体禁出现 osascript / OSAKit 直接调用符号
      // （注释里允许讨论；只查代码本体）
      if (/\bosascript\b|\bOSAKit\b|\bNSAppleScript\b/.test(providerCode)) {
        return false;
      }

      return true;
    },
  },
  {
    id: "INV-23-desktop-never-fallback-browse",
    desc: "v0.3.5：DesktopChannel fallback 链永不出现 browse_headless/browse_logged_in（INV-8 同义补充断言）",
    check: () => {
      const dc = SRC.find((s) => /channels\/DesktopChannel\.ts$/.test(s.f.replace(/\\/g, "/")));
      if (!dc) return false;
      // 整个 DesktopChannel.ts 不出现 browse_headless / browse_logged_in 字符串字面量
      // （注释里允许讨论；只查字面量）
      const codeOnly = stripComments(dc.text);
      return !/["'](browse_headless|browse_logged_in)["']/.test(codeOnly);
    },
  },
  // ============================================================
  // v0.4 M0.4a 新增（parse5 §2.3 forest 调度层）
  // ============================================================
  {
    id: "INV-24-rootregistry-single-source",
    desc: "v0.4：RootRegistry 类单一真源（forest 调度层；只在 src/forest/RootRegistry.ts，类比 INV-3/9）",
    check: () => {
      const filesWithDef = SRC.filter((s) =>
        /class\s+RootRegistry\b/.test(s.text),
      );
      if (filesWithDef.length === 0) return false; // v0.4 M0.4a 起必须存在
      return filesWithDef.every((s) =>
        s.f.replace(/\\/g, "/") === "forest/RootRegistry.ts",
      );
    },
  },
  {
    id: "INV-25-policy-gate-cloud-manual-switch",
    desc: "v0.4：PolicyGate cloud 浏览器通道必经 manual-switch —— PolicyGate.ts 必须检查 LASSO_ALLOW_CLOUD_BROWSER + providers.ts 必须有 policy_risk 字段（cloud 浏览器 provider）",
    check: () => {
      // 1. PolicyGate.ts 必须存在（v0.4 M0.4a 实装）
      const gate = SRC.find((s) =>
        /fallback\/PolicyGate\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!gate) return false;
      // 2. PolicyGate.ts 代码本体必须出现 LASSO_ALLOW_CLOUD_BROWSER 字面量
      //    （manual-switch 总开关；构造期注入的 env 字段名注释或 doc 提及都算）
      const gateCode = gate.text; // 注释也算（文档自我化的铁律）
      if (!/LASSO_ALLOW_CLOUD_BROWSER/.test(gateCode)) return false;
      // 3. PolicyGate.ts 必须实装 PolicyGate class（不只是类型导出）
      if (!/class\s+PolicyGate\b/.test(gateCode)) return false;
      // 4. PolicyGate.ts 必须检查 policy_risk 字段（三态中的 acquired / watched）
      if (!/policy_risk/.test(gateCode)) return false;
      // 5. providers.ts 必须有 cloud 浏览器 ProviderConfig（BROWSERBASE / STAGEHAND）
      //    单独导出（不进 BUILTIN_PROVIDERS，参照 DESKTOP_PROVIDERS 范式）
      const prov = SRC.find((s) =>
        /config\/providers\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!prov) return false;
      const hasBrowserbase = /const\s+BROWSERBASE\s*:\s*ProviderConfig/.test(
        prov.text,
      );
      const hasStagehand = /const\s+STAGEHAND\s*:\s*ProviderConfig/.test(
        prov.text,
      );
      if (!hasBrowserbase || !hasStagehand) return false;
      // 6. 两个 cloud 浏览器 ProviderConfig 必须配 policy_risk 字段（非 safe → 真有风险）
      //    提取 BROWSERBASE 块检查 policy_risk
      const browserbaseBlock = prov.text.match(
        /const\s+BROWSERBASE\s*:\s*ProviderConfig\s*=\s*\{([\s\S]*?)\};/,
      )?.[1] ?? "";
      const stagehandBlock = prov.text.match(
        /const\s+STAGEHAND\s*:\s*ProviderConfig\s*=\s*\{([\s\S]*?)\};/,
      )?.[1] ?? "";
      const bbRisk = /policy_risk\s*:\s*["'](acquired|watched)["']/.test(
        browserbaseBlock,
      );
      const shRisk = /policy_risk\s*:\s*["'](acquired|watched)["']/.test(
        stagehandBlock,
      );
      if (!bbRisk || !shRisk) return false;
      // 7. cloud 浏览器 providers 必须**单独导出**（不进 BUILTIN_PROVIDERS，零回归承诺）
      //    检查 BUILTIN_PROVIDERS 字面量数组里不含 BROWSERBASE / STAGEHAND
      const builtinBlock = prov.text.match(
        /BUILTIN_PROVIDERS[^=]*=\s*\[([\s\S]*?)\]/,
      )?.[1] ?? "";
      if (/\bBROWSERBASE\b|\bSTAGEHAND\b/.test(builtinBlock)) return false;
      return true;
    },
  },
  {
    id: "INV-26-forest-no-channel-internal-import",
    desc: "v0.4：forest 调度层（src/forest/*.ts）不 import BrowseChannel/DesktopChannel internal 模块（R-CI-02 守护）",
    check: () => {
      // src/forest/ 下任何 .ts 文件代码本体（去注释）禁 import 自：
      //   ../browse/*.js  ../desktop/*.js  ../subprocess/*.js  ../fallback/*.js
      //   ../serp/*.js  ../search/*.js  ../config/*.js
      // 允许：../channels/BrowseChannel.js  ../channels/DesktopChannel.js（class 接口契约）
      //       ../types.js（共享类型）
      //       同层 ./forest-types.js  ./RootRegistry.js（forest 调度层内部）
      const FORBIDDEN_FOREST_IMPORTS =
        /from\s+["']\.\.\/(browse|desktop|subprocess|fallback|serp|search|config|ssrf|tools|doctor|util|invariants)\/[^"']*["']/;
      const forestFiles = SRC.filter((s) =>
        /^forest\//.test(s.f.replace(/\\/g, "/")),
      );
      if (forestFiles.length === 0) return false; // v0.4 M0.4a 起必须有 forest 文件
      return forestFiles.every((s) => {
        const codeOnly = stripComments(s.text);
        return !FORBIDDEN_FOREST_IMPORTS.test(codeOnly);
      });
    },
  },
  // ============================================================
  // v0.4 M0.4b 新增（parse5 §2.3 + §3.5 + §4.4 appleScript/cgEvent 4-tier）
  // ============================================================
  {
    id: "INV-27-applescript-whitelist-top-level-const",
    desc: "v0.4 M0.4b：apple-script-whitelist.ts 顶级 const（不从 config/env 读；anti-gaming，类比 INV-14）",
    check: () => {
      // 必要条件 1：apple-script-whitelist.ts 存在
      const wl = SRC.find((s) =>
        /desktop\/apple-script-whitelist\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!wl) return false; // v0.4 M0.4b 起必须存在
      const code = stripComments(wl.text);
      // 必要条件 2：顶级 const APPLE_SCRIPT_WHITELIST（export const，对象字面量）
      //   接受 Object.freeze(...) 或直接对象字面量
      if (!/export\s+const\s+APPLE_SCRIPT_WHITELIST\b/.test(code)) return false;
      // 必要条件 3：代码本体禁出现 process.env（INV-27 anti-gaming 红线）
      //   注：仅在注释里提到 process.env 算合规；代码本体 0 容忍。
      if (/process\.env/.test(code)) return false;
      // 必要条件 4：白名单不 import config / provider-registry / env-reader
      //   （顶级 const 不依赖运行时配置；防 LLM 通过 channel 改 env 绕过）
      if (
        /from\s+["'][^"']*(config\/|provider-registry|env-reader|env-config)/.test(
          code,
        )
      ) {
        return false;
      }
      return true;
    },
  },
  {
    id: "INV-28-cgevent-no-raw-keycode",
    desc: "v0.4 M0.4b：CGEventProvider 不暴露 raw keycode 入参（typed logical key name only；INV-21 衍生）",
    check: () => {
      // 必要条件 1：CGEventProvider.ts 存在且定义 class CGEventProvider
      const provider = SRC.find((s) =>
        /desktop\/CGEventProvider\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!provider) return false; // v0.4 M0.4b 起必须存在
      const code = stripComments(provider.text);
      if (!/class\s+CGEventProvider\b/.test(code)) return false;

      // 必要条件 2：必须显式拒绝 raw keycode 数字入参
      //   守门逻辑：grep `typeof.*===.*"number"` 与 key/keys 共现，或专用
      //   retrieval_method/error 标识 "raw_keycode_forbidden" 出现
      //   （这是 INV-28 的核心断言：层 1 守门必须有可识别的实现）
      const hasRawKeycodeGuard =
        /raw_keycode_forbidden/.test(code) ||
        (/typeof\s+\w+\.key\s*===\s*["']number["']/.test(code) &&
          /hotkey|press/.test(code));
      if (!hasRawKeycodeGuard) return false;

      // 必要条件 3：rust.call 走 "cgevent_dispatch"（不直接调 CGEvent FFI；INV-21 衍生）
      if (!/rust\.call\s*\(\s*["']cgevent_dispatch["']/.test(code)) return false;

      // 必要条件 4：CGEventProvider 代码本体禁出现 raw keycode 数字字面量
      //   形如 `key: 36` / `keycode: 36` 等直接数字（INV-28 红线）
      //   注：循环计数器 `let i = 0` / 数组 index 等不算（那些不是 key/keycode 字段）
      //   精确匹配：`key:<数字>` 或 `keycode:<数字>` 形式
      const hasRawKeycodeLiteral =
        /\bkey\s*:\s*\d+\b|\bkeycode\s*:\s*\d+\b/.test(code);
      if (hasRawKeycodeLiteral) return false;

      // 必要条件 5：CGEventProvider 代码本体禁直接调 CGEvent FFI 符号
      //   （CGEvent::, CGEventSource::, new CGEvent, etc.；这些应在 rust-helper）
      if (/\bCGEvent\b|\bCGEventSource\b|\bCGEventFlags\b/.test(code)) {
        return false;
      }

      return true;
    },
  },
  {
    id: "INV-29-desktop-act-4-tier-all-desktop",
    desc: "v0.4 M0.4b：DesktopChannel act 4 档 plan 全 desktop.*，顺序 ax→appleScript→cgEvent→screenshotVlm（INV-8/23 衍生强化）",
    check: () => {
      const dc = SRC.find((s) =>
        /channels\/DesktopChannel\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!dc) return false;
      const code = stripComments(dc.text);

      // 必要条件 1：grep FallbackPlan 字面量（primary + fallbacks 数组）
      const planMatch = code.match(
        /primary\s*:\s*["'](desktop\.[^"']+)["'][^}]*fallbacks\s*:\s*\[([\s\S]*?)\]/,
      );
      if (!planMatch) return false;
      const primary = planMatch[1];
      const fallbacksBlob = planMatch[2];
      const fallbackNames = [
        ...fallbacksBlob.matchAll(/["']([^"']+)["']/g),
      ].map((m) => m[1]);

      // 必要条件 2：primary 必须是 desktop.ax
      if (primary !== "desktop.ax") return false;

      // 必要条件 3：fallbacks 必须恰好 3 项且顺序锁定为
      //   "desktop.appleScript" → "desktop.cgEvent" → "desktop.screenshotVlm"
      //   （parse5 §3.5.4 + §6.2 #9 4-tier fallback 链）
      if (fallbackNames.length !== 3) return false;
      const expected = [
        "desktop.appleScript",
        "desktop.cgEvent",
        "desktop.screenshotVlm",
      ];
      if (
        !fallbackNames.every((n, i) => n === expected[i])
      ) {
        return false;
      }

      // 必要条件 4：全 desktop.* 命名空间（INV-8/23 同义强化）
      const all = [primary, ...fallbackNames];
      if (!all.every((n) => n.startsWith("desktop."))) return false;

      // 必要条件 5：禁出现 browse_* 字面量（INV-23 同义断言；4 档 plan 内绝不混入）
      if (/\b(browse_headless|browse_logged_in|browse_cloud)\b/.test(fallbacksBlob)) {
        return false;
      }

      // 必要条件 6：cross_modal 必须为 false（INV-23 守护）
      if (!/cross_modal\s*:\s*false/.test(code)) return false;

      // 必要条件 7：executor 必须为 4 档每个 channel 名提供 dispatch 分支
      //   （grep "desktop.ax" / "desktop.appleScript" / "desktop.cgEvent" / "desktop.screenshotVlm"
      //    都在 executor 的 if 分支里出现，确保 4 档都有实装路径）
      const channelDispatchBranches = [
        /["']desktop\.ax["']/.test(code),
        /["']desktop\.appleScript["']/.test(code),
        /["']desktop\.cgEvent["']/.test(code),
        /["']desktop\.screenshotVlm["']/.test(code),
      ];
      if (!channelDispatchBranches.every(Boolean)) return false;

      return true;
    },
  },
  // ============================================================
  // v0.4 M0.4c 新增（parse5 §2.3 + §3.3.2 stealth 顶级 const）
  // ============================================================
  {
    id: "INV-30-stealth-profiles-top-level-const",
    desc: "v0.4 M0.4c：stealth-profiles.ts 顶级 const（不从 config/env 读；anti-gaming，类比 INV-14/27）",
    check: () => {
      // 必要条件 1：stealth-profiles.ts 存在
      const sp = SRC.find((s) =>
        /browse\/stealth-profiles\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!sp) return false; // v0.4 M0.4c 起必须存在
      const code = stripComments(sp.text);

      // 必要条件 2：顶级 const 导出（STEALTH_PROFILES + STEALTH_INJECTION_SCRIPT
      //   + CLOUDFLARE_DETECTION_SCRIPT + CLOUDFLARE_CHALLENGE_MARKERS 四件套）
      //   全部 export const（顶级，非内部函数变量）
      const hasProfiles = /export\s+const\s+STEALTH_PROFILES\b/.test(code);
      const hasInjection = /export\s+const\s+STEALTH_INJECTION_SCRIPT\b/.test(
        code,
      );
      const hasCfScript = /export\s+const\s+CLOUDFLARE_DETECTION_SCRIPT\b/.test(
        code,
      );
      const hasCfMarkers = /export\s+const\s+CLOUDFLARE_CHALLENGE_MARKERS\b/.test(
        code,
      );
      if (!hasProfiles || !hasInjection || !hasCfScript || !hasCfMarkers) {
        return false;
      }

      // 必要条件 3：代码本体禁出现 process.env（INV-30 anti-gaming 红线）
      //   注：仅在注释里提到 process.env 算合规；代码本体 0 容忍。
      //   类比 INV-14（HIGH_RISK_PATTERNS）+ INV-27（APPLE_SCRIPT_WHITELIST）同范式。
      if (/process\.env/.test(code)) return false;

      // 必要条件 4：禁 import config / provider-registry / env-reader / ProviderConfig
      //   （顶级 const 不依赖运行时配置；防 LLM 通过 channel 改 env 绕过 stealth）
      if (
        /from\s+["'][^"']*(config\/|provider-registry|env-reader|env-config|loadConfig)/.test(
          code,
        )
      ) {
        return false;
      }

      // 必要条件 5：STEALTH_PROFILES 必须是对象字面量 const（as const satisfies 形式）
      //   接受 `as const` 或 `as const satisfies`，确保编译期固定（防运行时改写）
      if (!/STEALTH_PROFILES\s*=\s*\{[\s\S]*?\}\s*as\s+const/.test(code)) {
        return false;
      }

      // 必要条件 6：至少 3 条 stealth profile（windows_chrome_120 / mac_safari_17 /
      //   linux_firefox_121）—— parse5 §3.3.2 标准三件套
      const profileKeys = [
        ...code.matchAll(/(\w+):\s*\{[^}]*userAgent/g),
      ].map((m) => m[1]);
      if (profileKeys.length < 3) return false;
      const requiredProfiles = [
        "windows_chrome_120",
        "mac_safari_17",
        "linux_firefox_121",
      ];
      for (const rp of requiredProfiles) {
        if (!profileKeys.includes(rp)) return false;
      }

      // 必要条件 7：STEALTH_INJECTION_SCRIPT 必须含反检测关键 hook（webdriver / languages）
      //   这是 stealth 注入的核心 —— 缺这两个 = 反检测失效
      if (!/webdriver/.test(code) || !/languages/.test(code)) return false;

      return true;
    },
  },
  // ============================================================
  // v0.5 M0.5a 新增（parse6 §1.5 + §7.2 —— fetch_url SSRF + 连接池守门）
  // ============================================================
  {
    id: "INV-31-fetch-url-via-ssrf-guard",
    desc: "v0.5 M0.5a：fetch_url tool handler 必经 ssrfGuard（INV-31；URL 进入 fetch 前必须 grep 到 ssrfGuard 调用）",
    check: () => {
      // 必要条件 1：fetch-url.ts 存在（v0.5 起必须）
      const fu = SRC.find((s) =>
        /tools\/fetch-url\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!fu) return false; // v0.5 起必须存在

      // 必要条件 2：import ssrfGuard（与 browse.ts 同源；不在 fetch-url.ts 内重造第二套）
      if (!/from\s+["'][^"']*ssrf\/ssrf-guard(\.js)?["']/.test(fu.text)) {
        return false;
      }

      // 必要条件 3：代码本体（去注释）必须调用 ssrfGuard（不只是注释提及）
      const code = stripComments(fu.text);
      // 接受 `ssrfGuard(` 或 `ssrfGuard<空格>(` 形式；与 browse.ts 第 125/161 行同范式
      if (!/\bssrfGuard\s*\(/.test(code)) return false;

      // 必要条件 4：ssrfGuard 调用必须出现在 fetch 调用之前（顺序断言）
      // 找 ssrfGuard( 的首个位置 + httpClient.fetch / acquireHttpClient.fetch 的位置
      const ssrfIdx = code.search(/\bssrfGuard\s*\(/);
      const fetchIdx = code.search(/httpClient\.fetch\s*\(/);
      if (ssrfIdx === -1 || fetchIdx === -1) return false;
      if (ssrfIdx >= fetchIdx) return false; // SSRF 必须在 fetch 前

      // 必要条件 5：禁直接 import 私网 CIDR 表 / 绕过 ssrfGuard 自造判定
      //   （不允许 fetch-url.ts 直接用 cidrContains / isPrivateIp 自造守门）
      if (/\bcidrContains\s*\(|\bisPrivateIp\s*\(/.test(code)) return false;

      return true;
    },
  },
  {
    id: "INV-32-fetch-url-via-acquire-http-client",
    desc: "v0.5 M0.5a：fetch_url 必经 SubprocessManager.acquireHttpClient（禁 new Agent / 禁裸 global.fetch / 禁新造连接池；守 v0.2 连接池单一真源）",
    check: () => {
      const fu = SRC.find((s) =>
        /tools\/fetch-url\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!fu) return false; // v0.5 起必须存在
      const code = stripComments(fu.text);

      // 必要条件 1：必须调 subproc.acquireHttpClient / SubprocessManager.acquireHttpClient
      //   （grep acquireHttpClient( 调用形式）
      if (!/\.acquireHttpClient\s*\(/.test(code)) return false;

      // 必要条件 2：禁 new Agent( （v0.2 连接池单一真源；类比 INV-4 单一 FallbackDecider）
      //   注：SubprocessManager.ts 内部 new Agent 是允许的（那是连接池内部实装），
      //   本断言只针对 tools/fetch-url.ts（fetch_url 工具层不能自造 Agent）
      if (/\bnew\s+Agent\s*\(/.test(code)) return false;

      // 必要条件 3：禁裸 global.fetch（即 fetch( 直接调用，不经 httpClient）
      //   fetch_url 必须经 httpClient.fetch（acquireHttpClient 返的注入版）。
      //   注意：stripComments 后还含 import 语句里的 fetch 不会被匹配；
      //   `httpClient.fetch(` 不会被误中（前面带 `httpClient.`）。
      //   精确匹配 `fetch(` 前面不带 `httpClient.` / `client.` 等限定符 = 裸 fetch。
      //   用负向断言：`\b(?<!\.)fetch\s*\(` —— 前面不是点。
      //   JS Node 20+ 支持 lookbehind。
      //   但要排除 `typeof fetch`（类型引用）和注释里的代码片段。
      //   做法：先排除合法的 httpClient.fetch，再看是否有剩余裸 fetch(
      const withoutHttpClientFetch = code.replace(/httpClient\.fetch\s*\(/g, "");
      if (/(?<![.\w])fetch\s*\(/.test(withoutHttpClientFetch)) return false;

      // 必要条件 4：禁 new undici.Pool / new ProxyAgent / new EnvHttpProxyAgent 等其他连接池形态
      if (/\bnew\s+(Pool|ProxyAgent|EnvHttpProxyAgent|Agent)\s*\(/.test(code)) {
        return false;
      }

      // 必要条件 5：fetch 调用必须经 httpClient（确认连接池路径落地）
      if (!/httpClient\.fetch\s*\(/.test(code)) return false;

      return true;
    },
  },
  // ============================================================
  // v0.5 M0.5b 新增（parse6 §1.5 + §3.3 + §4.4 —— pdf/console actionDispatch +
  //                  screenshot/pdf 二进制 envelope）
  // ============================================================
  {
    id: "INV-33-pdf-console-in-dispatch-map",
    desc: "v0.5 M0.5b/M0.5c：pdf + console + network 三 action 必须以 entry 形式在 BrowseChannel.actionDispatch Map（INV-6 衍生：禁新造第二个 dispatch Map；独立工具经 headless.browse(url, action, opts) 入口）",
    check: () => {
      // 必要条件 1：BrowseChannel.ts 存在（v0.1 起必须）
      const bc = SRC.find((s) =>
        /channels\/BrowseChannel\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!bc) return false;
      const code = stripComments(bc.text);

      // 必要条件 2：actionDispatch Map 字面量内必须含 ["pdf", ...] + ["console", ...] + ["network", ...] 三 entry
      //   抽 actionDispatch = new Map([ ... ]) 块，验块内含三个 entry
      const mapMatch = code.match(
        /actionDispatch\s*=\s*new\s+Map\s*<[^>]*>\s*\(\s*\[([\s\S]*?)\]\s*\)/,
      );
      if (!mapMatch) return false;
      const mapBody = mapMatch[1];
      // 必须含 ["pdf", ...] entry（doPdf 引用）
      const hasPdfEntry = /\[\s*["']pdf["']\s*,/.test(mapBody);
      // 必须含 ["console", ...] entry（doConsole 引用）
      const hasConsoleEntry = /\[\s*["']console["']\s*,/.test(mapBody);
      // 必须含 ["network", ...] entry（doNetwork 引用；v0.5 M0.5c 新加）
      const hasNetworkEntry = /\[\s*["']network["']\s*,/.test(mapBody);
      if (!hasPdfEntry || !hasConsoleEntry || !hasNetworkEntry) return false;

      // 必要条件 3：BrowseChannel.ts 必须 import doPdf + doConsole + doNetwork from cdp-actions
      //   （grep import 语句；守「上游工具名集中 cdp-actions.ts」决策 parse6 §4.4）
      if (!/from\s+["'][^"']*cdp-actions(\.js)?["']/.test(code)) return false;
      // import 语句必须含 doPdf + doConsole + doNetwork 标识符
      const importMatch = code.match(
        /import\s+\{([^}]+)\}\s+from\s+["'][^"']*cdp-actions(\.js)?["']/,
      );
      if (!importMatch) return false;
      const importedNames = importMatch[1];
      if (!/\bdoPdf\b/.test(importedNames)) return false;
      if (!/\bdoConsole\b/.test(importedNames)) return false;
      if (!/\bdoNetwork\b/.test(importedNames)) return false;

      // 必要条件 4：cdp-actions.ts 存在且顶级导出 CDP_UPSTREAM_TOOL_NAMES const
      //   （parse6 §4.4 上游工具名集中表；doctor 探测 cdp_mcp_pdf_tool_available /
      //    cdp_mcp_network_observer_available 读此表）
      const cdpActions = SRC.find((s) =>
        /browse\/cdp-actions\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!cdpActions) return false;
      const cdpCode = stripComments(cdpActions.text);
      if (!/export\s+const\s+CDP_UPSTREAM_TOOL_NAMES\b/.test(cdpCode)) {
        return false;
      }
      // CDP_UPSTREAM_TOOL_NAMES 必须含 pdf + network_log + console_log 三 key
      const cdpConstBlock = cdpCode.match(
        /CDP_UPSTREAM_TOOL_NAMES\s*=\s*Object\.freeze\s*\(\s*\{([\s\S]*?)\}\s*\)/,
      );
      if (!cdpConstBlock) return false;
      const cdpBody = cdpConstBlock[1];
      if (!/\bpdf\s*:/.test(cdpBody)) return false;
      if (!/\bconsole_log\s*:/.test(cdpBody)) return false;
      if (!/\bnetwork_log\s*:/.test(cdpBody)) return false;

      // 必要条件 5：cdp-actions.ts 必须导出 doNetwork 函数（v0.5 M0.5c 新加）
      //   grep `export async function doNetwork`
      if (!/export\s+async\s+function\s+doNetwork\b/.test(cdpCode)) return false;

      return true;
    },
  },
  {
    id: "INV-34-screenshot-pdf-via-envelope-or-writestate",
    desc: "v0.5 M0.5b/M0.5c：screenshot / pdf / network 独立 tool handler 的返回路径必经 applyOutputEnvelope 或经 BrowseChannel.browse 入口（INV-15 衍生到二进制内容；screenshot 经 browse 入口隐式 writeState，pdf 显式 applyOutputEnvelope(text, hint, '.pdf')，network 显式 applyOutputEnvelope(jsonString, hint, '.txt')）",
    check: () => {
      // 必要条件 1：screenshot.ts + pdf.ts + network.ts 都存在（v0.5 M0.5c 起必须）
      const screenshot = SRC.find((s) =>
        /tools\/screenshot\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!screenshot) return false;
      const pdf = SRC.find((s) =>
        /tools\/pdf\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!pdf) return false;
      const network = SRC.find((s) =>
        /tools\/network\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!network) return false;

      const screenshotCode = stripComments(screenshot.text);
      const pdfCode = stripComments(pdf.text);
      const networkCode = stripComments(network.text);

      // 必要条件 2：screenshot.ts 必须经 BrowseChannel.browse 入口（隐式 writeState）
      //   grep headless.browse( 调用形式（与 browse.ts 第 138/141 行同范式）
      //   screenshot 经 channel 入口 → doScreenshot 写盘 + BrowseChannel.browse() writeState
      //   满足 INV-34 「返回路径必经 applyOutputEnvelope 或 writeState」分支（writeState 经 channel 入口）
      if (! /\.browse\s*\(\s*[^,]+,\s*["']screenshot["']/.test(screenshotCode)) {
        return false;
      }

      // 必要条件 3：pdf.ts 必须经 BrowseChannel.browse 入口（同样隐式 writeState）
      if (!/\.browse\s*\(\s*[^,]+,\s*["']pdf["']/.test(pdfCode)) {
        return false;
      }

      // 必要条件 3b：network.ts 必须经 BrowseChannel.browse 入口（同样隐式 writeState；v0.5 M0.5c）
      if (!/\.browse\s*\(\s*[^,]+,\s*["']network["']/.test(networkCode)) {
        return false;
      }

      // 必要条件 4：pdf.ts 必须显式调 applyOutputEnvelope（base64 PDF 字符串过 envelope）
      //   grep applyOutputEnvelope( 调用；必须出现
      if (!/\bapplyOutputEnvelope\s*\(/.test(pdfCode)) return false;

      // 必要条件 4b：network.ts 必须显式调 applyOutputEnvelope（资源列表 JSON 过 envelope；v0.5 M0.5c）
      if (!/\bapplyOutputEnvelope\s*\(/.test(networkCode)) return false;

      // 必要条件 5：pdf.ts 的 applyOutputEnvelope 调用必须传 ".pdf" extension（第 3 参数）
      //   守 INV-15 衍生 INV-34：spill 文件 .pdf 后缀 + mode 0o600（INV-15 由 output-envelope.ts 守）
      //   精确匹配 applyOutputEnvelope(..., ..., ".pdf") 形式（含三参数）
      //   允许多行；用 [\s\S] 非贪婪匹配两参数到 ".pdf"
      const envelopeCallMatches = [
        ...pdfCode.matchAll(/applyOutputEnvelope\s*\(/g),
      ];
      if (envelopeCallMatches.length === 0) return false;
      // 至少一处调用传 ".pdf" extension
      let foundPdfExtension = false;
      for (const m of envelopeCallMatches) {
        // 从调用起点向后扫 ≤600 字符，找 ".pdf" 是否在该调用范围内
        const start = m.index ?? 0;
        const window = pdfCode.slice(start, start + 600);
        if (/\.pdf\b/.test(window)) {
          foundPdfExtension = true;
          break;
        }
      }
      if (!foundPdfExtension) return false;

      // 必要条件 6：screenshot.ts + pdf.ts + network.ts 都必须 import ssrfGuard（守 INV-31 衍生：
      //               独立工具也必经 SSRF；与 browse_headless 同函数）
      if (!/from\s+["'][^"']*ssrf\/ssrf-guard(\.js)?["']/.test(screenshotCode)) {
        return false;
      }
      if (!/from\s+["'][^"']*ssrf\/ssrf-guard(\.js)?["']/.test(pdfCode)) {
        return false;
      }
      if (!/from\s+["'][^"']*ssrf\/ssrf-guard(\.js)?["']/.test(networkCode)) {
        return false;
      }
      // 都必须显式调 ssrfGuard（不只是 import）
      if (!/\bssrfGuard\s*\(/.test(screenshotCode)) return false;
      if (!/\bssrfGuard\s*\(/.test(pdfCode)) return false;
      if (!/\bssrfGuard\s*\(/.test(networkCode)) return false;

      return true;
    },
  },
  // ============================================================
  // v0.6 Phase A 新增（parse7 §1.3 + §5.1 + task INV-35..40 重新编号版）
  // ============================================================
  // task 版本 INV-35..40 语义：
  //  INV-35  runtime/ 不 import BrowseChannel/DesktopChannel internal（类比 INV-26 forest 调度层）
  //  INV-36  CapabilityBag 只在已注册集合上 enable/disable（不凭空造 channel）
  //  INV-37  channel disable 必经 ToolManager（tool.disable() + SDK 自动 sendToolListChanged）
  //  INV-38  caller-tier cap 是模块顶级 const 默认值（LASSO_CALLER_CAP_DEFAULT env 可覆盖；禁魔法数）
  //  INV-39  SubprocessManager.shutdownOne 只 kill 单 spec（不动 shutdown() 全停语义）
  //  INV-40  hot-reload 新 provider 必经 provider-registry.add（不直接写 BUILTIN_PROVIDERS）
  {
    id: "INV-35-runtime-no-channel-internal-import",
    desc: "v0.6 Phase A：runtime 调度层（src/runtime/*.ts）不 import BrowseChannel/DesktopChannel internal 模块（R-CI-02 守护；类比 INV-26 forest 调度层）",
    check: () => {
      // src/runtime/ 下任何 .ts 文件代码本体（去注释）禁 import 自：
      //   ../channels/*.js  ../browse/*.js  ../desktop/*.js  ../subprocess/*.js
      //   ../fallback/*.js  ../serp/*.js  ../search/*.js  ../config/*.js
      //   ../ssrf/*.js  ../tools/*.js  ../doctor/*.js  ../forest/*.js
      //
      // 允许的 import：
      //   ../types.js                  （共享类型；不持 channel 句柄）
      //   ../util/logger.js            （日志；runtime/ 必需）
      //   ./runtime-types.js           （同层 runtime 类型）
      //   @modelcontextprotocol/sdk/*  （SDK RegisteredTool / McpServer 类型）
      //   同层 ./CapabilityBag.js / ./ToolManager.js / ./CallerTierTracker.js / ./hot-reload.js
      //
      // 例外：runtime/hot-reload.ts 必须 import ../config/provider-registry.js（registry.add 入口）；
      //       这是 INV-40 的要求（hot-reload 必经 registry.add）；故将 config/provider-registry
      //       单独白名单（task §8 显式列 provider-registry 为 surgical 修改对象，runtime 可引用）。
      const FORBIDDEN_RUNTIME_IMPORTS =
        /from\s+["']\.\.\/(channels|browse|desktop|subprocess|fallback|serp|search|ssrf|tools|doctor|forest|invariants)\/[^"']*["']/;
      const FORBIDDEN_CONFIG_NOT_REGISTRY =
        /from\s+["']\.\.\/config\/(?!provider-registry)[^"']*["']/;
      const runtimeFiles = SRC.filter((s) =>
        /^runtime\//.test(s.f.replace(/\\/g, "/")),
      );
      if (runtimeFiles.length === 0) return false; // v0.6 Phase A 起必须有 runtime 文件
      return runtimeFiles.every((s) => {
        const codeOnly = stripComments(s.text);
        if (FORBIDDEN_RUNTIME_IMPORTS.test(codeOnly)) return false;
        if (FORBIDDEN_CONFIG_NOT_REGISTRY.test(codeOnly)) return false;
        return true;
      });
    },
  },
  {
    id: "INV-36-capability-bag-only-on-registered",
    desc: "v0.6 Phase A：CapabilityBag 只能在已 register 集合上 enable/disable，不凭空造 channel（task 版本 INV-36；parse7 §3.1 + §1.3 INV-9 衍生）",
    check: () => {
      const bag = SRC.find((s) =>
        /runtime\/CapabilityBag\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!bag) return false; // v0.6 Phase A 起必须存在
      const code = stripComments(bag.text);

      // 必要条件 1：class CapabilityBag 定义存在
      if (!/class\s+CapabilityBag\b/.test(code)) return false;

      // 必要条件 2：disable 方法必须做存在性检查（this.state.get(name) + early return）
      //   抽 disable( 方法的函数体，验块内有 this.state.get(name) 检查 + 早返 false
      const disableBody = code.match(
        /async\s+disable\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{2}\}\n/s,
      )?.[1] ?? "";
      if (!disableBody) return false;
      const disableHasExistenceCheck =
        /this\.state\.get\s*\(\s*name\s*\)/.test(disableBody) &&
        /return\s+false/.test(disableBody);
      if (!disableHasExistenceCheck) return false;
      // 必要条件 2b：disable 必须显式判定未注册名返 false（grep "if (!s" 或 "|| !s"）
      //   防止 disable 在未知名上"造"出 CapabilityState
      if (!/if\s*\(\s*!s\b/.test(disableBody)) return false;

      // 必要条件 3：enable 方法同范式（存在性检查 + early return）
      const enableBody = code.match(
        /async\s+enable\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{2}\}\n/s,
      )?.[1] ?? "";
      if (!enableBody) return false;
      const enableHasExistenceCheck =
        /this\.state\.get\s*\(\s*name\s*\)/.test(enableBody) &&
        /return\s+false/.test(enableBody);
      if (!enableHasExistenceCheck) return false;
      if (!/if\s*\(\s*!s\b/.test(enableBody)) return false;

      // 必要条件 4：register 方法是 bag 新 entry 的唯一入口（grep `register(` 方法签名）
      //   register 幂等：if (this.state.has(name)) return;
      const registerBody = code.match(
        /\n\s+register\s*\(\s*name\s*:\s*string\s*\)[^{]*\{([\s\S]*?)\n\s{2}\}\n/s,
      )?.[1] ?? "";
      if (!registerBody) return false;
      if (!/this\.state\.has\s*\(\s*name\s*\)/.test(registerBody)) return false;

      return true;
    },
  },
  {
    id: "INV-37-channel-disable-via-tool-manager",
    desc: "v0.6 Phase A：channel disable 必经 ToolManager.disableChannel（tool.disable() + SDK 自动 sendToolListChanged）；runtime/ 内禁直接 server.tool 操作绕过 ToolManager",
    check: () => {
      // 必要条件 1：ToolManager.ts 存在
      const tm = SRC.find((s) =>
        /runtime\/ToolManager\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!tm) return false; // v0.6 Phase A 起必须存在
      const tmCode = stripComments(tm.text);

      // 必要条件 2：ToolManager class + disableChannel 方法 + 调 rec.registered.disable()
      if (!/class\s+ToolManager\b/.test(tmCode)) return false;
      if (!/async\s+disableChannel\s*\(/.test(tmCode)) return false;
      // disableChannel 体内必须出现 rec.registered.disable()（grep）
      const disableChBody = tmCode.match(
        /async\s+disableChannel\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{2}\}\n/s,
      )?.[1] ?? "";
      if (!disableChBody) return false;
      if (!/\.registered\.disable\s*\(\s*\)/.test(disableChBody)) return false;

      // 必要条件 3：enableChannel 也存在 + 调 rec.registered.enable()
      if (!/async\s+enableChannel\s*\(/.test(tmCode)) return false;
      const enableChBody = tmCode.match(
        /async\s+enableChannel\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{2}\}\n/s,
      )?.[1] ?? "";
      if (!enableChBody) return false;
      if (!/\.registered\.enable\s*\(\s*\)/.test(enableChBody)) return false;

      // 必要条件 4：runtime/ 其他文件（非 ToolManager.ts）禁出现 server.tool() 直接调用
      //   （admin tool / hot-plug tool 都必须经 ToolManager.register）
      //   例外：ToolManager.ts 内部允许 server.tool() 调用（register 包装）
      const otherRuntimeFiles = SRC.filter((s) => {
        const path = s.f.replace(/\\/g, "/");
        return /^runtime\//.test(path) && !/runtime\/ToolManager\.ts$/.test(path);
      });
      const hasDirectServerToolLeak = otherRuntimeFiles.some((s) =>
        /\.server\.tool\s*\(/.test(stripComments(s.text)),
      );
      if (hasDirectServerToolLeak) return false;

      // 必要条件 5：runtime/ 其他文件禁直接调 registered.disable() / registered.enable()
      //   绕过 ToolManager（disable/enable 是 ToolManager 独占职责）
      const hasDirectHandleMutationLeak = otherRuntimeFiles.some((s) =>
        /\.registered\.(disable|enable|remove)\s*\(/.test(
          stripComments(s.text),
        ),
      );
      if (hasDirectHandleMutationLeak) return false;

      return true;
    },
  },
  {
    id: "INV-38-caller-tier-cap-top-level-const",
    desc: "v0.6 Phase A：caller-tier cap 是模块顶级 const（LASSO_CALLER_CAP_DEFAULT env 可覆盖；禁魔法数 100 散落在调用点；R-CI-02 守护：复用 QuotaLedger 滑动窗范式）",
    check: () => {
      const tracker = SRC.find((s) =>
        /runtime\/CallerTierTracker\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!tracker) return false; // v0.6 Phase A 起必须存在
      const code = stripComments(tracker.text);

      // 必要条件 1：class CallerTierTracker 定义存在
      if (!/class\s+CallerTierTracker\b/.test(code)) return false;

      // 必要条件 2：模块顶级 const DEFAULT_CALLER_CAP（export const，类比 INV-14/27/30 anti-gaming 范式）
      //   必须是 export const（导出便于 index.ts 装配 + 测试断言）
      if (!/export\s+const\s+DEFAULT_CALLER_CAP\b/.test(code)) return false;

      // 必要条件 3：env 覆盖函数 readCallerCapFromEnv 引用 LASSO_CALLER_CAP_DEFAULT
      //   （运行时不读 env；仅构造期/装配期由 index.ts 调一次）
      if (!/LASSO_CALLER_CAP_DEFAULT/.test(code)) return false;
      if (!/export\s+function\s+readCallerCapFromEnv\b/.test(code)) return false;

      // 必要条件 4：复用 QuotaLedger._refreshState 范式（INV-38 task 铁律；R-CI-02）
      //   必须有 windowStart + windowMs 字段 + _refreshWindow 方法
      //   禁 token bucket / GCRA / leaky bucket 关键字
      if (!/windowStart/.test(code)) return false;
      if (!/windowMs/.test(code)) return false;
      if (!/_refreshWindow/.test(code)) return false;
      if (/token_?bucket|GCRA|leaky_?bucket|TokenBucket/i.test(code)) return false;

      // 必要条件 5：tryAcquire 方法签名存在（事前 gate；与 QuotaLedger.pickKey 事后扣对比）
      if (!/tryAcquire\s*\(/.test(code)) return false;

      // 必要条件 6：魔法数 100 不应作为 cap 默认值散落在构造器或 tryAcquire（必须走 DEFAULT_CALLER_CAP）
      //   检查 tryAcquire 体内不出现字面量 100（cap 必须从 defaultCap 字段读）
      const tryAcquireBody = code.match(
        /tryAcquire\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{2}\}\n/s,
      )?.[1] ?? "";
      if (!tryAcquireBody) return false;
      // tryAcquire 体内禁出现字面量 100（必须从 b.cap 或 this.defaultCap 读）
      //   允许 1（cost 默认值）+ 0（Math.max 下界）；禁 100
      if (/\b100\b/.test(tryAcquireBody)) return false;

      return true;
    },
  },
  {
    id: "INV-39-shutdown-one-only-single-spec",
    desc: "v0.6 Phase A：SubprocessManager.shutdownOne 只 kill 单 spec（复用 _kill / _killRust；不调 shutdown 全集；INV-7 仍守：纯 lifecycle）",
    check: () => {
      const sub = SRC.find((s) =>
        s.f.replace(/\\/g, "/").includes("SubprocessManager"),
      );
      if (!sub) return false; // v0.5 起已存在
      const code = stripComments(sub.text);

      // 必要条件 1：shutdownOne 方法定义存在（v0.6 Phase A 新增）
      if (!/async\s+shutdownOne\s*\(\s*name\s*:\s*string\s*\)/.test(code)) {
        return false;
      }

      // 必要条件 2：shutdownOne 方法体必须复用 _kill 或 _killRust（不重造 kill 逻辑）
      //   抽 shutdownOne 方法体（从方法签名到下一个方法签名前）
      const shutdownOneMatch = code.match(
        /async\s+shutdownOne\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{2}\}\n/s,
      );
      if (!shutdownOneMatch) return false;
      const body = shutdownOneMatch[1];
      const callsKill = /this\._kill\s*\(\s*name\s*\)/.test(body) ||
        /this\._killRust\s*\(\s*name\s*\)/.test(body);
      if (!callsKill) return false;

      // 必要条件 3：shutdownOne 方法体内禁调 this.shutdown()（INV-39 红线：单 spec kill 不波及全集）
      if (/this\.shutdown\s*\(\s*\)/.test(body)) return false;

      // 必要条件 4：shutdown() 全停方法仍存在且语义不变（INV-7 守护 + INV-39 对比基线）
      //   shutdown 方法体内必须 still 调 this._kill + this._killRust + clear httpAgents
      const shutdownMatch = code.match(
        /async\s+shutdown\s*\(\s*\)[^{]*\{([\s\S]*?)\n\s{2}\}\n/s,
      );
      if (!shutdownMatch) return false;
      const shutdownBody = shutdownMatch[1];
      if (!/this\._kill\s*\(/.test(shutdownBody)) return false;
      if (!/this\._killRust\s*\(/.test(shutdownBody)) return false;

      return true;
    },
  },
  {
    id: "INV-40-hot-reload-via-registry-add",
    desc: "v0.6 Phase A：hot-reload 新 provider 必经 provider-registry.add（不直接写 BUILTIN_PROVIDERS；registry.add 是唯一热插拔入口）",
    check: () => {
      const hr = SRC.find((s) =>
        /runtime\/hot-reload\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!hr) return false; // v0.6 Phase A 起必须存在
      const code = stripComments(hr.text);

      // 必要条件 1：applyHotReload 函数 + addProvider 函数存在
      if (!/(?:async\s+)?function\s+applyHotReload\b/.test(code) &&
        !/(?:async\s+)?function\s+addProvider\b/.test(code)) {
        return false;
      }

      // 必要条件 2：代码体内必须调 registry.add
      //   （在 applyHotReload 或 addProvider 中任一处出现即可）
      if (!/registry\.add\s*\(/.test(code)) return false;

      // 必要条件 3：代码体内必须调 registry.remove（hot-reload 双向：add + remove）
      //   守 INV-40 完整语义：热卸载必经 registry.remove
      if (!/registry\.remove\s*\(/.test(code)) return false;

      // 必要条件 4：禁直接 mutate BUILTIN_PROVIDERS（INV-40 红线）
      //   hot-reload.ts 不应出现 BUILTIN_PROVIDERS 字面量（v0.5 静态件，运行时不可变）
      if (/BUILTIN_PROVIDERS/.test(code)) return false;

      // 必要条件 5：禁 push 到 configs 数组 / 禁 this.configs.push（绕过 add 直接 mutate）
      //   BUILTIN_PROVIDERS 是 readonly，但若代码尝试 .push() 仍违 INV-40
      if (/\.configs\.push\s*\(/.test(code)) return false;
      if (/\.configs\.splice\s*\(/.test(code)) return false;

      // 必要条件 6：CapabilityBag 联动必须经 bag.register（INV-36 衍生）
      //   新 provider 进入 bag 唯一入口是 register；hot-reload 调 bag.register(c.name)
      if (!/bag\.register\s*\(/.test(code)) return false;

      return true;
    },
  },

  // ============================================================
  // v0.7 Phase A 新增（parse8 §2.2 + §6 + §5.3 —— INV-41..47）
  // ============================================================
  // task 版本 INV-41..47 语义（parse8 §1.3：40 → 47 全绿，v0.6 INV-1..40 一行不改）：
  //  INV-41  长熔断与 CircuitBreaker 并列在 src/fallback/，复用 BreakerState（不开第二套引擎）
  //  INV-42  长熔断 open 必经 CapabilityBag.disable（不绕过 INV-37 task 联动链）
  //  INV-43  指标层进程内：observ/ 禁 prometheus/statsd/dogstatsd 字面量；禁远程遥测
  //  INV-44  MetricsCollector 是 per-channel 维度（record 必带 channel 名）
  //  INV-45  SerpHealthMonitor 禁自动重写 selector 表（保守人工升级）
  //  INV-46  observ 暴露走 admin action-enum（不开新 observability tool）
  //  INV-47  doctor runtime_state 扩 metrics/breakers/serp 子字段（不开第二套 doctor section）
  {
    id: "INV-41-long-breaker-reuses-breaker-state",
    desc: "v0.7：LongCircuitBreaker 与 CircuitBreaker 并列在 src/fallback/，复用 BreakerState 类型不重定义（parse8 §3.1 / §5.3 INV-41；INV-4 单一 fallback 范式衍生）",
    check: () => {
      // 必要条件 1：LongCircuitBreaker.ts 在 src/fallback/（不在 src/observ/ 等第二目录）
      const longBreaker = SRC.find((s) =>
        /fallback\/LongCircuitBreaker\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!longBreaker) return false;

      const code = stripComments(longBreaker.text);

      // 必要条件 2：import BreakerState from CircuitBreaker（复用类型，不重定义）
      if (!/from\s+["']\.\/CircuitBreaker\.js?["']/.test(code)) return false;
      if (!/import\s+type\s+\{\s*BreakerState\s*\}/.test(code)) return false;

      // 必要条件 3：禁 type BreakerState = ... 重定义（grep 反向断言）
      if (/export\s+type\s+BreakerState\b/.test(code)) return false;
      if (/type\s+BreakerState\s*=/.test(code)) return false;

      // 必要条件 4：禁 export class CircuitBreaker（不在同文件重定义短熔断）
      if (/export\s+class\s+CircuitBreaker\b/.test(code)) return false;

      // 必要条件 5：export class LongCircuitBreaker 存在（确认是真正的新类）
      if (!/export\s+class\s+LongCircuitBreaker\b/.test(code)) return false;

      // 必要条件 6：src/observ/ 全树禁 CircuitBreaker 类定义（守 INV-4 单一 fallback 引擎）
      const observBreaker = SRC.find((s) =>
        /observ\/.*\.ts$/.test(s.f.replace(/\\/g, "/")) &&
        /export\s+class\s+\w*[Cc]ircuitBreaker\b/.test(stripComments(s.text)),
      );
      if (observBreaker) return false;

      return true;
    },
  },
  {
    id: "INV-42-long-breaker-open-via-capability-bag-disable",
    desc: "v0.7：长熔断 open 必经 CapabilityBag.disable（经 onOpen 回调；不绕过 INV-37 task 链：bag.disable → onChange → toolManager.disableChannel + subproc.shutdownOne）",
    check: () => {
      // 必要条件 1：LongCircuitBreaker 支持 onOpen 回调（构造器第 4 参 + recordFailure 内调）
      const longBreaker = SRC.find((s) =>
        /fallback\/LongCircuitBreaker\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!longBreaker) return false;
      const lbCode = stripComments(longBreaker.text);
      if (!/onOpen/.test(lbCode)) return false;
      if (!/_safeOnOpen|await\s+this\.onOpen/.test(lbCode)) return false;

      // 必要条件 2：装配层（index.ts）grep new LongCircuitBreaker 实例化
      const index = SRC.find((s) =>
        /(^|\/)index\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!index) return false;
      const indexCode = stripComments(index.text);

      // 必要条件 3：装配层存在 new LongCircuitBreaker 实例化
      if (!/new\s+LongCircuitBreaker\b/.test(indexCode)) return false;

      // 必要条件 4：装配层的 onOpen 回调体内必调 bag.disable（INV-42 红线）
      //   容忍 callers 多种命名（disable / bag.disable / disable(name, ...)），
      //   但必须出现在 new LongCircuitBreaker 同一文件内 + 与 disable 字面量共现。
      if (!/bag\.disable\s*\(/.test(indexCode)) return false;

      // 必要条件 5：装配层 long_circuit_open reason 字面量（守 INV-37 task audit 链一致）
      if (!/long_circuit_open/.test(indexCode)) return false;

      return true;
    },
  },
  {
    id: "INV-43-observ-in-process-no-remote-telemetry",
    desc: "v0.7：指标层进程内 —— src/observ/ 全树禁 prometheus/statsd/dogstatsd/prom-client 字面量；禁 fetch/http 远程导出（parse8 §3.2 / §5.3 INV-43；08 §5.1 隐私 + 09 §2.8 非目标）",
    check: () => {
      const observFiles = SRC.filter((s) =>
        /observ\//.test(s.f.replace(/\\/g, "/")),
      );
      if (observFiles.length === 0) return false; // v0.7 起必有 observ/ 目录

      for (const s of observFiles) {
        const code = stripComments(s.text);
        // 禁 Prometheus / statsd / dogstatsd / prom-client 字面量（在代码或字符串中）
        if (/prom-client|prometheus|statsd|dogstatsd|opentelemetry/.test(code)) {
          return false;
        }
        // 禁 import node:http / node:https / undici / node:fetch（远程遥测红线）
        if (/import\s+.*from\s+["']node:https?["']/.test(code)) return false;
        if (/import\s+.*from\s+["']undici["']/.test(code)) return false;
        // 禁裸 fetch() 调用（globalThis.fetch 远程导出红线）
        if (/\bfetch\s*\(/.test(code)) return false;
      }
      return true;
    },
  },
  {
    id: "INV-44-metrics-collector-per-channel-dimension",
    desc: "v0.7：MetricsCollector 是 per-channel 维度 —— record() 必带 channel 名参数（parse8 §3.2 / §5.3 INV-44）",
    check: () => {
      const mc = SRC.find((s) =>
        /observ\/MetricsCollector\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!mc) return false;
      const code = stripComments(mc.text);

      // 必要条件 1：record( 方法签名首参必为 channel: string（强类型）
      if (!/record\s*\(\s*channel\s*:\s*string\b/.test(code)) return false;

      // 必要条件 2：内部 Map 以 channel 为 key（per-channel 独立 RingBuffer）
      if (!/windows\s*=\s*new\s+Map\b/.test(code)) return false;
      if (!/windows\.get\s*\(\s*channel\s*\)/.test(code)) return false;

      // 必要条件 3：snapshot 返数组每条带 channel 字段（doctor/admin 显示用）
      if (!/channel:\s*\w+/.test(code)) return false;

      // 必要条件 4：禁 record() 无 channel 重载（保守：禁 record(): void / record(optional)）
      //   record 必须强制带 channel，不能 record() / record(undefined)
      if (/record\s*\(\s*\)/.test(code)) return false;

      return true;
    },
  },
  {
    id: "INV-45-serp-health-monitor-no-selector-rewrite",
    desc: "v0.7：SerpHealthMonitor 禁自动重写 selector 表（保守人工升级；parse8 §3.4 / §5.3 INV-45；08 §3.8「SERP 是债不是资产」）",
    check: () => {
      const shm = SRC.find((s) =>
        /serp\/SerpHealthMonitor\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!shm) return false;
      const code = stripComments(shm.text);

      // 必要条件 1：禁 selector 表写入操作（保守人工升级红线）
      //   覆盖 SelectorRegistry 内潜在的 mutator 名 + 通用 set/upgrade 命名
      const forbiddenMutators =
        /setSelectors|updateSelectors|upgradeVersion|rewriteSelector|recordHit.*v\d|replaceSelectors|deleteSelectors|mutateSelectors/;
      if (forbiddenMutators.test(code)) return false;

      // 必要条件 2：禁直接 mutate registry 内部 sets（grep .sets.set / .sets.delete）
      if (/\.sets\.set\s*\(/.test(code)) return false;
      if (/\.sets\.delete\s*\(/.test(code)) return false;

      // 必要条件 3：仅允许 registry.recordHit / recordMiss / hitRate / get / engines（只读 API）
      //   上面已禁 set*；正向断言：必须出现 recordHit / recordMiss 调用（确认主路径接入）
      if (!/registry\.record(Hit|Miss)/.test(code)) return false;

      // 必要条件 4：改版确认后只 logger.warn + recordings.save（INV-45 红线：禁自动升级）
      if (!/logger\.warn/.test(code)) return false;
      if (!/recordings\.save/.test(code)) return false;

      return true;
    },
  },
  {
    id: "INV-46-observ-via-admin-action-enum-no-new-tool",
    desc: "v0.7：observ 暴露走 admin action-enum（不开新 observability tool；metrics_snapshot / breaker_status / serp_health 在 admin.ts；parse8 §3.5 / §5.3 INV-46）",
    check: () => {
      // 必要条件 1：admin.ts 含 3 个 observ action（schema enum + handler case）
      const admin = SRC.find((s) =>
        /tools\/admin\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!admin) return false;
      const adminCode = stripComments(admin.text);
      for (const act of ["metrics_snapshot", "breaker_status", "serp_health"]) {
        // 字面量必须出现至少 2 次（schema enum + handler case）
        const re = new RegExp(`["']${act}["']`, "g");
        const matches = adminCode.match(re) || [];
        if (matches.length < 2) return false;
      }

      // 必要条件 2：runtime-types.ts AdminAction union 含 3 个 observ action
      const rt = SRC.find((s) =>
        /runtime\/runtime-types\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!rt) return false;
      const rtCode = stripComments(rt.text);
      for (const act of ["metrics_snapshot", "breaker_status", "serp_health"]) {
        if (!new RegExp(`["']${act}["']`).test(rtCode)) return false;
      }

      // 必要条件 3：禁注册 observability 独立 tool（grep registerObserv / observ_tool）
      //   允许出现在注释里（stripComments 已剥），所以这里 SRC 全扫
      for (const s of SRC) {
        const c = stripComments(s.text);
        if (/registerObserv(?:ability)?Tool\b|registerMetricsTool\b|registerBreakerTool\b/.test(c)) {
          return false;
        }
      }

      // 必要条件 4：admin.ts 注入 observ 数据源（AdminToolDeps 含 metrics / serpHealth / breakers）
      if (!/metrics\?\s*:\s*MetricsCollector/.test(adminCode)) return false;
      if (!/longBreakers\?\s*:\s*Map<string,\s*LongCircuitBreaker>/.test(adminCode)) return false;
      if (!/serpHealth\?\s*:\s*SerpHealthMonitor/.test(adminCode)) return false;

      return true;
    },
  },
  {
    id: "INV-47-doctor-runtime-state-observ-subfields",
    desc: "v0.7：doctor runtime_state section 扩 metrics / breakers / serp_health 子字段（不开第二套 doctor section；parse8 §3.5 / §5.3 INV-47）",
    check: () => {
      const doctor = SRC.find((s) =>
        /doctor\/doctor\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!doctor) return false;
      const code = stripComments(doctor.text);

      // 必要条件 1：runtime_state 类型定义含 metrics / breakers / serp_health 三子字段
      if (!/metrics\?\s*:/.test(code)) return false;
      if (!/breakers\?\s*:/.test(code)) return false;
      if (!/serp_health\?\s*:/.test(code)) return false;

      // 必要条件 2：禁开新 doctor 顶级 section（grep forbid new sections）
      //   守 INV-4 衍生：doctor 报告 shape 不扩新顶级 key（除既有 checks/blockers/runtime_state 等）
      //   允许的顶级 key（v0.5 既有）：ready / timestamp / lasso_version / checks / blockers / runtime_state
      //   禁：observability_state / metrics_state 等新顶级 section
      if (/observability_state\s*:/.test(code)) return false;
      if (/metrics_state\s*:/.test(code)) return false;
      if (/breaker_state\s*:/.test(code)) return false;
      if (/serp_state\s*:/.test(code)) return false;

      // 必要条件 3：observ 子字段经 runtimeState provider 注入（不开新 doctorOpts 顶级 provider）
      //   允许：runtimeState provider 返对象含 metrics/breakers/serp_health
      //   禁：metricsState / breakerState / serpState 等独立 provider
      if (/metricsState\s*\??\s*:/.test(code)) return false;
      if (/breakerState\s*\??\s*:/.test(code)) return false;
      if (/serpState\s*\??\s*:/.test(code)) return false;

      return true;
    },
  },

  // ============================================================
  // v0.8 Phase A 新增（parse9 §2.2 + §1.3 隐私红线 —— INV-48..53）
  // ============================================================
  // parse9 §1.3 隐私红线（cookie=身份/session token）：
  //  INV-48  cookie 落盘必经 AES-256-GCM 加密（src/logged-in/CookieStore.ts 用
  //          createCipheriv aes-256-gcm；明文 cookie 永不直接写盘）
  //  INV-49  加密包文件 mode 0o600 + 目录 mode 0o700（INV-15 范式衍生）
  //  INV-50  tab LRU ≤10 hard cap（src/logged-in/TabRegistry.ts 有 hard cap 常量 + clamp）
  //  INV-51  master key 禁硬编码 + doctor 永不清读 cookie 内容（只 stat 加密包元数据）
  //  INV-52  cookie export/import 必经 admin opt-in（LoggedInChannel 自动路径不调）
  //  INV-53  IV 每次加密唯一（crypto.randomBytes(12)，不重用 / 不硬编码 / 不从 counter 派生）
  {
    id: "INV-48-cookie-store-aes-256-gcm",
    desc: "v0.8 Phase A：cookie 落盘必经 AES-256-GCM（src/logged-in/CookieStore.ts 用 createCipheriv aes-256-gcm + setAuthTag 验签；明文 cookie 永不直接写盘；parse9 §3.1 + §1.3 INV-48）",
    check: () => {
      const cs = SRC.find((s) =>
        /logged-in\/CookieStore\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!cs) return false; // v0.8 起必须存在
      const code = stripComments(cs.text);

      // 必要条件 1：加密用 createCipheriv("aes-256-gcm", ...)
      if (!/createCipheriv\s*\(\s*["']aes-256-gcm["']/.test(code)) return false;
      // 必要条件 2：解密用 createDecipheriv("aes-256-gcm", ...)
      if (!/createDecipheriv\s*\(\s*["']aes-256-gcm["']/.test(code)) return false;
      // 必要条件 3：加密端 getAuthTag（写出 tag）
      if (!/\.getAuthTag\s*\(\s*\)/.test(code)) return false;
      // 必要条件 4：解密端 setAuthTag（验签；防篡改红线）
      if (!/\.setAuthTag\s*\(/.test(code)) return false;

      // 必要条件 5：writeFileSync 写盘的内容是加密 buffer（buf），不是明文（plaintext）
      //   抽所有 writeFileSync(...) 调用的第二参数变量名，必须全是 `buf`
      //   守「明文 cookie 永不出现在磁盘」红线（INV-48 + INV-52 同源）
      const writeCalls = [
        ...code.matchAll(/writeFileSync\s*\(\s*[^,]+,\s*(\w+)/g),
      ];
      if (writeCalls.length === 0) return false;
      const allWriteBuf = writeCalls.every((m) => m[1] === "buf");
      if (!allWriteBuf) return false;

      // 必要条件 6：scryptSync 派生 key（不用裸 masterKey 作 AES key；强度强化）
      if (!/scryptSync\s*\(/.test(code)) return false;

      return true;
    },
  },
  {
    id: "INV-49-cookie-file-mode-0o600",
    desc: "v0.8 Phase A：加密包文件 mode 0o600 + 目录 mode 0o700（src/logged-in/CookieStore.ts；INV-15 范式衍生；parse9 §3.1 + §1.3 INV-49）",
    check: () => {
      const cs = SRC.find((s) =>
        /logged-in\/CookieStore\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!cs) return false;
      const code = stripComments(cs.text);
      // 文件 mode 0o600（加密包文件本体）
      if (!/mode\s*:\s*0o600/.test(code)) return false;
      // 目录 mode 0o700（cookies/ 子目录）
      if (!/mode\s*:\s*0o700/.test(code)) return false;
      // writeFileSync 必须带 mode 0o600（不只 mkdirSync 带 mode）
      const writeWithMode = /writeFileSync\s*\([^)]*mode\s*:\s*0o600/s.test(code);
      if (!writeWithMode) return false;
      // mkdirSync 必须带 mode 0o700
      const mkdirWithMode = /mkdirSync\s*\([^)]*mode\s*:\s*0o700/s.test(code);
      if (!mkdirWithMode) return false;
      return true;
    },
  },
  {
    id: "INV-50-tab-lru-hard-cap",
    desc: "v0.8 Phase A：tab LRU ≤10 hard cap（src/logged-in/TabRegistry.ts 有 hard cap 常量 10 + Math.min/Math.max clamp [1, 20]；parse9 §3.3 + §1.3 INV-50）",
    check: () => {
      const tr = SRC.find((s) =>
        /logged-in\/TabRegistry\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!tr) return false; // v0.8 起必须存在
      const code = stripComments(tr.text);

      // 必要条件 1：默认 cap 常量 = 10（export const TAB_CAP_DEFAULT = 10）
      if (!/TAB_CAP_DEFAULT\s*=\s*10\b/.test(code)) return false;
      // 必要条件 2：clamp 逻辑（Math.min(Math.max(...)）
      if (!/Math\.min\s*\(\s*Math\.max\s*\(/.test(code)) return false;
      // 必要条件 3：LRU 范式（delete + set MRU 提升 + keys().next().value 淘汰）
      if (!/\.keys\s*\(\s*\)\.next\s*\(\s*\)\.value/.test(code)) return false;
      // 必要条件 4：淘汰出口调 close_page（chrome-devtools-mcp 工具）
      if (!/["']close_page["']/.test(code)) return false;
      // 必要条件 5：触达源 list_pages（chrome-devtools-mcp 工具）
      if (!/["']list_pages["']/.test(code)) return false;
      return true;
    },
  },
  {
    id: "INV-51-no-hardcoded-master-key-doctor-stat-only",
    desc: "v0.8 Phase A：master key 禁硬编码 + doctor 永不清读 cookie 内容（keychain.ts 用 randomBytes 生成；doctor.ts 不调 CookieStore.import / getKeychainKey / 不读 cookie 字段；parse9 §1.3 + §3.4 INV-51 红线）",
    check: () => {
      // 必要条件 1：keychain.ts 必须存在（v0.8 起必须）
      const kc = SRC.find((s) =>
        /logged-in\/keychain\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!kc) return false;
      const kcCode = stripComments(kc.text);

      // 必要条件 2：用 randomBytes 生成新 key（不是字面量）
      if (!/randomBytes\s*\(/.test(kcCode)) return false;
      // 必要条件 3：调 macOS security CLI（find-generic-password / add-generic-password）
      if (!/find-generic-password/.test(kcCode)) return false;
      if (!/add-generic-password/.test(kcCode)) return false;

      // 必要条件 4：keychain.ts 禁出现 32+ 字符 base64 字面量（硬编码 key 红线）
      //   接受字母+数字+斜杠+加号 32+ 长度 = 明文 master key 嫌疑
      const suspiciousHardcoded = /["'][A-Za-z0-9+/]{32,}={0,2}["']/.test(kcCode);
      if (suspiciousHardcoded) return false;

      // 必要条件 5：keychain.ts 用 LASSO_COOKIE_PASSPHRASE env fallback（非 darwin 平台）
      if (!/LASSO_COOKIE_PASSPHRASE/.test(kcCode)) return false;

      // 必要条件 6：doctor.ts 永不清读 cookie 内容（INV-51 红线）
      //   禁调 CookieStore.import（解密入口）/ getKeychainKey（master key 接触）
      //   禁调 importCookies / exportCookies（admin opt-in 入口；doctor 不走 admin 路径）
      //   禁访问 cookie 内容字段（.cookies / c.value / session token 字面量）
      const doctor = SRC.find((s) =>
        /doctor\/doctor\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!doctor) return false;
      const docCode = stripComments(doctor.text);
      if (/CookieStore\.import\s*\(|\.importCookies\s*\(/.test(docCode)) return false;
      if (/getKeychainKey\s*\(/.test(docCode)) return false;
      if (/\.exportCookies\s*\(/.test(docCode)) return false;
      // 禁 cookie 内容字段读取（防 doctor 误打印 cookie value）
      if (/\.cookies\b/.test(docCode)) return false;
      if (/\bcookie\.value\b|\bc\.value\b/.test(docCode)) return false;
      // 禁 session token 字面量读取
      if (/session_token\s*:/i.test(docCode)) return false;
      return true;
    },
  },
  {
    id: "INV-52-cookie-export-import-admin-opt-in",
    desc: "v0.8 Phase A：cookie export/import 必经 admin tool 显式 opt-in（LoggedInChannel 自动路径 getMcpClient 不调 CookieStore.export / .export()；parse9 §1.3 + §3.1 INV-52）",
    check: () => {
      // 必要条件 1：LoggedInChannel.ts 必须存在
      const lic = SRC.find((s) =>
        /channels\/LoggedInChannel\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!lic) return false;
      const licCode = stripComments(lic.text);

      // 必要条件 2：getMcpClient 方法体内禁调 CookieStore.export / .export() /
      //   exportCookies / store.export（browse_logged_in 自动路径不落盘 cookie）
      //   抽 getMcpClient 函数体（到下一个方法签名为止）
      const mcpClientBody = licCode.match(
        /getMcpClient\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{2,}\}/,
      )?.[1] ?? "";
      if (mcpClientBody.length === 0) return false;
      // 禁在 getMcpClient 体内调任何 cookie 落盘方法
      const forbiddenInAutoPath =
        /store\.export\s*\(|store\.import\s*\(|this\.exportCookies\s*\(|this\.importCookies\s*\(|new\s+CookieStore\b/.test(
          mcpClientBody,
        );
      if (forbiddenInAutoPath) return false;

      // 必要条件 3：CookieStore.ts 必须存在（v0.8 起必须）
      const cs = SRC.find((s) =>
        /logged-in\/CookieStore\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!cs) return false;

      // 必要条件 4：cookie export 是 CookieStore 实例方法（必经实例化 + 显式调 .export()）
      //   grep `async export(` 方法定义（不允 module-level export 函数绕过实例）
      const csCode = stripComments(cs.text);
      if (!/async\s+export\s*\(/.test(csCode)) return false;
      if (!/async\s+import\s*\(/.test(csCode)) return false;

      return true;
    },
  },
  {
    id: "INV-53-iv-unique-per-encryption",
    desc: "v0.8 Phase A：IV 每次加密唯一（src/logged-in/CookieStore.ts 用 randomBytes(12)；不重用 / 不硬编码 / 不从 counter 派生；parse9 §1.3 + §3.1 INV-53）",
    check: () => {
      const cs = SRC.find((s) =>
        /logged-in\/CookieStore\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!cs) return false;
      const code = stripComments(cs.text);

      // 必要条件 1：必须用 randomBytes(12) 或 randomBytes(IV_LEN)（GCM 标准 96-bit IV）
      //   接受字面量 12 或 IV_LEN 常量（可读性优先；二者等价 12 字节）
      if (!/randomBytes\s*\(\s*(?:12|IV_LEN)\s*\)/.test(code)) return false;
      // 必要条件 2：IV 变量必须由 randomBytes(...) 直接赋值
      //   grep `iv = randomBytes(12|IV_LEN)`（容忍中间空格）
      if (!/iv\s*=\s*randomBytes\s*\(\s*(?:12|IV_LEN)\s*\)/.test(code)) return false;

      // 必要条件 3：IV 禁硬编码（禁 Buffer.from([0,0,...]) 字面量 IV）
      if (/iv\s*=\s*Buffer\.from\s*\(\s*\[/.test(code)) return false;
      // 必要条件 4：IV 禁来自实例字段 / 计数器（防跨调用重用）
      if (/iv\s*=\s*this\./.test(code)) return false;
      if (/iv\s*=\s*\w+\+\+/.test(code)) return false;
      // 必要条件 5：IV 禁来自模块顶级 const（防 LLM 通过 config 注入静态 IV）
      //   精确匹配 `iv = UPPER_SNAKE`（不是函数调用，是常量引用）
      if (/iv\s*=\s*[A-Z_][A-Z0-9_]*\b(?!\s*\()/.test(code)) return false;
      // 必要条件 6：加密用的 IV 必须传给 createCipheriv（绑定到加密路径）
      //   grep createCipheriv 调用块附近出现 iv 变量引用
      if (!/createCipheriv\s*\([^)]*,\s*iv\s*\)/.test(code)) return false;

      return true;
    },
  },

  // ============================================================
  // v0.9 Phase A 新增（parse10 §1 + §3.x + §5 —— INV-54..59 search 兜底层增量）
  // ============================================================
  // parse10 §1 关键设计决策钉死（守简单性 02 §5 R-CI-02 / §5.5 R-ABS-01）：
  //  INV-54  BingChannel 必经 QuotaLedger（INV-10 衍生；grep BingChannel.ts 经 pickKey，禁直读 env）
  //  INV-55  fallback_chain 复用 FallbackDecider（INV-4 衍生；grep FallbackChain.ts 调 runWithFallback，禁自造串行循环）
  //  INV-56  wayback_lookup 经 doFetchUrl + ssrfGuard（INV-31 同源；grep wayback.ts 调 ssrfGuard + doFetchUrl）
  //  INV-57  录制回放必显式 opt-in（grep RecordingStore 检查 LASSO_RECORD_SEARCH env，默认 OFF）
  //  INV-58  禁自动探测死链（grep search 主路径无自动 wayback 调用；wayback 是独立 tool）
  //  INV-59  RecordingStore.save 异步不阻塞（grep saveIfRecording 非 async + 内部不 await）
  {
    id: "INV-54-bing-keys-via-ledger",
    desc: "v0.9 Phase A：BingChannel 禁直接读 process.env.BING_API_KEYS / BING_API_KEY，必须经 QuotaLedger（parse10 §3.1；INV-10 衍生 INV-54）",
    check: () => {
      const bing = SRC.find((s) =>
        /channels\/BingChannel\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!bing) return false; // v0.9 起必须存在
      const code = bing.text;

      // 必要条件 1：禁直接读 process.env.BING_API_KEYS / BING_API_KEY
      if (/process\.env\.BING_API_KEYS|process\.env\.BING_API_KEY/.test(code)) {
        return false;
      }

      // 必要条件 2：必须 import QuotaLedger 类型（与 BraveChannel 同范式）
      if (!/from\s+["'][^"']*config\/quota-ledger(\.js)?["']/.test(code)) {
        return false;
      }

      // 必要条件 3：代码本体（去注释）必须调 ledger.pickKey()（INV-54 真落地）
      const codeStripped = stripComments(code);
      if (!/ledger\.pickKey\s*\(\s*\)/.test(codeStripped)) return false;

      // 必要条件 4：429 路径必须调 ledger.markExhausted（与 BraveChannel 同范式）
      if (!/ledger\.markExhausted\s*\(/.test(codeStripped)) return false;

      // 必要条件 5：providers.ts 必须导出 BING ProviderConfig（INV-54 配套 schema）
      //   grep `const BING: ProviderConfig` 字面量
      const prov = SRC.find((s) =>
        /config\/providers\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!prov) return false;
      if (!/const\s+BING\s*:\s*ProviderConfig/.test(prov.text)) return false;

      // 必要条件 6：BING 必须单独导出，不进 BUILTIN_PROVIDERS（保零回归范式）
      //   BUILTIN_PROVIDERS 数组字面量里禁出现 BING 标识符
      const builtinBlock = prov.text.match(
        /BUILTIN_PROVIDERS[^=]*=\s*\[([\s\S]*?)\]/,
      )?.[1] ?? "";
      if (/\bBING\b/.test(builtinBlock)) return false;

      // 必要条件 7：BING 必须配 policy_risk（parse10 §3.1；watched）
      const bingBlock = prov.text.match(
        /const\s+BING\s*:\s*ProviderConfig\s*=\s*\{([\s\S]*?)\};/,
      )?.[1] ?? "";
      if (!/policy_risk\s*:/.test(bingBlock)) return false;

      return true;
    },
  },
  {
    id: "INV-55-fallback-chain-reuses-decider",
    desc: "v0.9 Phase A：fallback_chain 复用 FallbackDecider.runWithFallback（INV-4 衍生；grep FallbackChain.ts 调 runWithFallback，禁自造串行 fallback 循环）",
    check: () => {
      const fc = SRC.find((s) =>
        /search\/FallbackChain\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!fc) return false; // v0.9 起必须存在
      const code = stripComments(fc.text);

      // 必要条件 1：必须 import FallbackDecider（或 type import）
      if (!/from\s+["'][^"']*fallback\/FallbackDecider(\.js)?["']/.test(code)) {
        return false;
      }

      // 必要条件 2：代码本体必须调 decider.runWithFallback（INV-55 红线）
      //   允许 <T> 泛型：runFallbackChain<T> 传 type-arg 给 runWithFallback<T>(...) 是合法 TS；
      //   regex 允许 runWithFallback 与 ( 之间出现可选的 <...> 泛型实参。
      if (!/decider\.runWithFallback(?:\s*<[^>]*>)?\s*\(/.test(code)) return false;

      // 必要条件 3：禁自造串行 fallback 循环 —— 在 runFallbackChain / runWithFallback 函数体内
      //   不允许 for / while 循环里调 executor / channel.search
      //   做法：抽 async function 体，验体内不出现 `for (...) ... executor(` 或 `while ... executor(`
      //   简化：函数体内出现 `await executor(` 但**不在 for/while 内**才合规；若在循环内则违 INV-55。
      //   这里用更简单的规则：runFallbackChain / 主入口函数体内禁出现 for/while 关键字（仅 plan
      //   构造器 buildFallbackPlan 允许 for-of 遍历 channelNames —— 那是过滤，不是 fallback 执行）。
      //
      //   实现：找出 `export async function runFallbackChain` 函数体，验体内不出现
      //   for / while / executor 关键字组合（若有则视为自造循环）。
      const runChainBody = code.match(
        /export\s+async\s+function\s+runFallbackChain\s*<[^>]*>\s*\(([\s\S]*?)\n\}\n/s,
      )?.[1] ?? "";
      if (runChainBody.length === 0) return false;
      // runFallbackChain 体内禁出现 for / while 循环（INV-55 红线）
      if (/\bfor\s*\(|\bwhile\s*\(/.test(runChainBody)) return false;
      // runFallbackChain 体内禁直接调 executor(...) —— executor 必须经 decider.runWithFallback 调
      // （executor 参数传入 decider，decider 内部循环调；不在本函数体内）
      if (/\bexecutor\s*\(/.test(runChainBody)) return false;

      // 必要条件 4：buildFallbackPlan 是纯函数（返 FallbackPlan；不执行 channel 调用）
      //   grep buildFallbackPlan 函数体内禁出现 executor / await channel.search
      const buildPlanBody = code.match(
        /export\s+async\s+function\s+buildFallbackPlan\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}\n/s,
      )?.[1] ?? "";
      if (buildPlanBody.length === 0) return false;
      // buildFallbackPlan 体内禁出现 channel.search / executor 调用（INV-55 plan 构造器边界）
      if (/\.search\s*\(/.test(buildPlanBody)) return false;
      if (/\bexecutor\s*\(/.test(buildPlanBody)) return false;

      // 必要条件 5：必须导出 DEFAULT_FALLBACK_ORDER 常量（parse10 §1 决策 6 + §3.2）
      if (!/export\s+const\s+DEFAULT_FALLBACK_ORDER\b/.test(code)) return false;
      // DEFAULT_FALLBACK_ORDER 必须含 search.bing 字面量（v0.9 第三源）
      const fallbackOrderBlock = code.match(
        /DEFAULT_FALLBACK_ORDER\s*:[^=]*=\s*\[([\s\S]*?)\]/,
      )?.[1] ?? "";
      if (!/["']search\.bing["']/.test(fallbackOrderBlock)) return false;

      return true;
    },
  },
  {
    id: "INV-56-wayback-via-ssrf-and-dofetch",
    desc: "v0.9 Phase A：wayback_lookup 必经 ssrfGuard + doFetchUrl（INV-31 同源；URL 入 wayback 前必命中 ssrfGuard，禁自造 fetch；parse10 §3.3 INV-56）",
    check: () => {
      const wb = SRC.find((s) =>
        /tools\/wayback\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!wb) return false; // v0.9 起必须存在
      const code = stripComments(wb.text);

      // 必要条件 1：import ssrfGuard（与 fetch-url.ts 同源；不在 wayback.ts 内重造第二套）
      if (!/from\s+["'][^"']*ssrf\/ssrf-guard(\.js)?["']/.test(code)) {
        return false;
      }

      // 必要条件 2：代码本体（去注释）必须调用 ssrfGuard（不只是注释提及）
      if (!/\bssrfGuard\s*\(/.test(code)) return false;

      // 必要条件 3：必须 import doFetchUrl（复用 fetch_url 的 SSRF + 连接池 + bounded output）
      //   允许两种路径风格：
      //     - 跨目录绝对风格："../tools/fetch-url.js" / "src/tools/fetch-url.js"
      //     - 同目录相对风格："./fetch-url.js"（wayback.ts 与 fetch-url.ts 同在 tools/ 下）
      if (!/from\s+["'][^"']*fetch-url(\.js)?["']/.test(code)) {
        return false;
      }
      if (!/import\s+\{\s*doFetchUrl\s*\}/.test(code)) return false;

      // 必要条件 4：代码本体必须调用 doFetchUrl（不在 wayback.ts 内重造 fetch 范式）
      if (!/\bdoFetchUrl\s*\(/.test(code)) return false;

      // 必要条件 5：ssrfGuard 调用必须在 doFetchUrl 调用之前（先守用户 URL，再抓 wayback API）
      //   防御：archive.org 不应成为「把私网 URL 写进第三方日志」的代理。
      const ssrfIdx = code.search(/\bssrfGuard\s*\(/);
      const fetchIdx = code.search(/\bdoFetchUrl\s*\(/);
      if (ssrfIdx === -1 || fetchIdx === -1) return false;
      if (ssrfIdx >= fetchIdx) return false;

      // 必要条件 6：禁直接 new Agent / 禁裸 global.fetch（INV-32 同源；连接池单一真源）
      if (/\bnew\s+Agent\s*\(/.test(code)) return false;
      //   裸 fetch( 调用（前面不带 httpClient. / subproc.）
      const withoutDoFetch = code.replace(/\bdoFetchUrl\s*\(/g, "");
      const withoutMethodFetch = withoutDoFetch.replace(/\.fetch\s*\(/g, "");
      if (/(?<![.\w])fetch\s*\(/.test(withoutMethodFetch)) return false;

      // 必要条件 7：必须注册 wayback_lookup tool（server.tool 调用）
      if (!/server\.tool\s*\(\s*["']wayback_lookup["']/.test(code)) return false;

      // 必要条件 8：结果形状必须含 archived 标记（attributed：archived:true/false）
      //   parse10 §3.3 铁律：wayback tool 返回必带 archived 字段
      if (!/archived\s*:/.test(code)) return false;

      return true;
    },
  },
  {
    id: "INV-57-recording-replay-explicit-opt-in",
    desc: "v0.9 Phase A：录制回放必显式 opt-in（RecordingStore.ts 检查 LASSO_RECORD_SEARCH env，默认 OFF；parse10 §3.4 + §1 决策 5 INV-57）",
    check: () => {
      const rs = SRC.find((s) =>
        /serp\/RecordingStore\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!rs) return false;
      const code = stripComments(rs.text);

      // 必要条件 1：代码本体必须出现 LASSO_RECORD_SEARCH env 字面量（INV-57 grep 红线）
      if (!/LASSO_RECORD_SEARCH/.test(code)) return false;

      // 必要条件 2：必须有 isRecordingEnabled 函数（封装 env 读取；构造期固定）
      if (!/function\s+isRecordingEnabled\b/.test(code)) return false;
      //   isRecordingEnabled 函数体必须读 env.LASSO_RECORD_SEARCH
      const isEnabledBody = code.match(
        /function\s+isRecordingEnabled\s*\([^)]*\)\s*[\s\S]*?\n\}/,
      )?.[0] ?? "";
      if (!/LASSO_RECORD_SEARCH/.test(isEnabledBody)) return false;

      // 必要条件 3：默认值必须是 false（"true" 才开启；其他都 false）
      //   grep "true" 字符串字面量对比（toLowerCase 后严格 === "true"）
      if (!/toLowerCase\s*\(\s*\)\s*===\s*["']true["']/.test(isEnabledBody)) {
        return false;
      }

      // 必要条件 4：RecordingStore 构造器必须根据 isRecordingEnabled 决定 recordingEnabled
      //   （构造期固定，不让 search 主路径每次重新读 env）
      if (!/recordingEnabled/.test(code)) return false;

      // 必要条件 5：必须暴露 saveIfRecording 入口（search 主路径 fire-and-forget 用）
      if (!/saveIfRecording\s*\(/.test(code)) return false;

      // 必要条件 6：saveIfRecording 体内必须在调 save 之前检查 recordingEnabled
      //   守 INV-57：默认 OFF 时 save 根本不触发
      const saveIfBody = code.match(
        /saveIfRecording\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n\s{2}\}/,
      )?.[1] ?? "";
      if (saveIfBody.length === 0) return false;
      if (!/recordingEnabled/.test(saveIfBody)) return false;
      // saveIfRecording 必须是 sync 方法（非 async）—— 守 INV-59
      if (/async\s+saveIfRecording/.test(code)) return false;

      // 必要条件 7：必须有 replay 方法（parse10 §3.4 回放入口）
      if (!/async\s+replay\s*\(/.test(code)) return false;

      return true;
    },
  },
  {
    id: "INV-58-no-auto-dead-link-probe",
    desc: "v0.9 Phase A：禁自动探测死链（search 主路径 tools/search.ts + MultiSourceFanout.ts 不调 wayback；wayback 是独立 tool；parse10 §1 决策 3 + §3.3 INV-58）",
    check: () => {
      // 必要条件 1：wayback_lookup 必须是独立 tool（在 tools/wayback.ts 注册；不在 search 主路径里调）
      //   wayback.ts 存在 + 注册 wayback_lookup tool（INV-56 已查；这里再加一次明确）
      const wb = SRC.find((s) =>
        /tools\/wayback\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!wb) return false;

      // 必要条件 2：search 主路径（tools/search.ts）代码本体禁 import wayback / 禁调 doWaybackLookup
      const search = SRC.find((s) =>
        /tools\/search\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (search) {
        const searchCode = stripComments(search.text);
        // 禁 import from wayback
        if (/from\s+["'][^"']*wayback(\.js)?["']/.test(searchCode)) return false;
        // 禁调 doWaybackLookup / wayback_lookup
        if (/\bdoWaybackLookup\s*\(/.test(searchCode)) return false;
        if (/\bwayback_lookup\b/.test(searchCode)) return false;
      }

      // 必要条件 3：MultiSourceFanout.ts 代码本体禁 import wayback / 禁调 doWaybackLookup
      const fanout = SRC.find((s) =>
        /search\/MultiSourceFanout\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (fanout) {
        const fanoutCode = stripComments(fanout.text);
        if (/from\s+["'][^"']*wayback(\.js)?["']/.test(fanoutCode)) return false;
        if (/\bdoWaybackLookup\s*\(/.test(fanoutCode)) return false;
        if (/\bwayback_lookup\b/.test(fanoutCode)) return false;
      }

      // 必要条件 4：search/MultiSourceFanout.ts 也禁 wayback 引用（同上）
      //   已覆盖

      // 必要条件 5：FallbackChain.ts（v0.9 fallback 引擎入口）也禁自动调 wayback
      //   （fallback_chain 仅在 search surface 内；wayback 是 caller-tier 显式调的独立 tool）
      const fc = SRC.find((s) =>
        /search\/FallbackChain\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (fc) {
        const fcCode = stripComments(fc.text);
        if (/from\s+["'][^"']*wayback(\.js)?["']/.test(fcCode)) return false;
        if (/\bdoWaybackLookup\s*\(/.test(fcCode)) return false;
      }

      // 必要条件 6：BingChannel.ts / BraveChannel.ts 不调 wayback（search 主路径的源层也不自动调）
      for (const f of ["BingChannel", "BraveChannel"]) {
        const ch = SRC.find((s) =>
          new RegExp(`channels/${f}\\.ts$`).test(s.f.replace(/\\/g, "/")),
        );
        if (!ch) continue;
        const chCode = stripComments(ch.text);
        if (/\bdoWaybackLookup\s*\(/.test(chCode)) return false;
      }

      return true;
    },
  },
  {
    id: "INV-59-recording-save-async-non-blocking",
    desc: "v0.9 Phase A：RecordingStore.saveIfRecording 异步不阻塞（saveIfRecording 是 sync void 方法；内部 save 是 fire-and-forget .catch 吞错；search 主路径不 await；parse10 §3.4 + §1 决策 5 INV-59）",
    check: () => {
      const rs = SRC.find((s) =>
        /serp\/RecordingStore\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (!rs) return false;
      const code = stripComments(rs.text);

      // 必要条件 1：saveIfRecording 必须是 sync void 方法（非 async）
      //   INV-59 红线：search 主路径直接调，不 await
      if (/async\s+saveIfRecording/.test(code)) return false;
      // 必须显式标 :void 返回类型（明确「不返 Promise」，防止 caller 误 await）
      if (!/saveIfRecording\s*\([^)]*\)\s*:\s*void/.test(code)) return false;

      // 必要条件 2：saveIfRecording 体内禁出现 await 关键字（fire-and-forget；INV-59 核心）
      const saveIfBody = code.match(
        /saveIfRecording\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n\s{2}\}/,
      )?.[1] ?? "";
      if (saveIfBody.length === 0) return false;
      if (/\bawait\b/.test(saveIfBody)) return false;

      // 必要条件 3：saveIfRecording 必须用 void 前缀 fire-and-forget（明确不 await Promise）
      //   接受 `void this.save(...)` 或 `this.save(...).catch(...)` 不带 await
      if (!/\bvoid\s+this\.save\s*\(/.test(saveIfBody)) return false;

      // 必要条件 4：saveIfRecording 必须挂 .catch 吞错（防 unhandled rejection）
      if (!/\.catch\s*\(/.test(saveIfBody)) return false;

      // 必要条件 5：search 主路径（tools/search.ts）禁直接 await recordingStore.save / saveIfRecording
      //   （saveIfRecording 是 void，本就不能 await，但防误用 await saveIfRecording）
      const search = SRC.find((s) =>
        /tools\/search\.ts$/.test(s.f.replace(/\\/g, "/")),
      );
      if (search) {
        const searchCode = stripComments(search.text);
        // 禁 `await xxx.save(`（仅当 xxx 含 recording 字面量才算违规 —— 其他 save 不算）
        if (/await\s+\w*(recording|recordings)\w*\.save\s*\(/.test(searchCode)) {
          return false;
        }
        // 禁 `await xxx.saveIfRecording(`
        if (/await\s+\w*\.saveIfRecording\s*\(/.test(searchCode)) return false;
      }

      return true;
    },
  },
];

let failed = 0;
for (const a of assertions) {
  let ok;
  try {
    ok = a.check();
  } catch (e) {
    ok = false;
    console.error(`[check-error] ${a.id}: ${e}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${a.id}  —  ${a.desc}`);
  if (!ok) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} invariant(s) FAILED — CI red`);
  process.exit(1);
}
console.log(`\nAll ${assertions.length} invariants passed.`);
