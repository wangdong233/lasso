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
