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
import { recordLaunch, LAUNCH_GRACE_MS, type LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";
import { launchChrome } from "../../src/launcher/launch-chrome.js";
import { stopLaunchedChromes } from "../../src/launcher/chrome-stop.js";
import { classifyPortOccupierNextStep, checkCdp9222 } from "../../src/doctor/doctor.js";

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
    // BUG-04 R3：缺省陈年记录（慢启动宽限窗外——年轻记录有专门测试 1i）
    launchedAt: Date.now() - LAUNCH_GRACE_MS * 10,
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

  // ---- BUG-03 adversarial r2 F1（2026-09-08）：用户拥有记录永不进程序化收尸 ----
  // r1 事故型真机复现：chrome-show 认领（userTakenAt）+ SIGSTOP 模拟 CDP 死 →
  // relaunch 同口 → A2 门把已认领窗口整窗杀掉。修复后该面必须如实拒绝。

  it("1e. userTakenAt 已认领记录 → 永不收尸：user_taken_asset 拒绝 + 零 stopZombieFn 零 spawn + ledger_user_owned_not_collected 打点", async () => {
    await recordLaunch(makeRec({ userTakenAt: Date.now() }));
    let spawnCalled = false;
    const stopCalls: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const r = await launchChrome(
      makeLaunchOpts({
        spawnFn: (() => {
          spawnCalled = true;
          return { unref() {}, on() {}, pid: 42 };
        }) as never,
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
        aliveFn: () => true,
        psFn: () => `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222\n`,
        logFn: (p: Record<string, unknown>) => logs.push(p),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/port_in_use_non_cdp/);
    expect(r.error).toMatch(/user_taken_asset/); // 机器可读 token（agent 区分自愈 vs 用户拥有）
    expect(r.error).toMatch(/never_kill_user_asset/); // INV-87 指引 token 同面保留
    expect(r.error).toMatch(/chrome-stop --port 9222/); // 唯一出口=用户显式 chrome-stop
    expect(stopCalls).toHaveLength(0); // 已认领窗口零程序化杀
    expect(spawnCalled).toBe(false);
    expect(logs.some((p) => p.evt === "ledger_user_owned_not_collected")).toBe(true);
  });

  it("1f. visible 档记录（登录窗，v1.17.3 P1 红线）→ 同面拒绝：不收尸 + user_taken_asset", async () => {
    await recordLaunch(makeRec({ launchMode: "visible" }));
    const stopCalls: number[] = [];
    const r = await launchChrome(
      makeLaunchOpts({
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
        aliveFn: () => true,
        psFn: () => `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222\n`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/user_taken_asset/);
    expect(r.error).toMatch(/launchMode=visible/);
    expect(stopCalls).toHaveLength(0);
  });

  it("1g. headless 档未认领记录 → 仍收尸（修复不过度：无人值守形态无用户面）", async () => {
    await recordLaunch(makeRec({ launchMode: "headless" }));
    const stopCalls: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    let fetchCalls = 0;
    const r = await launchChrome(
      makeLaunchOpts({
        fetchFn: async () => ({ ok: ++fetchCalls >= 2 }),
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
        aliveFn: () => true,
        psFn: () => `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222\n`,
        logFn: (p: Record<string, unknown>) => logs.push(p),
      }),
    );
    expect(stopCalls).toEqual([9222]);
    expect(logs.some((p) => p.evt === "ledger_zombie_collected")).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("1h. render 档记录（guardian 自管域）→ 日常档入口不越权收尸", async () => {
    await recordLaunch(makeRec({ launchMode: "render" }));
    const stopCalls: number[] = [];
    const r = await launchChrome(
      makeLaunchOpts({
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
        aliveFn: () => true,
        psFn: () => `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222\n`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(stopCalls).toHaveLength(0);
    expect(r.error).toMatch(/guardian-managed|user_taken_asset/);
  });

  // ---- BUG-04 决议 A1 R3 回补：年轻 cdp_not_ready 记录不被 zombieCollectible 收割 ----
  it("1i. 年轻记录（< LAUNCH_GRACE_MS）→ 慢启动守卫拒绝收割：STARTING 诚实错误 + 零收尸 + 打点", async () => {
    await recordLaunch(makeRec({ launchedAt: Date.now() - 3_000, status: "cdp_not_ready" }));
    const stopCalls: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const r = await launchChrome(
      makeLaunchOpts({
        stopZombieFn: async (o) => {
          stopCalls.push(o.port);
        },
        aliveFn: () => true,
        psFn: () => `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222\n`,
        logFn: (p: Record<string, unknown>) => logs.push(p),
      }),
    );
    expect(r.ok).toBe(false);
    expect(stopCalls).toHaveLength(0);
    expect(r.error).toMatch(/may still be STARTING/);
    expect(r.error).toMatch(/never_kill_user_asset/);
    expect(logs.some((p) => p.evt === "ledger_launching_not_collected")).toBe(true);
  });
});

// ============================================================
// doctor 三分类归因
// ============================================================
describe("A2 · doctor classifyPortOccupierNextStep 三分类", () => {
  // BUG-04 决议 A4 起：doctor 为渲染器，判定在 chrome-status 单一真源——DI 面随迁
  //（tcpFn/cdpVersionFn/lsofFn/psFn{command,etimeS}/aliveFn 全注入，零真机）。
  const CHROME_CMD = `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222`;
  const doctorDeps = (overrides: Record<string, unknown> = {}) => ({
    tcpFn: async () => true,
    cdpVersionFn: async () => ({ ok: false }),
    cdpListFn: async () => null,
    lsofFn: async () => 66111,
    psFn: () => ({ command: CHROME_CMD, etimeS: 900 }),
    aliveFn: () => true,
    ...overrides,
  });

  it("2a. 自家僵尸 → 建议 chrome-stop --zombie-gate --port N 门槛变体清僵尸（BUG-04 r1：裸 chrome-stop 指引已收敛）", async () => {
    await recordLaunch(makeRec());
    const step = await classifyPortOccupierNextStep(9222, doctorDeps());
    expect(step).toMatch(/chrome-stop --zombie-gate --port 9222/);
    expect(step).toMatch(/pid 66111/);
    expect(step).not.toMatch(/清僵尸.{0,40}chrome-stop --port 9222\n/); // agent 面无裸 chrome-stop
  });

  it("2b. 陈留记录（端口已释放/归属不符）→ 清账建议同用门槛变体（区分僵尸与陈旧）", async () => {
    await recordLaunch(makeRec());
    const step = await classifyPortOccupierNextStep(9222, doctorDeps({ tcpFn: async () => false }));
    expect(step).toMatch(/陈留/);
    expect(step).toMatch(/chrome-stop --zombie-gate --port 9222/);
  });

  it("2c. 用户资产/未知占用 → 如实报告永不代杀（never_kill_user_asset + pid 证据面）", async () => {
    const step = await classifyPortOccupierNextStep(9222, doctorDeps());
    expect(step).toMatch(/never_kill_user_asset/);
    expect(step).toMatch(/用户/);
  });

  it("2d. INV-87 测试面镜像：doctor 源码零 open -na + checkCdp9222 归因接线", () => {
    const src = readFileSync("src/doctor/doctor.ts", "utf8");
    expect(src).not.toMatch(/open -na/); // grep 禁令（实测逃不出单实例槽位）
    // BUG-04 C3 起三分支都走归因（!ok / 空 body / catch——三分类接线）；
    // C3-r1（09-09）补 /json（tabs）面四分支（!ok / 坏 body / 非 array / 请求失败）→ 7
    //（锚随生成点演化同批更新）
    const occurrences = src.match(/classifyPortOccupierNextStep\(port, deps\)/g) ?? [];
    expect(occurrences.length).toBe(7);
  });

  it("2e. 决议 C：chrome-stop 结果行携带 launchMode（--all 全停输出面强化）", async () => {
    await recordLaunch(makeRec({ launchMode: "hidden" }));
    const r = await stopLaunchedChromes({
      aliveFn: () => false, // already_dead 快路径
    });
    expect(r.stopped[0]!.launchMode).toBe("hidden");
  });

  // ---- r2 F1：doctor 归因对用户拥有记录不给「清僵尸」代杀指引 ----

  it("2f. doctor：userTakenAt 已认领占用 → 用户拥有分类（user_taken_asset），不给 chrome-stop 清僵尸指引", async () => {
    await recordLaunch(makeRec({ userTakenAt: Date.now() }));
    const step = await classifyPortOccupierNextStep(9222, doctorDeps());
    expect(step).toMatch(/user_taken_asset/);
    expect(step).toMatch(/never_kill_user_asset/);
    expect(step).toMatch(/用户本人/); // 唯一出口=用户本人跑 chrome-stop（非 agent）
    expect(step).not.toMatch(/清僵尸/); // 不得把用户级权限塞给 agent
  });

  it("2g. doctor：visible 档占用 → 同面用户拥有分类", async () => {
    await recordLaunch(makeRec({ launchMode: "visible" }));
    const step = await classifyPortOccupierNextStep(9222, doctorDeps());
    expect(step).toMatch(/user_taken_asset/);
    expect(step).not.toMatch(/清僵尸/);
  });
});

// ============================================================
// BUG-04 决议 C3：checkCdp9222 detail 措辞如实（四种实测形态，fetchFn DI）
// ============================================================
describe("C3 · doctor checkCdp9222 detail 四形态", () => {
  // next_step 探针全注入拒连（快速 free 面，不触真机）
  const fastDeps = (fetchFn: (url: string) => Promise<Response>) => ({
    fetchFn,
    tcpFn: async () => false,
  });

  it("3a. HTTP 非 2xx → `returned HTTP <status>` + 形态解读（r1：非裸状态码）", async () => {
    const r = await checkCdp9222(
      9222,
      fastDeps(async () => new Response("nope", { status: 503 })),
    );
    expect(r.detail).toBe(
      "CDP /json/version returned HTTP 503 — HTTP answered but not a healthy CDP endpoint " +
        "(a wedged DevTools endpoint or a non-CDP HTTP server can answer like this); " +
        "ownership/pid evidence: see next_step",
    );
    expect(r.status).toBe("fail");
  });

  it("3b. 200 但 body 空/坏 → `connection accepted, empty/invalid body`（事故实测形态——不再笼统 404/裸异常）", async () => {
    const r = await checkCdp9222(
      9222,
      fastDeps(async () => new Response("", { status: 200 })),
    );
    expect(r.detail).toBe("CDP /json/version: connection accepted, empty/invalid body");
    expect(r.status).toBe("fail");
  });

  it("3c. 超时 → `fetch aborted (timeout)`", async () => {
    const r = await checkCdp9222(9222, fastDeps(async () => {
      throw new Error("This operation was aborted due to timeout");
    }));
    expect(r.detail).toBe("CDP /json/version: fetch aborted (timeout)");
  });

  it("3d. 拒连 → `connection refused`（空闲端口形态）", async () => {
    const r = await checkCdp9222(9222, fastDeps(async () => {
      throw new Error("fetch failed: Error: connect ECONNREFUSED 127.0.0.1:9222");
    }));
    expect(r.detail).toBe("CDP /json/version: connection refused");
  });

  it("3e. 健康路径（200 + 合法 body + tabs>0）→ pass（措辞变更零回归）", async () => {
    const r = await checkCdp9222(9222, {
      fetchFn: async (url: string) =>
        url.includes("/json/version")
          ? new Response(JSON.stringify({ Browser: "Chrome/150" }), { status: 200 })
          : new Response(JSON.stringify([{ id: "t1" }, { id: "t2" }]), { status: 200 }),
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("2 tabs on CDP port 9222");
  });

  // ---- C3-r1（09-09 回告收口）：/json（tabs）探测面同规 ----
  // 初版该面无 !ok/坏 body 分支：错误落进外层 catch 被误标成 /json/version 形态
  //（生成点漏改——cdp_9222 探测链 detail 生成点全量清点的产出）。
  const versionOk = () =>
    new Response(JSON.stringify({ Browser: "Chrome/150" }), { status: 200 });

  it("3f. /json 非 2xx → `CDP /json (tabs) returned HTTP <status>`（不再误标 version 面）", async () => {
    const r = await checkCdp9222(
      9222,
      fastDeps(async (url: string) =>
        url.includes("/json/version") ? versionOk() : new Response("nope", { status: 503 }),
      ),
    );
    expect(r.detail).toBe(
      "CDP /json (tabs) returned HTTP 503 — /json/version was healthy but the tab list is not; " +
        "ownership/pid evidence: see next_step",
    );
    expect(r.status).toBe("fail");
    expect(r.detail).not.toMatch(/\/json\/version returned/);
  });

  it("3g. /json 200 但 body 坏 → `CDP /json (tabs): empty/invalid body`", async () => {
    const r = await checkCdp9222(
      9222,
      fastDeps(async (url: string) =>
        url.includes("/json/version") ? versionOk() : new Response("<html>not json</html>", { status: 200 }),
      ),
    );
    expect(r.detail).toBe(
      "CDP /json (tabs): connection accepted, empty/invalid body — /json/version was healthy",
    );
    expect(r.status).toBe("fail");
  });

  it("3h. /json 200 + 非 array body → 同 empty/invalid body 形态（non-array 标注）", async () => {
    const r = await checkCdp9222(
      9222,
      fastDeps(async (url: string) =>
        url.includes("/json/version") ? versionOk() : new Response(JSON.stringify({ err: 1 }), { status: 200 }),
      ),
    );
    expect(r.detail).toBe(
      "CDP /json (tabs): connection accepted, empty/invalid body (non-array) — /json/version was healthy",
    );
    expect(r.status).toBe("fail");
  });

  // 09-09 adversarial 回炉 F-adv-1：C3-r1（5191828）声明「补四分支」但实际仅 +3
  //（3f/3g/3h）——/json（tabs）fetch throw 落进的内层 catch（doctor.ts:1127）零覆盖，
  // 变异把该 detail 前缀误标成 `/json/version` 形态时 95 测试 + INV 全绿（幸存坐实）。
  // 本测锚回第四分支：throw 面 = warn（探测不可判≠死），detail 前缀锚 tabs 面，
  // String(e) 的 "Error:" 前缀如实在场（与 src 模板逐字符对齐）。
  it("3i. /json (tabs) fetch throw（version 健康）→ `CDP /json (tabs) request failed` warn——不回潮 /json/version 误标", async () => {
    const r = await checkCdp9222(
      9222,
      fastDeps(async (url: string) => {
        if (url.includes("/json/version")) return versionOk();
        throw new Error("fetch failed: socket hang up");
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toBe(
      "CDP /json (tabs) request failed: Error: fetch failed: socket hang up — /json/version was healthy",
    );
    // 误标类回潮的专项负锚（detail 尾注 "/json/version was healthy" 是合法在场，
    // 禁的是把它标成 version 面的错误形态前缀）
    expect(r.detail).not.toMatch(/CDP \/json\/version (fetch failed|returned HTTP)/);
  });
});
