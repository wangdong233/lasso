#!/usr/bin/env node
/**
 * Lasso 架构不变量检查（parse1 §3.14 + 08 F3.9.8）
 *
 * 8 条铁律：
 *  INV-1 browse 是唯一 browse 入口
 *  INV-2 BaseChannel 不被绕过（所有 XxxChannel 必须 extends）
 *  INV-3 ProviderConfig 单一真源（types.ts）
 *  INV-4 不复用第二套 fallback 范式（FallbackDecider ≤1）
 *  INV-5 MCP ToolAnnotations 完整（每 server.tool 注册文件含 hint 字段）
 *  INV-6 dispatch 走注册表 Map（BrowseChannel.actionDispatch）
 *  INV-7 SubprocessManager 不含协议帧解析
 *  INV-8 fallback 链不跨 surface 类型（v0.1 无 DesktopChannel）
 *
 * Phase A 语义：骨架阶段。对尚未实装的模块（BrowseChannel /
 * SubprocessManager / FallbackDecider），断言取「允许缺失 = 合规」，
 * 等 Phase C-E 实装后这些断言自动收紧（TDD red→green）。
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
