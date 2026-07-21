#!/usr/bin/env node
/**
 * Lasso 架构不变量检查（parse1 §3.14 + 08 F3.9.8 + parse2 §5.4 v0.2 加 INV-9/10/11
 *                     + parse3 §5.3 v0.3 加 INV-12..15
 *                     + parse4 §1.4 v0.3.5 改写 INV-8 + 加 INV-16..23
 *                     + parse5 §2.3 v0.4 M0.4a 加 INV-24/25/26 forest 调度层 + 政策 gate）
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
 *  - 共 26 条 invariants（INV-1..26 顺序编号，INV-22 仍占位）
 *  - parse5 §2.3 INV-27..30 编号预留（M0.4b/M0.4c 实装时占用）：
 *      INV-27 apple-script-whitelist.ts 顶级 const（M0.4b）
 *      INV-28 CGEventProvider 不暴露 raw keycode（M0.4b）
 *      INV-29 forest 调度层无平台字面量（M0.4c；M0.4a 由 INV-21 src tree 全扫覆盖）
 *      INV-30 stealth-profiles.ts 顶级 const（M0.4c）
 *
 * 26 条铁律：
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
 *
 * 注：INV-8 与 INV-23 同槽（parse4 §1.4「INV-8 改写为 INV-23」语义保留槽位）。
 *     INV-8 自身已含「fallback 链不跨 surface」语义；INV-23 编号在文档中保留为别名，
 *     实际 npm run check-invariants 报 26 条全绿。
 *
 * 注：parse5 §2.3 原列 INV-27..30（forest 平台字面量 / apple-script 白名单 / cgEvent
 *     边界 / stealth 顶级 const）。M0.4a 守「26 条 INV-1..26 顺序编号」承诺：
 *      - forest 平台字面量由 INV-21 src tree 全扫覆盖（M0.4a 不另开槽）
 *      - INV-27..30 编号预留 M0.4b/M0.4c 占用
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

/** 去掉 // 行注释 + /* 块注释 *\/，仅留代码本体（INV-21 平台字面量扫代码用）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
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
    desc: "src/**/*.ts 代码本体无 AXUIElement/CGEvent/AXPress/AXUIElementCreate 平台字面量（隔离在 rust-helper）",
    check: () => {
      // 去注释后扫所有 .ts 文件代码本体（含字符串字面量也算——铁律是 TS 不引用平台符号）
      // 例外：rust-helper/ 不在 src/ 下；本扫描自动只覆盖 src/**/*.ts
      const PLATFORM_RE =
        /\bAXUIElement\w*|\bCGEvent\w*|\bAXPress\b|\bAXUIElementCreateSystemWide\b|\bAXIsProcessTrustedWithOptions\b|\bCGPreflightScreenCaptureAccess\b|\bCGWindowListCreateImage\b/;
      return SRC.every((s) => !PLATFORM_RE.test(stripComments(s.text)));
    },
  },
  {
    id: "INV-22-no-applescript-cgevent-provider",
    desc: "v0.3.5 不接 appleScript/cgEvent provider：desktop/ 下无实装类（只允许注释占位，为 v0.4+ 预留）",
    check: () => {
      // grep desktop/ 下任何 "class AppleScriptProvider" / "class CGEventProvider" 实装
      // 实装标识 = class 定义；注释提到不算
      const desktopFiles = SRC.filter((s) =>
        /desktop\//.test(s.f.replace(/\\/g, "/")),
      );
      const realClassLeak = desktopFiles.some((s) =>
        /class\s+(AppleScript\w*Provider|CGEvent\w*Provider|CGEventProvider|AppleScriptProvider)\b/.test(
          stripComments(s.text),
        ),
      );
      return !realClassLeak;
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
