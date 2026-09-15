#!/usr/bin/env node
// gate.mjs —— 门禁三件套固化（09-09，§14 方法论教训收口）
//
// 背景（cc-control 09-08 复检实锤）：vitest 输出经 `| tail` 管道时，shell 拿到的
// 退出码是 tail 的（恒 0）——全量 1 failed 曾被这样掩掉，靠人读 "Test Files"
// 汇总行才抓出。教训：判绿必须读汇总行，不信管道退出码。
//
// 固化（本脚本 = 门禁命令进 npm script `npm run gate`）：
//  1. 判绿不靠退出码单源：显式解析 vitest "Test Files"/"Tests" 汇总行并断言
//     failed === 0（显式计数断言）——即使人把本脚本输出接进管道，汇总行解析
//     仍发生在脚本内部（spawnSync 捕获输出，内部零管道）；
//  2. 终局裁定块永远打印在**输出末尾**（GATE GREEN / GATE RED + 各门 ✓/✗ +
//     vitest 汇总行原文）——人再怎么 `| tail` 也看得见终局；
//  3. 不用 `set -o pipefail`：npm script-shell=/bin/sh（macOS bash-sh 模式 /
//     Linux 或为 dash），pipefail 非 POSIX——把门禁可移植性押在 shell 扩展上
//     比显式计数断言更脆。
//
// 门（与项目门禁纪律一致；README 不文档化——技术内部不进 README）：
//  ① build（tsc + dist 装配） ② vitest run（全量） ③ check-invariants
//  ④ check-readme-sync（npm test 链的 README 漂移面）
import { spawnSync } from "node:child_process";
import {
  vitestSummary,
  parseGateVitestBeltMs,
  runWithBelt,
  chaseVitestTree,
  DEFAULT_GATE_VITEST_BELT_MS,
} from "./gate-lib.mjs";

const run = (label, cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return { label, ok: r.status === 0, status: r.status, out };
};

// 🔴 门序（2026-09-09 实锤修正）：build 必须先于 vitest——CLI 集成测试
// （runDoctorCliViaDist 等）读 dist 产物，旧 dist 会假红（版本镜像断言
// pkgVersion vs 旧 dist 的 lasso_version 不匹配）。原实现 vitest 先跑，
// VERDICT 打印顺序对但执行顺序反。
const build = run("npm run build", "npm", ["run", "build"]);

// 🔴 BUG-08 F（2026-09-15）vitest 树超时追杀带（belt）：vitest 步骤走 runWithBelt
// （async spawn + 超时竞赛）——belt 到点在**树根仍活**时 killTreeSync 整树（E1 白盒
// 实锤：spawnSync timeout 只 SIGTERM 直子 npx 且返回时根已死、pgrep -P 恒空 →
// 忙 worker（孤儿事故形态）漏杀）。防「vitest 楔死 → gate 挂死」与「异常终态后
// 测试自 spawn 子进程残留」两个面；健康跑（3-7min）永不触发。预算可调
// LASSO_GATE_VITEST_TIMEOUT_MS（非法/非正 → 缺省）。
const beltMs = parseGateVitestBeltMs(process.env.LASSO_GATE_VITEST_TIMEOUT_MS);
const vitest = await runWithBelt("vitest run（全量）", "npx", ["vitest", "run"], {
  beltMs,
  log: (m) => console.log(`  [gate] ${m}`),
});
let beltNote = "";
if (vitest.abnormal) {
  // belt 已开火（超时路径）→ 树已在根活时整杀；belt 未开火而异常终态（外部击杀）
  // → 树根或已死，best-effort 死后追杀（E1 已知残余：死根 pgrep 恒空）
  const chased = vitest.beltFired
    ? { chased: true, detail: `belt 在树根存活时已整树 SIGKILL（root pid=${vitest.pid}）` }
    : await chaseVitestTree(vitest.pid, (m) => console.log(`  [gate] ${m}`));
  beltNote = `vitest 异常终态（status=${vitest.status} signal=${vitest.signal ?? "none"} belt=${vitest.beltFired ? "开火" : "未开火"}）→ 追杀带 ${chased.chased ? "已执行" : "不可用"}（${chased.detail}；belt=${Math.round(beltMs / 1000)}s，LASSO_GATE_VITEST_TIMEOUT_MS 可调，缺省 ${Math.round(DEFAULT_GATE_VITEST_BELT_MS / 1000)}s）`;
}
const vSum = vitestSummary(vitest.out);
// 双源判绿：退出码 AND 汇总行计数（任一红即红——汇总行是 §14 教训的权威源）
// 异常终态（超时/被杀）无退出码可言 → 恒红
const vitestOk = vitest.ok && !vitest.abnormal && vSum.failedFiles === 0 && vSum.failedTests === 0;

const inv = run("check-invariants", "node", ["src/invariants/check-invariants.mjs"]);
const readme = run("check-readme-sync", "node", ["scripts/check-readme-sync.mjs"]);

// vitest 失败时回放失败块（Failed Tests 起 80 行）——不用管道，直接打印
if (!vitestOk && vitest.out) {
  const lines = vitest.out.split("\n");
  const from = lines.findIndex((l) => l.includes("Failed Tests"));
  if (from >= 0) console.log(lines.slice(from, from + 80).join("\n"));
}

console.log("\n==================== GATE VERDICT ====================");
for (const g of [
  { ...build, label: `npm run build` },
  { ...vitest, ok: vitestOk, label: "vitest run（全量，双源判绿）" },
  inv,
  readme,
]) {
  console.log(`${g.ok ? "✓" : "✗"} ${g.label} (exit ${g.status})`);
}
if (vSum.files || vSum.tests) {
  console.log(`  vitest 汇总行（判绿权威源）：`);
  if (vSum.files) console.log(`    ${vSum.files}`);
  if (vSum.tests) console.log(`    ${vSum.tests}`);
}
if (beltNote) console.log(`  🔴 ${beltNote}`);
const anyRed = [build, { ok: vitestOk }, inv, readme].some((g) => !g.ok);
console.log(`\n判绿纪律：读上面汇总行（failed=0），不信管道退出码。`);
console.log(anyRed ? "GATE RED —— 存在失败门，禁收编/交付" : "GATE GREEN —— build/vitest/invariants/readme 四面全绿");
process.exit(anyRed ? 1 : 0);
