/**
 * a2-zombie-selfheal.spec.ts（BUG-03 决议 A2/E①，doc/bugs/03 §4 A2 + §4 C）
 *
 * 消费方①僵尸占位根治的行为面回归：
 *  - 自家挂死 hidden Chrome（CDP 死进程活）被误归因「非 CDP 进程」只建议换口 →
 *    doctor 建议死循环。A2 后 launch-chrome 在 port_in_use_non_cdp 门前做台账
 *    归因：占用者 == 台账在案 pid 且归属验证通过 → 判自家挂死 Chrome → 收尸
 *    重拉（ledger_zombie_collected）；归因不成立 → 三分类出口（含用户资产
 *    禁 kill 指引 token never_kill_user_asset，决议 C）。
 *  - doctor checkCdp9222 catch/非 ok 分支三分类（classifyPortOccupierNextStep），
 *    删 `open -na` 建议（实测逃不出同 bundle id 单实例槽位——INV-87 grep 禁令）。
 *
 * 全 DI 注入（readLedgerFn / stopZombieFn / aliveFn / psFn）——零真 kill、
 * 零真 ps、台账经 LASSO_LAUNCHED_CHROMES_PATH 隔离。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordLaunch, type LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";
import { launchChrome } from "../../src/launcher/launch-chrome.js";
import { stopLaunchedChromes } from "../../src/launcher/chrome-stop.js";
import { classifyPortOccupierNextStep } from "../../src/doctor/doctor.js";

let tmpDir: string;
const PROFILE = "/tmp/lasso-a2-profile";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-a2-zombie-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "launched-chromes.json");
  process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(tmpDir, "desired-hidden.json");
  process.env.LASSO_CHROME_TOUCH_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_DESIRED_HIDDEN_PATH;
  delete process.env.LASSO_CHROME_TOUCH_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 66111,
    profileDir: PROFILE,
    launchedAt: Date.now(),
    status: "ready",
    launchMode: "hidden",
    ...overrides,
  };
}

/** launchChrome 装配（fetch 全失败 + TCP 恒占用 = port_in_use_non_cdp 门路径）。 */
function makeLaunchOpts(overrides: Record<string, unknown> = {}) {
  return {
    platform: "mac" as const,
    probeExists: async () => true,
    spawnFn: (() => ({ unref() {}, on() {}, pid: 42 })) as never,
    fetchFn: async () => ({ ok: false }),
    probeIntervalMs: 1,
    probeAttempts: 1,
    defaultProfileDir: "/tmp/x",
    hideFn: () => ({ ok: false }), // fuse 失败不记粘滞账（隔离 desired-hidden 面）
    ensureEnforcerFn: async () => {},
    tcpProbeFn: async () => true,
    ...overrides,
  };
}

// ============================================================
// launch-chrome 僵尸归因收尸重拉
// ============================================================
describe("A2 · launch-chrome 僵尸占位自愈", () => {
  it("1a. 自家僵尸（台账在案 + pid 活 + 归属通过）→ 收尸重拉：stopZombieFn 调 + 继续spawn + ledger_zombie_collected 日志", async () => {
    await recordLaunch(makeRec());
    const stopCalls: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    let fetchCalls = 0;
    const r = await launchChrome(
      makeLaunchOpts({
        // 预检 fetch（第 1 次）非 ok + TCP 占用 → 进归因门；收尸后 attempt 探活
        // （第 2 次起）转 ok → spawn 成功路径
        fetchFn: async () => ({ ok: ++fetchCalls >= 2 }),
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
        aliveFn: () => true,
        psFn: () => `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222\n`,
        logFn: (p: Record<string, unknown>) => logs.push(p),
      }),
    );
    expect(stopCalls).toEqual([9222]); // 收尸出口被调（默认 = chrome-stop 验证路径）
    expect(logs.some((p) => p.evt === "ledger_zombie_collected")).toBe(true);
    expect(r.ok).toBe(true); // 收尸后落入正常 spawn 流程
  });

  it("1b. 用户资产/外部占用（台账无记录）→ 三分类拒绝：never_kill_user_asset 指引 + 零收尸零 spawn", async () => {
    let spawnCalled = false;
    const stopCalls: number[] = [];
    const r = await launchChrome(
      makeLaunchOpts({
        spawnFn: (() => {
          spawnCalled = true;
          return { unref() {}, on() {}, pid: 42 };
        }) as never,
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/port_in_use_non_cdp/);
    expect(r.error).toMatch(/never_kill_user_asset/); // INV-87 指引 token
    expect(r.error).toMatch(/ledger_zombie_collected/); // 三分类出口自述
    expect(stopCalls).toHaveLength(0); // 绝不对非台账资产施杀
    expect(spawnCalled).toBe(false);
  });

  it("1c. 台账记录 pid 已死（非我方占口）→ 不收尸、按外部占用三分类拒绝", async () => {
    await recordLaunch(makeRec({ pid: 66112 }));
    const stopCalls: number[] = [];
    const r = await launchChrome(
      makeLaunchOpts({
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
        aliveFn: () => false,
        psFn: () => "",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/port_in_use_non_cdp/);
    expect(stopCalls).toHaveLength(0);
  });

  it("1d. 台账记录但归属验证失败（pid 复用）→ 不收尸、按外部占用拒绝（E8 同源红线）", async () => {
    await recordLaunch(makeRec());
    const stopCalls: number[] = [];
    const r = await launchChrome(
      makeLaunchOpts({
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
        aliveFn: () => true,
        psFn: () => "/usr/sbin/syslogd", // pid 复用为无关进程
      }),
    );
    expect(r.ok).toBe(false);
    expect(stopCalls).toHaveLength(0);
  });
});

// ============================================================
// doctor 三分类归因
// ============================================================
describe("A2 · doctor classifyPortOccupierNextStep 三分类", () => {
  it("2a. 自家僵尸 → 建议 chrome-stop --port N 清僵尸后重拉", async () => {
    await recordLaunch(makeRec());
    const step = classifyPortOccupierNextStep(9222, {
      aliveFn: () => true,
      psFn: () => `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222\n`,
    });
    expect(step).toMatch(/chrome-stop --port 9222/);
    expect(step).toMatch(/pid 66111/);
  });

  it("2b. 陈留记录（pid 死/归属不符）→ 清账建议（区分僵尸与陈旧）", async () => {
    await recordLaunch(makeRec());
    const step = classifyPortOccupierNextStep(9222, {
      aliveFn: () => false,
      psFn: () => "",
    });
    expect(step).toMatch(/陈留/);
    expect(step).toMatch(/chrome-stop --port 9222/);
  });

  it("2c. 用户资产/未知占用 → 如实报告永不代杀（never_kill_user_asset）", () => {
    const step = classifyPortOccupierNextStep(9222, {});
    expect(step).toMatch(/never_kill_user_asset/);
    expect(step).toMatch(/用户/);
  });

  it("2d. INV-87 测试面镜像：doctor 源码零 open -na + checkCdp9222 归因接线", () => {
    const src = readFileSync("src/doctor/doctor.ts", "utf8");
    expect(src).not.toMatch(/open -na/); // grep 禁令（实测逃不出单实例槽位）
    // catch 与 !ok 两分支都走归因（三分类接线）
    const occurrences = src.match(/classifyPortOccupierNextStep\(port, deps\)/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("2e. 决议 C：chrome-stop 结果行携带 launchMode（--all 全停输出面强化）", async () => {
    await recordLaunch(makeRec({ launchMode: "hidden" }));
    const r = await stopLaunchedChromes({
      aliveFn: () => false, // already_dead 快路径
    });
    expect(r.stopped[0]!.launchMode).toBe("hidden");
  });
});
