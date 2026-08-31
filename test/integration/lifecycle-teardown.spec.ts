/**
 * lifecycle-teardown 集成测（v1.9 parse17 §7.2 机制一二三装配链，例 30-31）
 *
 * index.ts 是 auto-execute 入口（main() 顶层调用），无法在 vitest worker 内直接
 * import 做行为级 mock——采用「源码装配顺序断言」（grep 场式，parse17 §7.2-30/31
 * 允许的择一路径）+ 行为已在 unit 侧覆盖（subprocess-idle-watchdog.spec.ts 验
 * reap hook / chrome-ledger.spec.ts 验 stopLaunchedChromes / tab-session.spec.ts
 * 验 restore）。
 *
 *  30. shutdown 模拟：stopLaunchedChromes + logged_in.restoreTabs 在 killAllSync
 *      之前被调（停机收尾先于兜底树杀）；exit 钩子 stopLaunchedChromesSync 在
 *      killAllSync 之前。
 *  31. reap hook 装配：setReapHook 在 startZombieReaper（经 startIdleWatchdog()）
 *      调用点之前完成；hook 只对 logged_in: 前缀 spec 调 restoreTabs。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const INDEX_SRC = readFileSync(
  new URL("../../src/index.ts", import.meta.url),
  "utf8",
);

/** 圈定函数体（从 signature 到下一个同缩进 export/function 边界的近似）。 */
function bodyAfter(marker: string): string {
  const idx = INDEX_SRC.indexOf(marker);
  expect(idx).toBeGreaterThan(-1); // marker 必须存在
  return INDEX_SRC.slice(idx, idx + 4000);
}

describe("index.ts 装配链 —— 停机收尾顺序（parse17 §3.6 + §4.4）", () => {
  it("shutdown(sig) 内：stopLaunchedChromes 与 logged_in.restoreTabs 均先于 subproc.killAllSync", () => {
    const shutdownBody = bodyAfter("const shutdown = async (sig: string)");
    // P2 处置轮：ChromeStopOptions.all 死字段已删——无 port = --all（锚点同步）
    const chromeStopIdx = shutdownBody.indexOf('stopLaunchedChromes({ modes: ["hidden"]');
    const restoreIdx = shutdownBody.indexOf("logged_in.restoreTabs()");
    const killAllIdx = shutdownBody.indexOf("subproc.killAllSync()");
    expect(chromeStopIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(killAllIdx).toBeGreaterThan(-1);
    // 收尾（机制二/三）必须先于兜底树杀（killAllSync）
    expect(chromeStopIdx).toBeLessThan(killAllIdx);
    expect(restoreIdx).toBeLessThan(killAllIdx);
    // 两者都有 3s race 上界（parse17 §8.3-2：hook/收尾侧双方都要守）
    expect(shutdownBody).toMatch(/stopLaunchedChromes[\s\S]{0,400}3_000/);
    expect(shutdownBody).toMatch(/restoreTabs\(\)[\s\S]{0,400}3_000/);
  });

  it("process.on(\"exit\") 钩子：stopLaunchedChromesSync 零 await 且先于 killAllSync", () => {
    const exitBody = bodyAfter('process.on("exit", () => {');
    const syncStopIdx = exitBody.indexOf("stopLaunchedChromesSync(");
    const killAllIdx = exitBody.indexOf("subproc.killAllSync()");
    expect(syncStopIdx).toBeGreaterThan(-1);
    expect(killAllIdx).toBeGreaterThan(-1);
    expect(syncStopIdx).toBeLessThan(killAllIdx);
    // exit 钩子内禁 await（W1-DEF-6 零 await 纪律；先剥注释再断——注释里提到「await」不算）
    const codeOnly = exitBody
      .slice(0, killAllIdx)
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toMatch(/\bawait\b/);
  });

  it("CLI 路由：chrome-stop 子命令 + CLI_USAGE 含 chrome-stop 用法行（INV-77d 预检）", () => {
    expect(INDEX_SRC).toMatch(/process\.argv\[2\] === "chrome-stop"/);
    expect(INDEX_SRC).toMatch(/runChromeStopCli/);
    expect(INDEX_SRC).toMatch(/chrome-stop \[--port N \| --all\]/);
  });
});

describe("index.ts 装配链 —— reap hook 装配顺序（parse17 §7.2-31）", () => {
  it("setReapHook 调用点先于 startZombieReaper 实际启动点（startIdleWatchdog()）", () => {
    const hookIdx = INDEX_SRC.indexOf("subproc.setReapHook(");
    const watchdogCallIdx = INDEX_SRC.indexOf("startIdleWatchdog();");
    expect(hookIdx).toBeGreaterThan(-1);
    expect(watchdogCallIdx).toBeGreaterThan(-1);
    expect(hookIdx).toBeLessThan(watchdogCallIdx);
  });

  it("reap hook 闭包：只对 logged_in: 前缀 spec 调 restoreTabs（headless 回收不打扰）", () => {
    const hookBody = bodyAfter("subproc.setReapHook(async (name) => {");
    expect(hookBody).toMatch(/name\.startsWith\("logged_in:"\)/);
    expect(hookBody).toMatch(/restoreTabs\(\)/);
  });

  it("idle watchdog 接线：config.headlessIdleMs + startZombieReaper 两参 + 0 禁用分支", () => {
    expect(INDEX_SRC).toMatch(/config\.headlessIdleMs/);
    expect(INDEX_SRC).toMatch(/startZombieReaper\(60_000, config\.headlessIdleMs\)/);
    expect(INDEX_SRC).toMatch(/idle_watchdog_disabled/);
  });
});
