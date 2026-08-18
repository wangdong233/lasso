#!/usr/bin/env node
/**
 * inv-selftest.mjs（v1.11 round1 T13 —— INV mutation 自检制度化：「pin 必须红过一次」）
 *
 * 背景（round1-verdict T13 证据）：check-invariants.mjs 在案注释「mutation 实测曾靠它
 * 假绿」（screenshot_region regex 被字段读取形态骗过）——假绿事故真实发生过。
 * TS SDK behavior-surface-pins 纪律：pin 落地前必须 mutation-check 一次，永不为过
 * CI 放宽 pin。
 *
 * 机制：
 *  1. 基线跑一次 check-invariants（真实树，全绿才继续）
 *  2. 对每个违规样本：cpSync 复制 src 树到临时目录 → 注入已知违规 → 以
 *     LASSO_INV_SRC_ROOT 指向副本复跑 checker → 断言目标 INV 由绿转红
 *  3. 任一 pin 在违规下仍绿 → exit 1 报「假绿 pin」（该 INV 不可证伪 → 应重写）
 *  4. 清理临时副本（工作树零污染；只读临时副本不碰工作树）
 *
 * 纪律（check-invariants.mjs 头注释同步）：
 *  - **新增 INV 必须注册违规样本**（VIOLATION_SAMPLES 加一行）；
 *    写不出违规样本的 INV 本身就是发现（不可证伪 → 应重写）。
 *
 * 运行：npm run inv-selftest   或   npm run check-invariants -- --selftest
 * 依赖：node:* only（守 INV-64 精神——零第三方依赖）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CHECKER = join(REPO_ROOT, "src", "invariants", "check-invariants.mjs");
const SRC_DIR = join(REPO_ROOT, "src");

// ============================================================
// 违规样本注册表（新增 INV 必须在此注册一行；写不出样本 = INV 不可证伪 → 应重写）
// ============================================================
/**
 * 每条样本：
 *  - inv       ：目标 INV id 前缀（匹配 checker 输出的 FAIL 行）
 *  - file      ：src 相对路径（注入目标文件）
 *  - mutation  ：{ append: string } 追加代码 | { replace: [from, to] } 单点替换 |
 *                { replaceAll: [from, to] } 全量替换
 */
const VIOLATION_SAMPLES = [
  {
    inv: "INV-2",
    desc: "无 extends 的具体 Channel 类（绕过 BaseChannel）",
    file: "channels/EvilSelftest.ts",
    mutation: { append: "export class EvilSelftestChannel {\n  x = 1;\n}\n" },
  },
  {
    inv: "INV-3",
    desc: "types.ts 之外定义 ProviderConfig interface（单一真源破坏）",
    file: "config/evil-selftest.ts",
    mutation: { append: "export interface ProviderConfigEvil {\n  x: string;\n}\n" },
  },
  {
    inv: "INV-4",
    desc: "第二个 FallbackDecider class 定义（第二套 fallback 范式）",
    file: "fallback/evil-selftest.ts",
    mutation: { append: "export class FallbackDecider2 {}\n" },
  },
  {
    inv: "INV-7",
    desc: "SubprocessManager 出现 readFrame（协议帧解析下沉违规）",
    file: "subprocess/SubprocessManager.ts",
    mutation: { append: "\nfunction readFrame() {}\n" },
  },
  {
    inv: "INV-11",
    desc: "SearchCache key 丢 freshness 维度（freshness 全量改名）",
    file: "search/SearchCache.ts",
    mutation: { replaceAll: ["freshness", "recencyWindow"] },
  },
  {
    inv: "INV-17",
    desc: "第二次 server.tool('desktop', ...) 注册（拆分工具外再加重复注册）",
    file: "tools/evil-selftest.ts",
    mutation: {
      append:
        'export function registerEvil(server) {\n  server.tool(\n    "desktop",\n    "dup",\n    {},\n    {},\n    async () => ({}),\n  );\n}\n',
    },
  },
  {
    inv: "INV-21",
    desc: "TS 代码本体出现平台字面量（AXPress 字符串）",
    file: "channels/evil-selftest.ts",
    mutation: { append: 'export const __evil = "AXPress";\n' },
  },
  {
    inv: "INV-28",
    desc: "CGEventProvider 不走 cgevent_dispatch（直调路径字面量漂移）",
    file: "desktop/CGEventProvider.ts",
    mutation: { replaceAll: ['"cgevent_dispatch"', '"cgevent_direct_call"'] },
  },
  {
    inv: "INV-33",
    desc: "CDP_UPSTREAM_TOOL_NAMES 丢 console_log key（dispatch Map 契约破坏）",
    file: "browse/cdp-actions.ts",
    mutation: { replace: ["console_log:", "console_log_selftest_removed:"] },
  },
  {
    inv: "INV-63",
    desc: "版本三处不同步（index.ts 版本串改成假值）",
    file: "index.ts",
    // 锚点动态取 package.json 当前版本（版本 bump 后样本不失效）
    mutation: { replace: ["__PKG_VERSION__", "0.0.0-selftest"] },
  },
  {
    // v1.12（round2 T2-14）：INV-79 落地（v1.11）时未注册样本——纪律写入与
    // INV-79 同版本，第一条新 INV 即违反自定纪律。本样本验 (b) 遥测子检查：
    // HeadlessChannel 丢 --no-usage-statistics（1.7.0 默认采集遥测）→ 红。
    inv: "INV-79",
    desc: "HeadlessChannel 丢 --no-usage-statistics（1.7.0 遥测回采）",
    file: "channels/HeadlessChannel.ts",
    mutation: {
      replaceAll: ['"--no-usage-statistics"', '"--usage-statistics-off"'],
    },
  },
  {
    // v1.13（round3 T3-7）：外部契约类三条补样本（round2 T2-14 记档的下一步）。
    // INV-76 (a)：StealthEngine 丢 toFnExpression 包装 → IIFE 语句串直传
    // evaluate_script（上游 0.3.0 起拒收的旧缺陷形态）→ 红。
    inv: "INV-76",
    desc: "STEALTH_INJECTION_SCRIPT 绕过 toFnExpression 包装（上游函数表达式契约破坏）",
    file: "browse/StealthEngine.ts",
    mutation: {
      replaceAll: [
        "toFnExpression(STEALTH_INJECTION_SCRIPT)",
        "STEALTH_INJECTION_SCRIPT",
      ],
    },
  },
  {
    // INV-68 (a)：markdown-extractor.ts 出现第三运行时（spawn/python）→ 红。
    inv: "INV-68",
    desc: "markdown-extractor.ts 引入第三运行时（spawn python 子进程）",
    file: "browse/markdown-extractor.ts",
    mutation: {
      append:
        'export function __evilThirdRuntime() {\n  const cp = spawn("python", ["-c", "pass"]);\n  void cp;\n}\n',
    },
  },
  {
    // INV-71 (b)：loadConfig 丢 file→env 合并（config.json 静默失效）→ 红。
    inv: "INV-71",
    desc: "loadConfig 丢 {...fileEnv,...envSource} 合并（配置文件机制空心化）",
    file: "config/config.ts",
    mutation: {
      replace: ["{ ...fileEnv, ...envSource }", "{ ...envSource }"],
    },
  },
  {
    // v1.15 Phase A：INV-54 改语义为「Bing 死层清除墓碑守卫」——样本验回潮：
    // channels/BingChannel.ts 重建（哪怕最小骨架）→ 墓碑条件 1 红。
    inv: "INV-54",
    desc: "Bing 死层回潮：channels/BingChannel.ts 重建（v1.15 Phase A 墓碑守卫）",
    file: "channels/BingChannel.ts",
    mutation: {
      append: 'export class BingChannel {\n  name = "search.bing";\n}\n',
    },
  },
  {
    // v1.17 Phase D（doc/25 裁决④ B1）：INV-81 (d) 零网络——
    // search-local 模块出现裸 fetch( → 红。
    inv: "INV-81",
    desc: "search-local 模块引入网络调用（fetch 字面量，零网络红线破坏）",
    file: "search-local/mdfind.ts",
    mutation: {
      append:
        'export const __evilNet = fetch("http://evil.invalid/leak");\n',
    },
  },
  {
    // INV-81 (a) 源库禁写：模块出现 writeFileSync → 红。
    inv: "INV-81",
    desc: "search-local 模块出现源路径写 API（writeFileSync 回潮）",
    file: "search-local/chrome-history.ts",
    mutation: {
      append:
        'export function __evilWrite(p: string) {\n  writeFileSync(p, "tampered");\n}\n',
    },
  },
  {
    // INV-81 (b) 无全文导出：数据面 content 字段（非 MCP 信封数组形态）→ 红。
    inv: "INV-81",
    desc: "search-local 输出 schema 加 content 全文字段（隐私红线破坏）",
    file: "search-local/chrome-history.ts",
    mutation: {
      append: 'export interface __EvilFullExport {\n  content: string;\n}\n',
    },
  },
  {
    // INV-81 (c) limit 硬顶：.max(50) → .max(5000)（dump 面板开门）→ 红。
    inv: "INV-81",
    desc: "search_local limit 硬顶 50 放宽到 5000（dump 面板回潮）",
    file: "search-local/register-search-local-tool.ts",
    mutation: { replaceAll: [".max(50)", ".max(5000)"] },
  },
  {
    // INV-81 (e) 日志纪律：query_len 计数换成查询原文 → 红。
    inv: "INV-81",
    desc: "search_local 日志记查询原文（query_len → query 原文泄漏）",
    file: "search-local/register-search-local-tool.ts",
    mutation: {
      replace: ["query_len: args.query.length", "query: args.query"],
    },
  },
];

// ============================================================
// 工具
// ============================================================
function runChecker(srcRoot) {
  const r = spawnSync(process.execPath, [CHECKER], {
    env: { ...process.env, LASSO_INV_SRC_ROOT: srcRoot },
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return {
    code: r.status,
    stdout: r.stdout ?? "",
    failedIds: (r.stdout ?? "").match(/^FAIL\s+(\S+)/gm)?.map((l) => l.slice(5).trim()) ?? [],
  };
}

function applyMutation(srcRoot, sample) {
  const target = join(srcRoot, sample.file);
  // INV-63 样本锚点动态化：__PKG_VERSION__ → package.json 当前版本（bump 不失效）
  if (sample.mutation.replace?.[0] === "__PKG_VERSION__") {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    sample.mutation.replace = [pkg.version, sample.mutation.replace[1]];
  }
  if (sample.mutation.append && !existsSync(target)) {
    // 新文件样本（恶意 Channel/接口直接落在 src 树里）——mkdir -p 父目录后创建
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, sample.mutation.append);
    return;
  }
  const text = readFileSync(target, "utf8");
  if (sample.mutation.append) {
    writeFileSync(target, text + "\n" + sample.mutation.append);
    return;
  }
  if (sample.mutation.replace) {
    const [from, to] = sample.mutation.replace;
    if (!text.includes(from)) {
      throw new Error(`mutation anchor not found in ${sample.file}: ${from}`);
    }
    writeFileSync(target, text.replace(from, to));
    return;
  }
  if (sample.mutation.replaceAll) {
    const [from, to] = sample.mutation.replaceAll;
    if (!text.includes(from)) {
      throw new Error(`mutation anchor not found in ${sample.file}: ${from}`);
    }
    writeFileSync(target, text.split(from).join(to));
    return;
  }
  throw new Error(`unknown mutation type in sample ${sample.inv}`);
}

// ============================================================
// 主流程
// ============================================================
let exitCode = 0;

// ---- 1. 基线（真实树必须全绿）----
const baseline = runChecker(SRC_DIR);
if (baseline.code !== 0) {
  console.error("[inv-selftest] BASELINE RED — 真实树本身有红线，先修复再自检：");
  console.error(baseline.failedIds.join("\n"));
  process.exit(2);
}
console.log(`[inv-selftest] 基线全绿（${VIOLATION_SAMPLES.length} 个样本待注入）\n`);

// ---- 2. 逐样本注入 → 断言目标 INV 转红 ----
const results = [];
for (const sample of VIOLATION_SAMPLES) {
  const tmp = mkdtempSync(join(tmpdir(), "lasso-inv-selftest-"));
  let flipped = false;
  let note = "";
  try {
    cpSync(SRC_DIR, tmp, { recursive: true });
    applyMutation(tmp, sample);
    const run = runChecker(tmp);
    const hit = run.failedIds.find((id) => id.startsWith(sample.inv + "-"));
    flipped = Boolean(hit);
    if (!flipped) {
      note =
        run.failedIds.length === 0
          ? "注入后仍全绿（假绿 pin）"
          : `注入后红线是别的 INV（${run.failedIds.slice(0, 3).join(", ")}），目标 pin 未红`;
    }
  } catch (e) {
    note = `样本注入失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const ok = flipped;
  if (!ok) exitCode = 1;
  results.push({ ...sample, ok, note });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${sample.inv}  ${ok ? "" : `— ${note}`}  (${sample.desc})`,
  );
}

// ---- 3. 汇总 ----
const bad = results.filter((r) => !r.ok);
if (bad.length > 0) {
  console.error(
    `\n${bad.length} 个假绿/失效 pin — ${bad.map((b) => b.inv).join(", ")}`,
  );
  console.error("红线纪律：pin 必须在已知违规下红过一次；仍绿的 pin 不可证伪，应重写。");
  process.exit(1);
}

// ---- 4. 样本覆盖率报告（v1.12 round2 T2-14；v1.13 round3 T3-7 补外部契约三条）----
// 非门禁输出：不设阈值不 fail（守单人可持续——未验证 pin 一次性补样是过度设计）；
// 覆盖数只增不减由 code review 把关。T3-7 后外部契约类（INV-76/68/71）已覆盖；
// 后续按需补（无既定优先清单——出现「写不出样本的 INV」即是发现）。
const passedIds = (baseline.stdout.match(/^PASS\s+(\S+)/gm) ?? []).map((l) =>
  l.slice(5).trim(),
);
const allIds = [...passedIds, ...baseline.failedIds];
const isCovered = (id) => VIOLATION_SAMPLES.some((s) => id.startsWith(s.inv + "-"));
const coveredCount = allIds.filter(isCovered).length;
console.log(
  `\n样本覆盖 ${coveredCount}/${allIds.length}（未验证 pin ${allIds.length - coveredCount} 条；` +
    `外部契约类 INV-76/68/71 已于 v1.13 T3-7 覆盖）`,
);
console.log(`\nAll ${results.length} sampled pins flipped red under violation. 工作树零污染。`);
process.exit(exitCode);
