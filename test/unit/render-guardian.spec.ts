/**
 * render-guardian.spec.ts（v1.19 渲染档设计决议 裁决一 —— 执守进程装配面）
 *
 * 守护点（设计决议 §8.1）：
 *  - probe 五态（no_pidfile / pidfile_invalid / pid_dead / pid_reused / ok——注入
 *    readPid / ps / alive 三源）
 *  - ensureRenderGuardianRunning：idle opt-out 不拉 / already_running 不拉 /
 *    entry_missing 诚实降级 / spawn 路径写 pidfile
 *  - 后到者让位（probe 见他者 → exit 0，不装配）
 *  - 🔴 r2 持活：assembleRenderGuardian 持 **ref'd** keep-alive（hasRef()===true 断言）
 *    且 onIdleExit / shutdown 统一清除（进程级真退由 render-guardian-process.spec 钉死）
 *  - readLedgerFn 过滤只看 render；stopFn 接线；exitWhenLedgerEmptyTicks=2
 *  - 嵌入 reaper：touch mtime 新于阈值不收割、超时收割（真 startChromeIdleReaper +
 *    fake timers）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileSync, readFileSync } from "node:fs";
import {
  probeRenderGuardian,
  ensureRenderGuardianRunning,
  assembleRenderGuardian,
  runRenderGuardianCli,
  renderGuardianPidPath,
  RENDER_GUARDIAN_CMDLINE_MARKER,
} from "../../src/render/render-guardian.js";
import { recordLaunch, type LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";
import { CHROME_IDLE_REAPER_INTERVAL_MS } from "../../src/launcher/chrome-idle-reaper.js";

let tmpDir: string;
let ledgerPath: string;
let pidPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-render-guard-"));
  ledgerPath = path.join(tmpDir, "launched-chromes.json");
  pidPath = path.join(tmpDir, "render-guardian.json");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
  process.env.LASSO_RENDER_GUARDIAN_PID_PATH = pidPath;
  process.env.LASSO_CHROME_TOUCH_DIR = tmpDir;
  delete process.env.LASSO_RENDER_IDLE_MS;
  delete process.env.LASSO_RENDER_REAPER_INTERVAL_MS;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_RENDER_GUARDIAN_PID_PATH;
  delete process.env.LASSO_CHROME_TOUCH_DIR;
  delete process.env.LASSO_RENDER_IDLE_MS;
  delete process.env.LASSO_RENDER_REAPER_INTERVAL_MS;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9224,
    pid: 4242,
    profileDir: "/tmp/render-chrome-profile-g-0001",
    launchedAt: Date.now(),
    status: "ready",
    launchMode: "render",
    ...overrides,
  };
}

const MARKER_PS = `node /x/dist/index.js ${RENDER_GUARDIAN_CMDLINE_MARKER}\n`;

describe("probeRenderGuardian —— 五态", () => {
  it("no_pidfile（文件不存在）", () => {
    expect(probeRenderGuardian()).toEqual({ running: false, reason: "no_pidfile" });
  });

  it("pidfile_invalid（坏 JSON / pid 非整数）", () => {
    writeFileSync(pidPath, "{broken", "utf8");
    expect(probeRenderGuardian()).toEqual({ running: false, reason: "pidfile_invalid" });
    writeFileSync(pidPath, JSON.stringify({ pid: "x" }), "utf8");
    expect(probeRenderGuardian()).toEqual({ running: false, reason: "pidfile_invalid" });
  });

  it("pid_dead（pid 不在世）", () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 999999 }), "utf8");
    expect(probeRenderGuardian({ aliveFn: () => false })).toEqual({
      running: false,
      pid: 999999,
      reason: "pid_dead",
    });
  });

  it("pid_reused（pid 活但 cmdline 无 marker——防 pid 复用假阳性）", () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 12345 }), "utf8");
    expect(probeRenderGuardian({ aliveFn: () => true, psFn: () => "/Applications/Safari.app" })).toEqual({
      running: false,
      pid: 12345,
      reason: "pid_reused",
    });
  });

  it("ok（pid 活 + cmdline 含 marker）", () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 12346 }), "utf8");
    expect(probeRenderGuardian({ aliveFn: () => true, psFn: () => MARKER_PS })).toEqual({
      running: true,
      pid: 12346,
      reason: "ok",
    });
  });
});

describe("ensureRenderGuardianRunning —— 拉起门", () => {
  it("LASSO_RENDER_IDLE_MS ≤ 0（opt-out）→ 不拉执守", async () => {
    process.env.LASSO_RENDER_IDLE_MS = "0";
    let spawnCalls = 0;
    const r = await ensureRenderGuardianRunning({
      spawnFn: (() => {
        spawnCalls++;
        return { unref: () => {}, pid: 1 } as never;
      }) as never,
      entry: "/bin/sh",
    });
    expect(r).toMatchObject({ spawned: false, reason: "idle_opt_out" });
    expect(spawnCalls).toBe(0);
  });

  it("already_running → 跳过 spawn", async () => {
    let spawnCalls = 0;
    const r = await ensureRenderGuardianRunning({
      probe: { running: true, pid: 777, reason: "ok" },
      spawnFn: (() => {
        spawnCalls++;
        return { unref: () => {}, pid: 1 } as never;
      }) as never,
      entry: "/bin/sh",
    });
    expect(r).toMatchObject({ spawned: false, pid: 777, reason: "already_running" });
    expect(spawnCalls).toBe(0);
  });

  it("entry_missing → 诚实降级不 spawn（dist 布局一级之隔教训）", async () => {
    const r = await ensureRenderGuardianRunning({
      entry: path.join(tmpDir, "no-such-entry.js"),
    });
    expect(r).toMatchObject({ spawned: false, reason: "entry_missing" });
  });

  it("spawn 路径：detached spawn + unref + 自写 pidfile", async () => {
    const unrefCalls: number[] = [];
    const r = await ensureRenderGuardianRunning({
      entry: "/bin/sh",
      spawnFn: (() => ({ pid: 654321, unref: () => unrefCalls.push(1) })) as never,
    });
    expect(r).toMatchObject({ spawned: true, pid: 654321, reason: "spawned" });
    expect(unrefCalls).toHaveLength(1);
    const pidfile = JSON.parse(readFileSync(pidPath, "utf8")) as { pid: number };
    expect(pidfile.pid).toBe(654321);
  });
});

describe("assembleRenderGuardian —— 装配面（r2 持活核心）", () => {
  it("🔴 keep-alive 是 ref'd（hasRef()===true——unref'd reaper timer 下独立进程的生死线；unref'd 实现此处为 false）", () => {
    const g = assembleRenderGuardian({ defaultIdleMs: 60_000 });
    expect(g).not.toBeNull();
    // Node 语义：ref'd interval → hasRef()=true；若实现误照 reaper timer 照抄
    // .unref()，此处为 false（出生死形态——进程级真退由集成测试钉死）
    expect(g!.keepAlive.hasRef()).toBe(true);
    g!.shutdown();
  });

  it("defaultIdleMs ≤ 0 → 不装配（返 null——idle opt-out）", () => {
    expect(assembleRenderGuardian({ defaultIdleMs: 0 })).toBeNull();
    expect(assembleRenderGuardian({ defaultIdleMs: -1 })).toBeNull();
  });

  it("readLedgerFn 过滤只看 render 记录 + stopFn 接线 + exitWhenLedgerEmptyTicks=2", async () => {
    await recordLaunch(makeRec({ port: 9224, pid: 1, launchMode: "render" }));
    await recordLaunch(makeRec({ port: 9225, pid: 2, launchMode: "hidden" }));
    const captured: Array<Record<string, unknown>> = [];
    const stopCalls: Array<{ port: number }> = [];
    const g = assembleRenderGuardian({
      defaultIdleMs: 60_000,
      startReaperFn: ((o: Record<string, unknown>) => {
        captured.push(o);
        return {
          touch: () => {},
          stop: () => {},
        };
      }) as never,
      stopFn: async (o) => {
        stopCalls.push(o);
      },
    });
    expect(g).not.toBeNull();
    expect(captured).toHaveLength(1);
    const opts = captured[0]! as {
      exitWhenLedgerEmptyTicks?: number;
      readLedgerFn?: () => LaunchedChromeRecord[];
      stopFn?: (o: { port: number }) => Promise<unknown>;
      defaultIdleMs?: number;
    };
    expect(opts.exitWhenLedgerEmptyTicks).toBe(2);
    expect(opts.defaultIdleMs).toBe(60_000);
    // readLedgerFn：只看 render（hidden 9225 被滤掉）
    expect(opts.readLedgerFn!().map((r) => r.port)).toEqual([9224]);
    // stopFn 接线（收割出口）
    await opts.stopFn!({ port: 9224 });
    expect(stopCalls).toEqual([{ port: 9224 }]);
    g!.shutdown();
  });

  it("onIdleExit → shutdown（reaper.stop + onShutdown 回调——CLI 层 exit(0) 接线点；幂等）", () => {
    const onShutdown = vi.fn();
    let reaperStopped = 0;
    const g = assembleRenderGuardian({
      defaultIdleMs: 60_000,
      onShutdown,
      startReaperFn: (() =>
        ({
          touch: () => {},
          stop: () => {
            reaperStopped++;
          },
        }) as never) as never,
    });
    expect(g).not.toBeNull();
    g!.shutdown();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(reaperStopped).toBe(1); // reaper 一并停（timer 清理）
    // 幂等（onIdleExit 与 SIGTERM/SIGINT 双触发不重复）
    g!.shutdown();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(reaperStopped).toBe(1);
  });
});

describe("runRenderGuardianCli —— 入口行为", () => {
  it("后到者让位：probe 见他者在世 → exit(0) 且不装配", async () => {
    const exits: number[] = [];
    let assembleCalls = 0;
    await runRenderGuardianCli({
      probe: { running: true, pid: 999888, reason: "ok" },
      assemble: (() => {
        assembleCalls++;
        return null;
      }) as never,
      exitFn: ((code?: number) => {
        exits.push(code ?? 0);
      }) as never,
    });
    expect(exits).toEqual([0]);
    expect(assembleCalls).toBe(0);
  });

  it("正常路径：自写 pidfile + 装配 + 不 exit（keep-alive 持活等账空自退/信号）", async () => {
    const exits: number[] = [];
    const g = assembleRenderGuardian({ defaultIdleMs: 60_000 })!;
    const assembled = {
      keepAlive: g.keepAlive,
      reaper: g.reaper,
      shutdown: () => g.shutdown(),
    };
    await runRenderGuardianCli({
      probe: { running: false, reason: "no_pidfile" },
      assemble: () => assembled,
      // 不抛（抛会在 teardown 信号触达 bye 时变 unhandled）——只记录
      exitFn: ((code?: number) => {
        exits.push(code ?? 0);
      }) as never,
    });
    expect(exits).toEqual([]); // 主流程不退——keep-alive 持活
    // 自写 pidfile（自己 pid 是唯一权威）
    const pidfile = JSON.parse(readFileSync(pidPath, "utf8")) as { pid: number };
    expect(pidfile.pid).toBe(process.pid);
    g.shutdown();
  });
});

describe("assembleRenderGuardian —— 嵌入 reaper 行为（真 startChromeIdleReaper）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("touch mtime 新于阈值不收割；陈旧则收割（stopFn 收 {port}——外部 touch 信号真源）", async () => {
    await recordLaunch(makeRec({ launchedAt: 0, idleMs: 60_000 }));
    const stopCalls: Array<{ port: number }> = [];
    // 真实 touch 文件（LASSO_CHROME_TOUCH_DIR=tmpDir 隔离；mtime 即外部信号）
    const touchFile = path.join(tmpDir, "chrome-touch-9224");
    writeFileSync(touchFile, "0\n", "utf8");
    const setTouchMtime = (ms: number) =>
      fs.utimes(touchFile, new Date(ms), new Date(ms));
    await setTouchMtime(50_000); // 25s 前的信号（< 60s idle 窗）
    const g = assembleRenderGuardian({
      defaultIdleMs: 60_000,
      intervalMs: CHROME_IDLE_REAPER_INTERVAL_MS,
      stopFn: async (o) => {
        stopCalls.push(o);
      },
    });
    expect(g).not.toBeNull();
    vi.setSystemTime(75_000);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(stopCalls).toEqual([]); // lastUse=50s → 距今 25s < 60s：不收割
    await setTouchMtime(10_000); // 65s 前的陈旧信号
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(stopCalls).toEqual([{ port: 9224 }]); // max(0,0,10s)=10s → 距今 65s：收割
    g!.shutdown();
  });
});
