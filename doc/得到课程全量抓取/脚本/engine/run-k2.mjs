#!/usr/bin/env node
/**
 * run-k2.mjs — PERF-T2 K=2 双进程编排（2026-08-19）
 *
 * 用法：
 *   node run-k2.mjs                          # 全量：两 worker 按 manifest.idx 奇偶分片
 *   node run-k2.mjs --only "标题A,标题B,..."  # 指定章 round-robin 均分两 worker
 *   透传：--retry / --force（原样转给两 worker）
 *
 * 编排职责（PERF-分析.md §3.1/§5 T2 清单）：
 *   ① 清理全局跳闸文件 BREAKER.trip（上轮残留不阻断本轮）
 *   ② worker0 即起、worker1 错峰 20s——保证两 lasso 各自 createBackgroundTarget 的
 *      id-diff 归因不撞（并发建 tab 归因不唯一 → 可能互选对方 tab）
 *   ③ 两 worker stdio 直通（engine note() 自带 [K0]/[K1] 前缀）；各自独立日志文件
 *   ④ 等待双方退出并汇总；任一 worker 触发熔断 → 写 BREAKER.trip → 双方章边界停机
 *
 * 前置（已核验 2026-08-19）：Chrome 9226 cmdline 已带反节流三件套
 *   --disable-background-timer-throttling --disable-backgrounding-occluded-windows
 *   --disable-renderer-backgrounding（lasso launch-chrome 恒加）→ 后台 tab 懒加载/计时器不劣化。
 * 红线：RUNBOOK §6.3「单 producer」→ 本 wrapper 即 ≤2 producer 的分片模式（用户已授权并发方向）。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ENGINE } from "./config.mjs"; // 2026-08-20 F1 整改：课程引擎目录唯一入口 config.mjs
const TRIP = path.join(ENGINE, "BREAKER.trip");
const STAGGER_MS = 20000;

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const passthrough = argv.filter((a, i) => a !== "--only" && i !== onlyIdx + 1);

fs.rmSync(TRIP, { force: true });
console.log(`[k2] BREAKER.trip 已清理；${only ? "指定章均分模式" : "全量奇偶分片模式"}${passthrough.length ? ` 透传 ${passthrough.join(" ")}` : ""}`);

const halves = [[], []];
if (only) {
  only.split(",").map((s) => s.trim()).filter(Boolean).forEach((t, i) => halves[i % 2].push(t));
  if (!halves[0].length || !halves[1].length) { console.log("[k2][FATAL] --only 集合过小，两 worker 各需 ≥1 章"); process.exit(1); }
}

function spawnWorker(k) {
  const args = ["engine.mjs", "produce", "--worker", `${k}/2`,
    ...(halves[k].length ? ["--only", halves[k].join(",")] : []), ...passthrough];
  console.log(`[k2] 启动 worker${k}: node ${args.join(" ")}`);
  const p = spawn("node", args, { cwd: ENGINE, stdio: "inherit" });
  const exitP = new Promise((res) => p.on("exit", (code, sig) => {
    console.log(`[k2] worker${k} 退出 code=${code} sig=${sig ?? "-"}`);
    res(code ?? -1);
  }));
  return { p, exitP };
}

const t0 = Date.now();
const w0 = spawnWorker(0);
await new Promise((r) => setTimeout(r, STAGGER_MS)); // 错峰：own-page id-diff 归因窗口
const w1 = spawnWorker(1);
const [c0, c1] = await Promise.all([w0.exitP, w1.exitP]);

const tripped = fs.existsSync(TRIP);
console.log(`[k2] 全部 worker 结束（${((Date.now() - t0) / 1000).toFixed(0)}s，含 20s 错峰）` +
  `${tripped ? ` ｜ ⚠️ BREAKER.trip: ${fs.readFileSync(TRIP, "utf8").replace(/\s+/g, " ").slice(0, 220)}` : ""}`);
process.exit(c0 === 0 && c1 === 0 ? 0 : 1);
