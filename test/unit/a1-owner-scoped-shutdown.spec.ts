/**
 * a1-owner-scoped-shutdown.spec.ts（BUG-03 决议 A1，doc/bugs/03 §4 A1 + §4.0-F3）
 *
 * 消费方③连坐死根治的行为面回归：任意 lasso server 进程退出按机器级全局台账
 * 扫杀全部 hidden Chrome（cc-control 实战真机复现 killed）——违背 CLI idleMs:0
 * 「external CDP consumers stay alive」承诺。
 *
 * 铁律（INV-86）：**任何进程退出只许收自己拉起的 Chrome**（ownerPid === 自己）。
 * 三维收割谓词：modes × owner × userTakenAt 豁免（F3：owner===self 且 userTakenAt
 * 的记录也不收且台账条目保留——B1 让位语义在停机路径兑现，等同 visible 红线）。
 *
 * 覆盖面：
 *  1. 台账 schema 三字段（ownerKind/ownerPid/userTakenAt）写读往返 + 非法降级
 *  2. stopLaunchedChromes / stopLaunchedChromesSync 三面：
 *     他 owner 不收（台账保留）/ 旧无 owner 陈留不收（归「无人」）/ own+userTakenAt
 *     不收且台账保留；own 无 userTakenAt 照收
 *  3. chrome-stop CLI 语义（不传 ownerPid）：全收（用户显式 = 最高权限）
 *  4. idle reaper 对 userTakenAt 记录禁收（F4 倒挂修复面：窗口在用户面前被关）
 *  5. enforcer 双职责第二职责（startEnforcerIdleReaper）：hidden 档 idle 收割 +
 *     默认 readLedgerFn 过滤（不动 render/visible）+ defaultIdleMs 默认 30min
 *  6. CLI 默认 idle 单一真源常量 + index.ts 路由消费锚
 *  7. runHideEnforcerCli 双职责自退闩白盒锚（两职责都 idle 才 exit）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recordLaunch,
  readLedgerSync,
  CLI_LAUNCH_IDLE_DEFAULT_MS,
  type LaunchedChromeRecord,
} from "../../src/launcher/chrome-ledger.js";
import {
  stopLaunchedChromes,
  stopLaunchedChromesSync,
} from "../../src/launcher/chrome-stop.js";
import { startChromeIdleReaper, CHROME_IDLE_REAPER_INTERVAL_MS } from "../../src/launcher/chrome-idle-reaper.js";
import { startEnforcerIdleReaper } from "../../src/launcher/desired-hide-enforcer.js";

let tmpDir: string;

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 111,
    profileDir: "/tmp/lasso-a1-profile",
    launchedAt: Date.now(),
    status: "ready",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-a1-owner-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "launched-chromes.json");
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** ps 归属注入：所有 pid 都验证通过（杀面测试聚焦 owner/userTakenAt 过滤）。 */
const ownAllPs = (pid: number) =>
  `/Applications/Google Chrome --user-data-dir=/tmp/lasso-a1-profile --remote-debugging-port=${pid}\n`;

// ============================================================
// 1. 台账 schema 三字段往返
// ============================================================
describe("A1 · 台账 schema 归属三字段", () => {
  it("1a. ownerKind/ownerPid/userTakenAt 写读往返（同 port 覆盖保留三字段）", async () => {
    await recordLaunch(
      makeRec({ ownerKind: "cli", ownerPid: 4242, userTakenAt: 1_700_000_000_000 }),
    );
    const rs = readLedgerSync();
    expect(rs).toHaveLength(1);
    expect(rs[0]!.ownerKind).toBe("cli");
    expect(rs[0]!.ownerPid).toBe(4242);
    expect(rs[0]!.userTakenAt).toBe(1_700_000_000_000);
  });

  it("1b. 非法形态降级 undefined（ownerPid 非整数 / userTakenAt 非数 / ownerKind 越界）", async () => {
    const target = path.join(tmpDir, "launched-chromes.json");
    await fs.writeFile(
      target,
      JSON.stringify([
        {
          port: 9222,
          pid: 111,
          profileDir: "/tmp/lasso-a1-profile",
          launchedAt: 1,
          status: "ready",
          ownerKind: "root", // 越界 → undefined
          ownerPid: 1.5, // 非整数 → undefined
          userTakenAt: "soon", // 非数 → undefined
        },
      ]),
      "utf8",
    );
    const rs = readLedgerSync();
    expect(rs).toHaveLength(1);
    expect(rs[0]!.ownerKind).toBeUndefined();
    expect(rs[0]!.ownerPid).toBeUndefined();
    expect(rs[0]!.userTakenAt).toBeUndefined();
  });
});

// ============================================================
// 2. 三维收割谓词（async + sync 双实现三面）
// ============================================================
describe("A1 · stopLaunchedChromes 三维谓词（停机路径形态）", () => {
  it("2a. 他 owner 记录不收、台账保留；旧无 owner 陈留不收（归「无人」）；own 照收", async () => {
    await recordLaunch(makeRec({ port: 9301, pid: 201, ownerPid: 999_999 })); // 他 owner
    await recordLaunch(makeRec({ port: 9302, pid: 202 })); // 陈留无 owner
    await recordLaunch(makeRec({ port: 9303, pid: 203, ownerPid: process.pid })); // own
    const killed: number[] = [];
    const r = await stopLaunchedChromes({
      modes: ["hidden"],
      ownerPid: process.pid,
      exemptUserTaken: true,
      aliveFn: () => true,
      psFn: ownAllPs,
      killTreeFn: (pid) => killed.push(pid),
      sleepFn: async () => {},
    });
    expect(killed).toEqual([203]);
    expect(r.stopped.map((s) => s.port)).toEqual([9303]);
    // 未选中的两条台账保留（永不因他人退出被杀 = 不清账孤儿化）
    expect(readLedgerSync().map((x) => x.port).sort()).toEqual([9301, 9302]);
  });

  it("2b. owner===self 且 userTakenAt：不收且台账条目保留（§4.0-F3——B1 让位语义停机兑现）", async () => {
    await recordLaunch(
      makeRec({ port: 9304, pid: 204, ownerPid: process.pid, userTakenAt: Date.now() }),
    );
    const killed: number[] = [];
    const r = await stopLaunchedChromes({
      modes: ["hidden"],
      ownerPid: process.pid,
      exemptUserTaken: true,
      aliveFn: () => true,
      psFn: ownAllPs,
      killTreeFn: (pid) => killed.push(pid),
      sleepFn: async () => {},
    });
    expect(killed).toEqual([]);
    expect(r.stopped).toHaveLength(0);
    expect(readLedgerSync().map((x) => x.port)).toEqual([9304]); // 条目保留
  });

  it("2c. 不传 ownerPid/exemptUserTaken（chrome-stop CLI 显式形态）：全收（用户显式=最高权限）", async () => {
    await recordLaunch(makeRec({ port: 9305, pid: 205, ownerPid: 999_999, userTakenAt: Date.now() }));
    const killed: number[] = [];
    const r = await stopLaunchedChromes({
      aliveFn: () => true,
      psFn: ownAllPs,
      killTreeFn: (pid) => killed.push(pid),
      sleepFn: async () => {},
    });
    expect(killed).toEqual([205]);
    expect(readLedgerSync()).toHaveLength(0);
  });
});

describe("A1 · stopLaunchedChromesSync 三维谓词（exit 钩子路径）", () => {
  it("2d. exit 钩子同款三面：own+userTakenAt 不收保留 / 他 owner 不收 / own 照收", async () => {
    await recordLaunch(makeRec({ port: 9306, pid: 206, ownerPid: process.pid, userTakenAt: 1 }));
    await recordLaunch(makeRec({ port: 9307, pid: 207, ownerPid: 888_888 }));
    await recordLaunch(makeRec({ port: 9308, pid: 208, ownerPid: process.pid }));
    const killed: number[] = [];
    const r = stopLaunchedChromesSync({
      modes: ["hidden"],
      ownerPid: process.pid,
      exemptUserTaken: true,
      aliveFn: () => true,
      psFn: ownAllPs,
      killTreeFn: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([208]);
    expect(r.stopped.map((s) => s.port)).toEqual([9308]);
    expect(readLedgerSync().map((x) => x.port).sort()).toEqual([9306, 9307]);
  });
});

// ============================================================
// 4. idle reaper 对 userTakenAt 禁收
// ============================================================
describe("A1 · idle reaper userTakenAt 禁收（F4 倒挂修复面）", () => {
  it("4a. userTakenAt 记录超时也不 stopFn（窗口在用户面前被关 = 禁）；同窗普通 hidden 照收", async () => {
    vi.useFakeTimers();
    try {
      const stopCalls: Array<{ port: number }> = [];
      const rec = makeRec({
        port: 9222,
        pid: 111,
        launchMode: "hidden",
        launchedAt: 0,
        userTakenAt: 5_000,
      });
      const plain = makeRec({ port: 9223, pid: 112, launchMode: "hidden", launchedAt: 0 });
      startChromeIdleReaper({
        defaultIdleMs: 60_000,
        readLedgerFn: () => [rec, plain],
        nowFn: () => 10_000_000,
        touchStatFn: () => undefined,
        stopFn: async (o) => {
          stopCalls.push({ port: o.port });
        },
        logFn: () => {},
        intervalMs: CHROME_IDLE_REAPER_INTERVAL_MS,
      });
      await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
      expect(stopCalls.map((s) => s.port)).toEqual([9223]); // 只收未认领的
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================
// 5. enforcer 双职责第二职责
// ============================================================
describe("A1 · startEnforcerIdleReaper（执守 idle 收割职责）", () => {
  it("5a. 默认 readLedgerFn 过滤日常档（B2 后 hidden+headless）：render/visible 不进收割域（render-guardian 自管）", async () => {
    vi.useFakeTimers();
    try {
      await recordLaunch(makeRec({ port: 9222, pid: 111, launchMode: "hidden", launchedAt: 0 }));
      await recordLaunch(makeRec({ port: 9227, pid: 115, launchMode: "headless", launchedAt: 0 }));
      await recordLaunch(makeRec({ port: 9224, pid: 113, launchMode: "render", launchedAt: 0 }));
      await recordLaunch(makeRec({ port: 9225, pid: 114, launchMode: "visible", launchedAt: 0 }));
      const stopCalls: Array<{ port: number }> = [];
      startEnforcerIdleReaper({
        nowFn: () => 10_000_000, // 一切记录都超时
        touchStatFn: () => undefined,
        stopFn: async (o) => {
          stopCalls.push({ port: o.port });
        },
        logFn: () => {},
      });
      await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
      expect(stopCalls.map((s) => s.port).sort()).toEqual([9222, 9227]); // 只收日常档两形态
    } finally {
      vi.useRealTimers();
    }
  });

  it("5b. defaultIdleMs 缺省 = CLI_LAUNCH_IDLE_DEFAULT_MS（30min 单一真源）", () => {
    expect(CLI_LAUNCH_IDLE_DEFAULT_MS).toBe(30 * 60 * 1000);
    // 常量经 startEnforcerIdleReaper 缺省注入（源码锚）
    const src = readFileSync("src/launcher/desired-hide-enforcer.ts", "utf8");
    expect(src).toMatch(
      /defaultIdleMs: opts\.defaultIdleMs \?\? CLI_LAUNCH_IDLE_DEFAULT_MS/,
    );
  });

  it("5c. defaultIdleMs=0（显式禁用收割）→ BUG-06 起 cap-only 模式非 null；双禁用（hardCapMs=0）才 null", () => {
    // BUG-06 决议 A-4/r1（doc/bugs/06，2026-09-10）：执守包装层缺省 24h 硬顶——
    // idle=0 只拆 idle 收割不再连硬顶兜底一起拆（12h 幽灵事故根治点）。
    expect(startEnforcerIdleReaper({ defaultIdleMs: 0, logFn: () => {} })).not.toBeNull();
    // 部署级双禁用（LASSO_LAUNCH_IDLE_MS=0 + LASSO_LAUNCH_HARD_CAP_MS=0 经路由
    // 传入）= 用户裁决，执守只保留粘滞复隐职责（旧 5c 语义的精确收窄形态）
    expect(
      startEnforcerIdleReaper({ defaultIdleMs: 0, hardCapMs: 0, logFn: () => {} }),
    ).toBeNull();
  });
});

// ============================================================
// 6/7. 白盒锚：index.ts 接线 + 执守双职责自退闩
// ============================================================
describe("A1 · 接线白盒锚", () => {
  it("6. index.ts 停机两路径三维谓词 + CLI 默认 idle 消费 + 执守收割阈值传 config", () => {
    const src = readFileSync("src/index.ts", "utf8");
    // 优雅停机 + exit 钩子两路径（INV-86 (a) 的测试面镜像）
    const grace = src.match(/stopLaunchedChromes\(\{[\s\S]{0,260}?\}\)/);
    expect(grace?.[0] ?? "").toMatch(/ownerPid: process\.pid/);
    const exitHook = src.match(/stopLaunchedChromesSync\(\{[\s\S]{0,260}?\}\)/);
    expect(exitHook?.[0] ?? "").toMatch(/ownerPid: process\.pid/);
    // CLI 默认 idle 单一真源消费
    expect(src).toMatch(/: CLI_LAUNCH_IDLE_DEFAULT_MS;/);
    // 执守路由传 config 层收割阈值 + 硬顶（BUG-06 A-4：env 覆盖必达执守宿主）
    expect(src).toMatch(
      /runHideEnforcerCli\(\{\s*defaultIdleMs: enforcerCfg\.launchIdleMs,\s*hardCapMs: enforcerCfg\.launchHardCapMs,\s*\}\)/,
    );
  });

  it("7. runHideEnforcerCli 双职责自退闩：两职责都 idle 才 exit（单职责退出不杀另一职责）", () => {
    const src = readFileSync("src/launcher/desired-hide-enforcer.ts", "utf8");
    expect(src).toMatch(/stickyIdleExited && reapIdleExited/);
    expect(src).toMatch(/startEnforcerIdleReaper\(\{/);
  });

  it("8. launchChrome 落账带归属（ownerKind 缺省 cli + ownerPid=process.pid）", () => {
    const src = readFileSync("src/launcher/launch-chrome.ts", "utf8");
    expect(src).toMatch(/ownerKind: opts\.ownerKind \?\? "cli"/);
    expect(src).toMatch(/ownerPid: process\.pid/);
  });
});
