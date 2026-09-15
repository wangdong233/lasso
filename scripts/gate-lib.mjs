#!/usr/bin/env node
/**
 * gate-lib.mjs（BUG-08 F，2026-09-15）—— gate.mjs 的可测内核：vitest 汇总行解析
 * （§14 判绿纪律的权威源）+ vitest 树超时追杀带（belt）。
 *
 * 为什么拆出：belt 的解析/追杀逻辑必须可被单测钉（改行为必配测试），而 gate.mjs
 * 本体是门禁脚本（跑一次 = 全量 build+全量套件，不可在测试内嵌套调用）。
 *
 * 追杀带单一真源纪律：树杀实现**不在本文件重写 pgrep 递归**（kill-tree.ts 头注
 * 「禁第二份 pgrep 递归实现漂移」），动态 import 编译产物 dist/util/kill-tree.js
 * （gate 门序 build 先于 vitest，dist 必在；belt 只在 vitest 异常终态时才走）。
 *
 * 🔴 belt 时序（E1 白盒实锤，2026-09-15）：spawnSync 的 timeout 到点只对**直子
 * 进程**（npx）发 SIGTERM，且 spawnSync 要等子进程死透才返回——返回时刻树根已死，
 * 后代已 re-parent 给 launchd，`pgrep -P <死根>` 恒空 → 「返回后再追杀」追的是
 * 空树。真机数据：SIGTERM(npx) 后 vitest main 优雅死、空闲 worker 随死，但
 * **忙 worker（120s 长睡中的探针）原样存活**（孤儿事故形态重演）。因此 belt 必须
 * 在**树根活着的时刻**发起 killTree（kill-tree.ts 是「先全量枚举后统一 SIGKILL」
 * 单趟实现，根活着时调用 = 整树含 npx→node(vitest)→esbuild→worker 全灭）——
 * 这要求 gate 的 vitest 步骤用 async spawn + 手动超时竞赛（runWithBelt），
 * 而非 spawnSync timeout。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** vitest 超时追杀带缺省 20min（全量套件健康水位 3-7min；belt 永不该在健康跑触发）。 */
export const DEFAULT_GATE_VITEST_BELT_MS = 20 * 60_000;

/** belt 开火后 exit 事件的宽限（SIGKILL 整树后 exit 必然快速到达；此窗只是防挂死兜底）。 */
const BELT_EXIT_GRACE_MS = 15_000;

/**
 * belt 预算解析（parseCdpPort/parseEvalTimeoutMs 同范式）：
 * 未设/非数字/非正整数 → 缺省。NaN 与负数都不放行（负 belt = 永不追杀的静默陷阱）。
 */
export function parseGateVitestBeltMs(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_GATE_VITEST_BELT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GATE_VITEST_BELT_MS;
  return Math.floor(n);
}

function importKillTreeSync() {
  // dist/util/kill-tree.js（gate 门序 build 先于 vitest；真源纪律：不在本文件重写 pgrep 递归）
  const url = new URL("../dist/util/kill-tree.js", import.meta.url);
  if (!existsSync(url)) return null;
  return import(fileURLToPath(url)).then((m) => m.killTreeSync);
}

/**
 * async 带超时竞赛的子进程运行（belt 的正确时序载体）：
 *  - 健康路径：子进程自然退出，行为与 spawnSync 等价（status/out 语义一致）；
 *  - 超时路径：belt 到点在**树根仍活**时 killTreeSync 整树（先枚举后 SIGKILL 单趟，
 *    见 kill-tree.ts）——根死后 re-parent 的孤儿类在此实现下不存在（成员按 pid 直杀）；
 *  - 外部击杀路径（belt 未开火而异常终态）：树根可能已死（枚举恒空）——best-effort
 *    再追一次（chaseVitestTree），已知残余 = 死根 re-parent 窗（与 E1 前实现同限，
 *    仅此形态收窄，不再声称覆盖超时路径）。
 *
 * @returns {Promise<{label: string, ok: boolean, status: number|null, signal: string|null,
 *                     out: string, pid: number, abnormal: boolean, beltFired: boolean}>}
 *   abnormal = belt 开火 / watchdog 到期 / status null（含 spawn error）/ 带信号终态。
 */
export async function runWithBelt(label, cmd, args, { beltMs, cwd, env, log = () => {} } = {}) {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
  });
  const pid = child.pid;
  let out = "";
  child.stdout?.on("data", (d) => (out += String(d)));
  child.stderr?.on("data", (d) => (out += String(d)));

  let settled = null; // { code, signal, error? }
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
  });

  let beltFired = false;
  let watchdogTimer; // belt/watchdog 两 timer 在定局后一律解除武装——防「健康退出后 timer 迟到开火」误杀复用 pid
  const beltTimer = setTimeout(() => {
    beltFired = true;
    log(`belt: ${Math.round(beltMs / 1000)}s 到点 — 树根仍活，killTreeSync 整树 root pid=${pid}`);
    // importKillTreeSync 对 dist 缺失返回 null（非 Promise）——Promise.resolve 归一，
    // 防 setTimeout 回调内同步 throw 变 uncaught（belt 是已红路径，不得再叠崩 gate）
    Promise.resolve(importKillTreeSync())
      .then((killTreeSync) => {
        if (killTreeSync) {
          killTreeSync(pid, "gate:vitest-belt");
        } else {
          log(`belt: dist/util/kill-tree.js 不可用 — 仅直杀 root pid=${pid}（树成员可能残留）`);
          child.kill("SIGKILL");
        }
      })
      .catch((e) => {
        log(`belt: killTree pursuit failed (${String(e).slice(0, 120)}) — 直杀 root`);
        child.kill("SIGKILL");
      });
  }, beltMs);
  // 总 watchdog = belt + 宽限 + 5min 余量：belt SIGKILL 后 exit 必至；watchdog 到期
  // 只在「belt 失效 + 进程不死」的病态形态出现——恒红 + 不让 gate 永挂。
  const watchdogMs = beltMs + BELT_EXIT_GRACE_MS + 5 * 60_000;
  let watchdogResolve;
  const watchdogP = new Promise((resolve) => {
    watchdogResolve = resolve;
    watchdogTimer = setTimeout(() => resolve({ watchdog: true }), watchdogMs);
  });

  settled = await Promise.race([exited, watchdogP]);
  clearTimeout(beltTimer); // 健康路径定局后 disarm（belt 只该在真超时时开火）
  clearTimeout(watchdogTimer);
  watchdogResolve?.(); // 微任务序保证 race 已定局；解除悬挂 Promise 不拦 child 对象 GC
  const watchdogFired = Boolean(settled.watchdog);

  const abnormal =
    beltFired || watchdogFired || settled.code === null || Boolean(settled.signal);
  return {
    label,
    ok: !beltFired && !watchdogFired && settled.code === 0,
    status: settled.code,
    signal: settled.signal ?? null,
    out,
    pid,
    abnormal,
    beltFired,
  };
}

/**
 * 对（可能已死的）vitest 主进程 pid 的整树 SIGKILL 追杀（PERF-5 同型的死后收尾）。
 * 仅供 runWithBelt 的「外部击杀」异常终态路径 best-effort 使用——超时路径由
 * runWithBelt 的 belt 在根活时直接处理（本函数对死根恒空手，E1 实证）。
 *
 * @returns {Promise<{chased: boolean, detail: string}>} best-effort：dist 缺失等
 *   import 失败不抛（belt 是已红路径上的加固，不得掩盖超时红本身）。
 */
export async function chaseVitestTree(pid, log = () => {}) {
  if (!pid || !Number.isInteger(pid)) return { chased: false, detail: "no_pid" };
  try {
    const killTreeSync = await importKillTreeSync();
    if (!killTreeSync) return { chased: false, detail: "kill_tree_unavailable" };
    killTreeSync(pid, "gate:vitest-belt");
    log(`belt: killTree pursued for vitest tree root pid=${pid}`);
    return { chased: true, detail: `pid=${pid}` };
  } catch (e) {
    log(`belt: pursuit unavailable (${String(e).slice(0, 120)}) — tree may linger`);
    return { chased: false, detail: `import_failed:${String(e).slice(0, 80)}` };
  }
}

/** 显式计数断言：解析 vitest 汇总行，failed 必须为 0（不信退出码单源）。§14 原逻辑原样搬出。 */
export function vitestSummary(out) {
  const files = out.split("\n").find((l) => /Test Files/.test(l)) ?? "";
  const tests = out.split("\n").find((l) => /^\s*Tests\s/.test(l)) ?? "";
  const failedFiles = Number((files.match(/(\d+) failed/) || [])[1] ?? 0);
  const failedTests = Number((tests.match(/(\d+) failed/) || [])[1] ?? 0);
  return { files: files.trim(), tests: tests.trim(), failedFiles, failedTests };
}
