/**
 * desired-hide-enforcer.spec.ts（bug02 隐藏全生命周期 v1.18.5 —— 独立执守进程）
 *
 * 守护 desired-hide-enforcer.ts + desired-hide-watchdog exitWhenIdleTicks 扩展：
 *  1. probeHideEnforcer 四态判死 + 一态在世（pidfile 三重活判定：可读 + pid 活 +
 *     ps cmdline marker——防 pid 复用假阳性）
 *  2. ensureHideEnforcerRunning：不在世 → spawn detached + 写 pidfile；在世 → 跳过
 *  3. startDesiredHideWatchdog exitWhenIdleTicks：连续 N 空账 tick 自退；非空清零
 *  4. 白盒锚点：runHideEnforcerCli 的入口让位 / 自写 pidfile / 自退接线
 *
 * 全 DI 注入——零真 spawn、零真 pidfile（env 隔离）。
 */
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  probeHideEnforcer,
  ensureHideEnforcerRunning,
  hideEnforcerEntryPath,
  HIDE_ENFORCER_CMDLINE_MARKER,
} from "../../src/launcher/desired-hide-enforcer.js";
import { startDesiredHideWatchdog } from "../../src/launcher/desired-hide-watchdog.js";
import type { DesiredHiddenRecord } from "../../src/launcher/desired-hide-state.js";
import type { ChildProcess } from "node:child_process";

// ============================================================
// helpers
// ============================================================
function makeRec(overrides: Partial<DesiredHiddenRecord> = {}): DesiredHiddenRecord {
  return { pid: 42111, port: 9222, profileDir: "/tmp/lasso-enforcer-profile", hiddenAt: 0, ...overrides };
}

/** 伪 ChildProcess（ensureHideEnforcerRunning 只用 .pid + .unref()）。 */
function fakeChild(pid: number): ChildProcess {
  return { pid, unref: () => {} } as unknown as ChildProcess;
}

// pidfile env 隔离（ensureHideEnforcerRunning 写真实 hideEnforcerPidPath）——零污染
let pidTmpDir: string;
beforeAll(() => {
  pidTmpDir = mkdtempSync(path.join(os.tmpdir(), "lasso-hide-enforcer-pid-"));
  process.env.LASSO_HIDE_ENFORCER_PID_PATH = path.join(pidTmpDir, "desired-hide-enforcer.json");
});
afterAll(() => {
  rmSync(pidTmpDir, { recursive: true, force: true });
  delete process.env.LASSO_HIDE_ENFORCER_PID_PATH;
});

// ============================================================
// probeHideEnforcer（纯函数 + DI；零 pidfile 真读）
// ============================================================
describe("probeHideEnforcer —— pidfile 三重活判定", () => {
  it("1. 无 pidfile → no_pidfile", () => {
    const p = probeHideEnforcer({ readPidFn: () => "" });
    expect(p).toEqual({ running: false, reason: "no_pidfile" });
  });

  it("2. pidfile 损坏（非 JSON / pid 非数字）→ pidfile_invalid", () => {
    expect(probeHideEnforcer({ readPidFn: () => "not-json" }).reason).toBe("pidfile_invalid");
    expect(probeHideEnforcer({ readPidFn: () => '{"pid":"abc"}' }).reason).toBe("pidfile_invalid");
  });

  it("3. pid 已死 → pid_dead", () => {
    const p = probeHideEnforcer({
      readPidFn: () => '{"pid":99999}',
      aliveFn: () => false,
    });
    expect(p.running).toBe(false);
    expect(p.reason).toBe("pid_dead");
  });

  it("4. pid 在世但 cmdline 无 hide-enforcer 标记（pid 复用）→ pid_reused（假阳性防线）", () => {
    const p = probeHideEnforcer({
      readPidFn: () => '{"pid":99999}',
      aliveFn: () => true,
      psFn: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=...",
    });
    expect(p.running).toBe(false);
    expect(p.reason).toBe("pid_reused");
  });

  it("5. 三重全过（pid 活 + cmdline 含 marker）→ running", () => {
    const p = probeHideEnforcer({
      readPidFn: () => '{"pid":4242}',
      aliveFn: () => true,
      psFn: () => `/usr/local/bin/node /somewhere/index.js ${HIDE_ENFORCER_CMDLINE_MARKER}`,
    });
    expect(p).toEqual({ running: true, pid: 4242, reason: "ok" });
  });
});

// ============================================================
// ensureHideEnforcerRunning（DI spawnFn；env 隔离 pidfile）
// ============================================================
describe("ensureHideEnforcerRunning —— 单例执守拉起（best-effort）", () => {
  it("6. 不在世 → spawn detached node <entry> hide-enforcer + 写 pidfile（spawned=true）", async () => {
    const spawns: Array<{ cmd: string; args: string[] }> = [];
    // 测试注入入口（默认 hideEnforcerEntryPath 在 vitest src 布局下不存在——
    // accessSync 门会诚实拒绝；生产 dist 布局恒存在）
    const entry = path.join(pidTmpDir, "fake-entry.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(entry, "// fake\n", "utf8");
    const r = await ensureHideEnforcerRunning({
      probe: { running: false, reason: "no_pidfile" },
      entry,
      spawnFn: (cmd, args) => {
        spawns.push({ cmd, args });
        return fakeChild(777001);
      },
    });
    expect(r.spawned).toBe(true);
    expect(r.pid).toBe(777001);
    expect(spawns).toHaveLength(1);
    // cmd = node 解释器（process.execPath）；argv = [入口, hide-enforcer]
    expect(spawns[0].cmd).toBe(process.execPath);
    expect(spawns[0].args[0]).toBe(entry);
    expect(spawns[0].args[1]).toBe(HIDE_ENFORCER_CMDLINE_MARKER);
    // pidfile 写入（env 隔离目录）
    const { hideEnforcerPidPath } = await import("../../src/launcher/desired-hide-enforcer.js");
    expect(readFileSync(hideEnforcerPidPath(), "utf8")).toContain('"pid":777001');
  });

  it("6b. 入口不存在（布局异常）→ 诚实降级不 spawn（server 内看门狗仍是主执守面）", async () => {
    let spawnCalls = 0;
    const logs: Array<Record<string, unknown>> = [];
    const r = await ensureHideEnforcerRunning({
      probe: { running: false, reason: "no_pidfile" },
      entry: path.join(pidTmpDir, "no-such-entry.js"),
      spawnFn: () => {
        spawnCalls++;
        return fakeChild(1);
      },
      logFn: (p) => logs.push(p),
    });
    expect(r).toEqual({ spawned: false, reason: "entry_missing" });
    expect(spawnCalls).toBe(0);
    expect(logs.some((p) => p.evt === "hide_enforcer_entry_missing")).toBe(true);
  });

  it("7. 已在世 → 不 spawn（spawned=false, already_running）", async () => {
    let spawnCalls = 0;
    const r = await ensureHideEnforcerRunning({
      probe: { running: true, pid: 4242, reason: "ok" },
      spawnFn: () => {
        spawnCalls++;
        return fakeChild(1);
      },
    });
    expect(r).toEqual({ spawned: false, pid: 4242, reason: "already_running" });
    expect(spawnCalls).toBe(0);
  });

  it("8. hideEnforcerEntryPath：launcher/ 上**一级**的 index.js（真机实锤回归——初版 ../../ 落仓库根致 entry_missing 永不真起）", () => {
    // 结构锚定：入口必须 === 本模块目录（launcher/）的父目录下的 index.js
    //（src 布局解析为 src/index.js；生产 dist 布局同构为 dist/index.js = bin 入口）
    const expected = fileURLToPath(
      new URL("../../src/index.js", import.meta.url),
    );
    expect(hideEnforcerEntryPath()).toBe(expected);
    // 生产 dist 布局同构验证：dist/launcher/ 上一级确有 index.js（bin = dist/index.js）
    const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
    expect(existsSync(path.join(distDir, "index.js"))).toBe(true);
    expect(existsSync(path.join(distDir, "launcher", "desired-hide-enforcer.js"))).toBe(true);
  });
});

// ============================================================
// watchdog exitWhenIdleTicks（执守自退；fake timers）
// ============================================================
describe("startDesiredHideWatchdog · exitWhenIdleTicks —— 执守进程自退", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("9. 连续 2 空账 tick → onIdleExit 回调 + 后续 tick 不再执行（执守退场）", async () => {
    let exited = 0;
    let reassertCalls = 0;
    const wd = startDesiredHideWatchdog({
      platform: "darwin",
      intervalMs: 100,
      exitWhenIdleTicks: 2,
      onIdleExit: () => {
        exited++;
      },
      readStateFn: () => [],
      rewriteStateFn: () => {},
      aliveFn: () => true,
      psFn: () => "--user-data-dir=/tmp/lasso-enforcer-profile",
      reassertFn: async () => {
        reassertCalls++;
        return { ok: true, wasVisible: false };
      },
    });
    expect(wd).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000); // 10 tick 全空
    expect(exited).toBe(1); // 恰一次（第 2 个空 tick 触发后 stop）
    expect(reassertCalls).toBe(0); // 空账零 osascript
  });

  it("10. 空 → 非空 → 空：计数清零（不误退有对象的执守）", async () => {
    let exited = 0;
    const state: DesiredHiddenRecord[][] = [[], [makeRec()], [], []];
    let tick = 0;
    const wd = startDesiredHideWatchdog({
      platform: "darwin",
      intervalMs: 100,
      exitWhenIdleTicks: 2,
      onIdleExit: () => {
        exited++;
      },
      readStateFn: () => state[Math.min(tick, state.length - 1)],
      rewriteStateFn: () => {},
      aliveFn: () => true,
      psFn: () => "--user-data-dir=/tmp/lasso-enforcer-profile",
      reassertFn: async () => ({ ok: true, wasVisible: false }),
    });
    expect(wd).not.toBeNull();
    // tick 序：空(1) → 非空(清零) → 空(1) → 空(2 → exit)
    await vi.advanceTimersByTimeAsync(400);
    expect(exited).toBe(1);
  });

  it("11. 缺省 exitWhenIdleTicks → 永不自退（server 进程内既有形态不破）", async () => {
    let exited = 0;
    const wd = startDesiredHideWatchdog({
      platform: "darwin",
      intervalMs: 100,
      onIdleExit: () => {
        exited++;
      },
      readStateFn: () => [],
      rewriteStateFn: () => {},
      aliveFn: () => true,
      psFn: () => "",
      reassertFn: async () => ({ ok: true }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exited).toBe(0);
    wd!.stop();
  });
});

// ============================================================
// runHideEnforcerCli 白盒锚点（CLI 短命路径 process.exit——源码锚定范式）
// ============================================================
describe("runHideEnforcerCli —— 执守主体接线（白盒）", () => {
  it("12. 入口让位（并发双起收敛）+ 自写 pidfile + exitWhenIdleTicks:2 + 信号干净退出", () => {
    const src = readFileSync("src/launcher/desired-hide-enforcer.ts", "utf8");
    // 让位：别的执守在世（pid ≠ 自己）→ exit 0
    expect(src).toMatch(/probe\.running && probe\.pid !== process\.pid/);
    // 自写 pidfile（父进程写失败时的权威兜底）
    expect(src).toMatch(/writeEnforcerPidfile\(process\.pid\)/);
    // 自退出口接线 + keep-alive 持活（watchdog timer unref 不阻退出）
    expect(src).toMatch(/exitWhenIdleTicks: 2/);
    expect(src).toMatch(/clearInterval\(keepAlive\)/);
    expect(src).toMatch(/const keepAlive = setInterval/);
  });

  it("13. index.ts 子命令路由 hide-enforcer（CLI 入口存在）", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toMatch(/process\.argv\[2\] === "hide-enforcer"/);
    expect(src).toMatch(/await runHideEnforcerCli\(\)/);
  });

  it("14. chrome-hideshow-cli：hide 成功记账后 ensureEnforcer（执守与 CLI 解耦）", () => {
    const src = readFileSync("src/launcher/chrome-hideshow-cli.ts", "utf8");
    expect(src).toMatch(/import \{ ensureHideEnforcerRunning \} from "\.\/desired-hide-enforcer\.js";/);
    expect(src).toMatch(/await ensureEnforcer\(\);/);
  });
});
