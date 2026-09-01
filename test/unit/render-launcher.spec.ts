/**
 * render-launcher.spec.ts（v1.19 渲染档设计决议 —— ensure 引擎全链）
 *
 * 守护点（设计决议 §8.1）：
 *  - spawn 参数：冻结旗标全集 + --remote-debugging-port + user-data-dir 前缀 + about:blank；
 *    detached + stdio ignore + unref
 *  - 台账记录形状（launchMode:"render" / idleMs 默认 600_000 / env 覆盖 / cdp_not_ready）
 *  - reused 四条件门：正例（pid 活 + cmdline marker + CDP 200 → reused:true 零 spawn）
 *  - 🔴 r2 负例：陈账 + 端口被占（pid 死 / pid 活但 cmdline 无 marker）→ 绝不
 *    reused:true；走收尸（stopFn）→ 重拉 TCP 探测 → exit 3
 *  - 单飞锁：并发双 acquire 只一 spawn；持锁者死后夺锁；败者轮询转正 / 超时 exit 4 /
 *    第三方 CDP 持续 → exit 3
 *  - 退出码 2（chrome_not_found）/ 4（超时 + cdp_not_ready 记录）
 *  - touchPath 字段 = chromeTouchPath(port)；ensure 成功自 touch
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ChildProcess } from "node:child_process";
import {
  launchRenderChrome,
  probeRenderHealth,
  acquireRenderLaunchLock,
  renderLaunchLockPath,
  RENDER_LOCK_STALE_MS,
  tcpConnectable,
} from "../../src/render/render-launcher.js";
import {
  recordLaunch,
  readLedgerSync,
  type LaunchedChromeRecord,
} from "../../src/launcher/chrome-ledger.js";
import { chromeTouchPath, chromeTouchMtimeSync } from "../../src/launcher/chrome-touch.js";
import { RENDER_DETERMINISTIC_FLAGS, RENDER_PROFILE_PREFIX } from "../../src/render/render-flags.js";

// ============================================================
// helpers
// ============================================================
let tmpDir: string;
let ledgerPath: string;
let profileBase: string;
let lockDir: string;
let touchDir: string;

const WS = "ws://127.0.0.1:9224/devtools/browser/test-uuid-0001";

/** CDP /json/version 成功响应 fetchFn 形状。 */
const okVersionFetch = async () => ({
  ok: true,
  json: async () => ({ webSocketDebuggerUrl: WS, Browser: "Chrome/140.0" }),
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-render-launch-"));
  ledgerPath = path.join(tmpDir, "launched-chromes.json");
  profileBase = path.join(tmpDir, "profiles");
  lockDir = path.join(tmpDir, "locks");
  touchDir = path.join(tmpDir, "touch");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
  process.env.LASSO_CHROME_TOUCH_DIR = touchDir;
  delete process.env.LASSO_RENDER_IDLE_MS;
  delete process.env.LASSO_RENDER_PORT;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_CHROME_TOUCH_DIR;
  delete process.env.LASSO_RENDER_IDLE_MS;
  delete process.env.LASSO_RENDER_PORT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface SpawnRecorder {
  calls: Array<{ cmd: string; args: string[]; opts: { detached: boolean; stdio: string } }>;
  unrefCalls: number;
}

function makeSpawnFn(pid = 55501): { rec: SpawnRecorder; fn: () => ChildProcess } {
  const rec: SpawnRecorder = { calls: [], unrefCalls: 0 };
  const fn = (() =>
    ({
      pid,
      unref: () => {
        rec.unrefCalls++;
      },
      on: () => {},
    }) as unknown as ChildProcess) as never as () => ChildProcess;
  // 包装记录（保持 spawnFn 签名 (cmd, args, opts)）
  const wrapped = ((cmd: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => {
    rec.calls.push({ cmd, args, opts });
    return fn();
  }) as unknown as () => ChildProcess;
  return { rec, fn: wrapped as unknown as () => ChildProcess };
}

/** 通用注入包（happy-path 默认）。 */
function baseOpts(extra: Record<string, unknown> = {}) {
  return {
    port: 9224,
    platform: "mac" as const,
    probeExists: async () => true,
    spawnFn: makeSpawnFn().fn as never,
    profileBaseDir: profileBase,
    lockDir,
    tcpProbeFn: async () => false,
    ensureGuardianFn: async () => {},
    probeIntervalMs: 1,
    launchTimeoutMs: 2_000,
    logFn: () => {},
    ...extra,
  };
}

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9224,
    pid: 4242,
    profileDir: "/tmp/render-chrome-profile-test-0001",
    launchedAt: Date.now(),
    status: "ready",
    launchMode: "render",
    ...overrides,
  };
}

/** 归属验证通过的 psFn（cmdline 含 --user-data-dir=<profileDir> marker）。 */
function ownerPsFn(profileDir: string) {
  return () => `/Applications/Google Chrome.app --headless=new --user-data-dir=${profileDir} --remote-debugging-port=9224\n`;
}

// ============================================================
// tests
// ============================================================
describe("render-launcher —— spawn 参数与台账形状", () => {
  it("spawn 参数与成功路径完整断言（fresh launch → ready 记录 + touch + guardian + reused:false）", async () => {
    const { rec, fn } = makeSpawnFn(55601);
    let calls = 0;
    const guardianCalls: number[] = [];
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        // 第 1 次（gate 探活）失败 → spawn → 后续探活成功
        fetchFn: (async () => (++calls >= 3 ? await okVersionFetch() : { ok: false, json: async () => ({}) })) as never,
        ensureGuardianFn: async () => {
          guardianCalls.push(1);
        },
      }) as never,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reused).toBe(false);
      expect(r.wsEndpoint).toBe(WS);
      expect(r.port).toBe(9224);
      expect(r.pid).toBe(55601);
      expect(r.touchPath).toBe(chromeTouchPath(9224));
      expect(r.profileDir).toContain(RENDER_PROFILE_PREFIX);
    }
    // spawn 形状
    expect(rec.calls).toHaveLength(1);
    const spawn = rec.calls[0]!;
    expect(spawn.opts).toEqual({ detached: true, stdio: "ignore" });
    expect(rec.unrefCalls).toBe(1);
    for (const flag of RENDER_DETERMINISTIC_FLAGS) {
      expect(spawn.args).toContain(flag);
    }
    expect(spawn.args).toContain("--remote-debugging-port=9224");
    const udd = spawn.args.find((a) => a.startsWith(`--user-data-dir=`));
    expect(udd).toBeDefined();
    expect(path.basename(udd!.replace("--user-data-dir=", "")).startsWith(RENDER_PROFILE_PREFIX)).toBe(true);
    expect(spawn.args[spawn.args.length - 1]).toBe("about:blank");
    // 台账记录形状
    const ledger = readLedgerSync();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      port: 9224,
      pid: 55601,
      launchMode: "render",
      status: "ready",
      idleMs: 600_000, // 默认（LASSO_RENDER_IDLE_MS 未设）
    });
    expect(ledger[0]!.launchedAt).toBe(r.ok ? r.startedAt : 0);
    // touch 文件已建（ensure 成功自 touch 给宽限）
    expect(chromeTouchMtimeSync(9224)).toBeGreaterThan(0);
    // guardian 补拉（r2：fresh 成功路径）
    expect(guardianCalls).toHaveLength(1);
  });

  it("LASSO_RENDER_IDLE_MS 覆盖落台账；=0 是合法 opt-out 记录", async () => {
    process.env.LASSO_RENDER_IDLE_MS = "45000";
    const { rec, fn } = makeSpawnFn(55602);
    let calls = 0;
    await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        fetchFn: (async () => (++calls >= 3 ? await okVersionFetch() : { ok: false, json: async () => ({}) })) as never,
      }) as never,
    );
    expect(readLedgerSync()[0]!.idleMs).toBe(45_000);
  });

  it("chrome 二进制不存在 → exit 2", async () => {
    const r = await launchRenderChrome(baseOpts({ probeExists: async () => false }) as never);
    expect(r).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("CDP 永不就绪 → exit 4 + cdp_not_ready 记录（launch 时刻不代杀慢启动——launch-chrome 先例）", async () => {
    const { rec, fn } = makeSpawnFn(55603);
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        fetchFn: (async () => ({ ok: false, json: async () => ({}) })) as never,
        launchTimeoutMs: 150,
      }) as never,
    );
    expect(r).toMatchObject({ ok: false, exitCode: 4 });
    const ledger = readLedgerSync();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ pid: 55603, launchMode: "render", status: "cdp_not_ready" });
  });
});

describe("render-launcher —— reused 四条件门（r2）", () => {
  it("正例：台账 render 记录 + pid 活 + cmdline marker + CDP 200 → reused:true 零 spawn + 补拉 guardian", async () => {
    const rec0 = makeRec();
    await recordLaunch(rec0);
    const { rec, fn } = makeSpawnFn();
    const guardianCalls: number[] = [];
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        fetchFn: okVersionFetch as never,
        aliveFn: () => true,
        psFn: ownerPsFn(rec0.profileDir),
        ensureGuardianFn: async () => {
          guardianCalls.push(1);
        },
      }) as never,
    );
    expect(r).toMatchObject({
      ok: true,
      reused: true,
      wsEndpoint: WS,
      startedAt: rec0.launchedAt, // 与台账 launchedAt 同源
      pid: rec0.pid,
    });
    expect(rec.calls).toHaveLength(0); // 零 spawn
    expect(guardianCalls).toHaveLength(1); // r2：reused 分支也补拉执守
    expect(chromeTouchMtimeSync(9224)).toBeGreaterThan(0); // 自 touch
  });

  it("🔴 负例 A（陈账 + pid 死 + 端口被第三方 CDP 占）：不产 reused → 收尸 → 重拉 TCP 探测 exit 3", async () => {
    const rec0 = makeRec({ pid: 4242 });
    await recordLaunch(rec0);
    const { rec, fn } = makeSpawnFn();
    const stopCalls: Array<{ port: number }> = [];
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        fetchFn: okVersionFetch as never, // 第三方 CDP 对 /json/version 一律 200
        aliveFn: () => false, // 台账 pid 已死（陈留）
        stopFn: async (o) => {
          stopCalls.push(o);
        },
        tcpProbeFn: async () => true, // 重拉前 TCP 探测：端口被占
        probeIntervalMs: 1,
      }) as never,
    );
    expect(r).toMatchObject({ ok: false, exitCode: 3 });
    expect(stopCalls).toEqual([{ port: 9224 }]); // 收尸走了 chrome-stop 出口
    expect(rec.calls).toHaveLength(0); // 绝不 spawn 到被占端口
  });

  it("🔴 负例 B（pid 活但 cmdline 无 marker = pid 复用）：不产 reused → 收尸（绝不杀非归属 pid）→ exit 3", async () => {
    const rec0 = makeRec({ pid: 4243 });
    await recordLaunch(rec0);
    const { rec, fn } = makeSpawnFn();
    const stopCalls: Array<{ port: number }> = [];
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        fetchFn: okVersionFetch as never,
        aliveFn: () => true, // pid 在
        psFn: () => "/Applications/Safari.app/Contents/MacOS/Safari --some-flag", // 但不是我们的 Chrome
        stopFn: async (o) => {
          stopCalls.push(o);
        },
        tcpProbeFn: async () => true,
      }) as never,
    );
    expect(r).toMatchObject({ ok: false, exitCode: 3 });
    expect(stopCalls).toEqual([{ port: 9224 }]);
    expect(rec.calls).toHaveLength(0);
  });

  it("负例 C（进程在 + 归属通过但 CDP 不健康）：收尸后重拉成功（消费方无感重生）", async () => {
    const rec0 = makeRec({ pid: 4244 });
    await recordLaunch(rec0);
    const { rec, fn } = makeSpawnFn(55604);
    const stopCalls: Array<{ port: number }> = [];
    let calls = 0;
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        // gate 探活失败 ×2（gate0 + 无 cdpUp 不进复查分支）→ spawn 后成功
        fetchFn: (async () => {
          calls++;
          if (rec.calls.length > 0) return await okVersionFetch();
          return { ok: false, json: async () => ({}) };
        }) as never,
        aliveFn: () => true,
        psFn: ownerPsFn(rec0.profileDir),
        stopFn: async (o) => {
          stopCalls.push(o);
          // 收尸清账（模拟 chrome-stop already_dead/pid_reused 后删台账）
          const { removeLedgerEntries } = await import("../../src/launcher/chrome-ledger.js");
          await removeLedgerEntries([o.port]);
        },
        tcpProbeFn: async () => false,
      }) as never,
    );
    expect(r).toMatchObject({ ok: true, reused: false, pid: 55604 });
    expect(stopCalls).toEqual([{ port: 9224 }]);
    expect(readLedgerSync()[0]!.pid).toBe(55604); // 新记录
  });
});

describe("render-launcher —— 单飞锁", () => {
  it("acquireRenderLaunchLock：wx 独占；并发第二 acquire locked:false；release 后可再取", () => {
    const l1 = acquireRenderLaunchLock(9224, { lockDir });
    expect(l1.locked).toBe(true);
    const l2 = acquireRenderLaunchLock(9224, { lockDir });
    expect(l2.locked).toBe(false);
    l1.release();
    const l3 = acquireRenderLaunchLock(9224, { lockDir });
    expect(l3.locked).toBe(true);
    l3.release();
  });

  it("持锁者 pid 已死且锁龄超陈化阈值 → 夺锁", async () => {
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      renderLaunchLockPath(9224, lockDir),
      `${JSON.stringify({ pid: 999999, ts: Date.now() - RENDER_LOCK_STALE_MS - 5_000 })}\n`,
    );
    const l = acquireRenderLaunchLock(9224, { lockDir, aliveFn: () => false });
    expect(l.locked).toBe(true);
    l.release();
  });

  it("持锁者在世 → 不夺锁（fresh lock）", async () => {
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      renderLaunchLockPath(9224, lockDir),
      `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`,
    );
    const l = acquireRenderLaunchLock(9224, { lockDir });
    expect(l.locked).toBe(false);
    expect(l.holderPid).toBe(process.pid);
  });

  it("败者轮询转正：持锁者完成拉起（台账落盘 + CDP 通）→ reused:true 零 double-launch", async () => {
    // 预占锁（模拟并发先到者）
    const holder = acquireRenderLaunchLock(9224, { lockDir });
    expect(holder.locked).toBe(true);
    const { rec, fn } = makeSpawnFn();
    let holderDone = false;
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        fetchFn: (async () => {
          // 模拟持锁者在 ~10ms 后完成：台账落盘 + CDP 通
          if (holderDone) return await okVersionFetch();
          await new Promise((res) => setTimeout(res, 10));
          holderDone = true;
          await recordLaunch(makeRec({ pid: 777001 }));
          return await okVersionFetch();
        }) as never,
        aliveFn: () => true,
        psFn: ownerPsFn(makeRec().profileDir),
        launchTimeoutMs: 3_000,
      }) as never,
    );
    expect(r).toMatchObject({ ok: true, reused: true, pid: 777001 });
    expect(rec.calls).toHaveLength(0); // 败者绝不 double-launch
    holder.release();
  });

  it("败者超时（持锁者在世但始终不健康）→ exit 4", async () => {
    const holder = acquireRenderLaunchLock(9224, { lockDir });
    expect(holder.locked).toBe(true);
    const { rec, fn } = makeSpawnFn();
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        fetchFn: (async () => ({ ok: false, json: async () => ({}) })) as never,
        launchTimeoutMs: 200,
      }) as never,
    );
    expect(r).toMatchObject({ ok: false, exitCode: 4 });
    expect(rec.calls).toHaveLength(0);
    holder.release();
  });

  it("败者见第三方 CDP（无台账持续）→ deadline 后 exit 3（非 4——端口确有非我方 CDP）", async () => {
    const holder = acquireRenderLaunchLock(9224, { lockDir });
    expect(holder.locked).toBe(true);
    const { rec, fn } = makeSpawnFn();
    const r = await launchRenderChrome(
      baseOpts({
        spawnFn: fn as never,
        fetchFn: okVersionFetch as never, // CDP 在响应，但台账永远无 render 记录
        launchTimeoutMs: 200,
      }) as never,
    );
    expect(r).toMatchObject({ ok: false, exitCode: 3 });
    expect(rec.calls).toHaveLength(0);
    holder.release();
  });
});

describe("render-launcher —— 杂项导出", () => {
  it("probeRenderHealth：非 200 / 异常 / ws 字段形状不对 → ok:false", async () => {
    expect(await probeRenderHealth(9224, (async () => ({ ok: false, json: async () => ({}) })) as never)).toMatchObject({ ok: false });
    expect(
      await probeRenderHealth(9224, (async () => {
        throw new Error("ECONNREFUSED");
      }) as never),
    ).toMatchObject({ ok: false });
    expect(
      await probeRenderHealth(9224, (async () => ({ ok: true, json: async () => ({ nope: 1 }) })) as never),
    ).toMatchObject({ ok: false });
  });

  it("tcpConnectable：本机未监听高端口 → false（真实 socket 路径冒烟）", async () => {
    // 选一个几乎必然空闲的端口（不 bind 直接探——connect 被拒即 false）
    expect(await tcpConnectable(59999)).toBe(false);
  });
});
