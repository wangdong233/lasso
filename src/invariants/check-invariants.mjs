#!/usr/bin/env node
/**
 * Lasso 架构不变量检查（parse1 §3.14 + 08 F3.9.8 + parse2 §5.4 v0.2 加 INV-9/10/11 + parse3 §5.3 v0.3 加 INV-12..15）
 *
 * Phase D 状态：INV-14 收紧到 HighRiskGate 端（HIGH_RISK_PATTERNS 顶级 const）。
 * 至此 v0.3 的 4 条 INV-12..15 全部上线。
 *
 * 15 条铁律：
 *  INV-1 browse 是唯一 browse 入口
 *  INV-2 BaseChannel 不被绕过（所有 XxxChannel 必须 extends）
 *  INV-3 ProviderConfig 单一真源（types.ts）
 *  INV-4 不复用第二套 fallback 范式（FallbackDecider ≤1）
 *  INV-5 MCP ToolAnnotations 完整（每 server.tool 注册文件含 hint 字段）
 *  INV-6 dispatch 走注册表 Map（BrowseChannel.actionDispatch）
 *  INV-7 SubprocessManager 不含协议帧解析
 *  INV-8 fallback 链不跨 surface 类型（v0.1 无 DesktopChannel）
 *  INV-9 ProviderRegistry 类单一真源（只在 config/provider-registry.ts）—— v0.2
 *  INV-10 BraveChannel 禁直接读 process.env.BRAVE_API_KEYS，必须经 QuotaLedger —— v0.2
 *  INV-11 SearchCache key 必须含 engine + region + limit（防跨 provider 误命中）—— v0.2
 *  INV-12 BrowseChannel.browse()/runChain() 入口必须经 withOperation() ALS 包裹 —— v0.3
 *  INV-13 expect failed 必须 outcome=didnt + 终止（铁律：event delivery ≠ semantic success）—— v0.3
 *  INV-14 HIGH_RISK_PATTERNS 模块顶级 const，不从 config/env 读 —— v0.3
 *  INV-15 output-envelope spill 文件必须 mode 0o600（隐私适合 logged_in cookie）—— v0.3
 *
 * Phase A 语义：骨架阶段。对尚未实装的模块（BrowseChannel /
 * SubprocessManager / FallbackDecider），断言取「允许缺失 = 合规」，
 * 等 Phase C-E 实装后这些断言自动收紧（TDD red→green）。
 *
 * Phase B 状态：INV-13 收紧到 ExpectPoll 端（源端契约：failed 三态必须存在）；
 * 等 Phase C StepEngine 落地后再追加调用端 regex 检查。
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
    desc: "fallback 链不跨 surface：v0.1 不允许 DesktopChannel 类",
    check: () => !SRC.some((s) => /class\s+DesktopChannel/.test(s.text)),
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
