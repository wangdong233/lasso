/**
 * download-kill-reconcile.spec.ts（doc/bugs/12 D7/H10 + D4——WT-core 单测）
 *
 * kill 面（mutation-killer：四要素每缺一即拒，删任一检查→必红）：
 *  - shouldKillEngine 真值表（②'pid 一致 / ③marker / ④argv 包含 / 空集守卫）
 *  - killEngineTree 注入式分支：任一要素不过 → killTree 零调用（红线断言）
 *  - 真子进程端到端：真 spawn node（argv 带 marker+taskId）→ killEngineTree
 *    真树杀（parent+sleep 孙进程双亡）；无 marker 的无辜进程 → 拒杀且存活
 *
 * reconcile 面（D4 收养）：
 *  - 注入式：enginePid 死 → failed + diagnosis 原文；pid 复用 → failed+注记
 *  - 真子进程：ownerPid=999999 + 活引擎（marker argv）→ 收养（ownerPid/state
 *    落盘）；二次扫描幂等（untouched）
 *  - 非候选（终态 / 本会话自有）零触碰
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import {
  shouldKillEngine,
  killEngineTree,
  isEnginePidAlive,
  type KillEngineDeps,
} from "../../src/download/kill.js";
import { reconcileOrphans, classifyOrphan, ENGINE_DIED_DIAGNOSIS } from "../../src/download/reconcile.js";
import { createTask, readTask, type DownloadTaskRecord } from "../../src/download/store.js";
import { killTreeSync } from "../../src/util/kill-tree.js";
import { LASSO_DOWNLOAD_ARGV_MARKER, DOWNLOADS_DIR_ENV } from "../../src/download/types.js";

let tmpDir: string;
let root: string;
/** 真子进程登记（afterEach 兜底树杀——测试半路红也不留孤儿，BUG-08 F 纪律）。 */
const liveFixtures: ChildProcess[] = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-download-kill-"));
  root = path.join(tmpDir, "tasks");
  process.env[DOWNLOADS_DIR_ENV] = root;
});

afterEach(async () => {
  for (const c of liveFixtures.splice(0)) {
    try {
      killTreeSync(c.pid!, "test-fixture-cleanup");
    } catch {
      // 已死
    }
  }
  delete process.env[DOWNLOADS_DIR_ENV];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 工具
// ============================================================
function makeRec(overrides: Partial<DownloadTaskRecord> = {}): DownloadTaskRecord {
  const taskId = overrides.taskId ?? randomUUID();
  return {
    taskId,
    kind: "http",
    source: "https://example.com/corpus.tar",
    outDir: "/tmp/out",
    filename: "corpus.tar",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerPid: process.pid,
    engine: "aria2c",
    enginePid: 4242,
    engineCmdline: ["aria2c", "--dir", "/tmp/out", LASSO_DOWNLOAD_ARGV_MARKER, taskId],
    stdioFile: null,
    progress: {
      state: "downloading",
      progress: 0.1,
      speedBps: null,
      etaSec: null,
      downloadedBytes: null,
      totalBytes: null,
    },
    files: [],
    diagnosis: null,
    proxyUsed: null,
    maxBytes: 5 * 1024 * 1024 * 1024,
    subsFile: null,
    ...overrides,
  };
}

/** kill 调用记录器（红线断言用：谓词不过必须零调用）。 */
function killRecorder(): { fn: (pid: number, tag?: string) => void; calls: Array<[number, string?]> } {
  const calls: Array<[number, string?]> = [];
  return { fn: (pid: number, tag?: string) => void calls.push([pid, tag]), calls };
}

async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  deadlineMs = 5_000,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (await fn()) return true; // await：Promise 真值不短路（异步判定必须等结算）
    await new Promise((r) => setTimeout(r, 50));
  }
  return await fn();
}

/**
 * 真引擎 fixture：node 跑 scriptFile（argv = [scriptFile, marker, taskId]——
 * 与真实引擎 spawn 形状一致：marker+taskId 在 argv 里）。可选孙进程（sleep）
 * + PIDFILE 落孙 pid（树杀验证用）。scriptFile 走文件而非 -e：argv 无空格
 * 假设只覆盖引擎面，文件路径永不带空格（mkdtemp + 固定名）。
 */
async function spawnEngineFixture(
  script: string,
  taskId: string,
): Promise<{ child: ChildProcess; grandchildPidFile: string | null }> {
  const scriptFile = path.join(tmpDir, `engine-${taskId}.cjs`);
  await fs.writeFile(scriptFile, script, "utf8");
  const pidFile = script.includes("PIDFILE") ? path.join(tmpDir, `grand-${taskId}.pid`) : null;
  const child = spawn(
    process.execPath,
    [scriptFile, LASSO_DOWNLOAD_ARGV_MARKER, taskId],
    pidFile
      ? { env: { ...process.env, PIDFILE: pidFile }, stdio: "ignore" }
      : { stdio: "ignore" },
  );
  liveFixtures.push(child);
  if (pidFile) {
    const ok = await waitUntil(
      () => fs.stat(pidFile).then(() => true, () => false),
      4_000,
    );
    if (!ok) throw new Error("fixture grandchild pid file 未出现");
  }
  return { child, grandchildPidFile: pidFile };
}

const TREE_SCRIPT = `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const c = spawn("sleep", ["45"]);
fs.writeFileSync(process.env.PIDFILE, String(c.pid));
setInterval(() => {}, 1000);`;

const IDLE_SCRIPT = `setInterval(() => {}, 1000);`;

// ============================================================
// shouldKillEngine 真值表（四要素——删任一检查必红）
// ============================================================
describe("shouldKillEngine —— 杀谓词四要素", () => {
  const TASK_ID = "00000000-0000-4000-8000-000000000000";
  const cmdline = ["aria2c", "--dir", "/tmp/out", LASSO_DOWNLOAD_ARGV_MARKER, TASK_ID];

  it("全要素在场 → true", () => {
    const rec = makeRec({ taskId: TASK_ID, enginePid: 4242, engineCmdline: cmdline });
    expect(shouldKillEngine({ record: rec, enginePid: 4242, cmdlineNow: [...cmdline] })).toBe(true);
  });

  it("②' enginePid 与台账不一致 → false（探的不是台账那只）", () => {
    const rec = makeRec({ enginePid: 4242 });
    expect(
      shouldKillEngine({ record: rec, enginePid: 4243, cmdlineNow: [...rec.engineCmdline] }),
    ).toBe(false);
  });

  it("③ cmdlineNow 缺 marker → false", () => {
    const rec = makeRec({ engineCmdline: ["aria2c", "--dir", "/tmp/out", "00000000-0000-4000-8000-000000000000"] });
    expect(
      shouldKillEngine({
        record: rec,
        enginePid: 4242,
        cmdlineNow: ["aria2c", "--dir", "/tmp/out", "00000000-0000-4000-8000-000000000000"],
      }),
    ).toBe(false);
  });

  it("④ cmdlineNow 缺台账 argv 元素（taskId 不在场）→ false（taskId 不可伪造面）", () => {
    const rec = makeRec();
    expect(
      shouldKillEngine({ record: rec, enginePid: 4242, cmdlineNow: rec.engineCmdline.slice(0, -1) }),
    ).toBe(false);
  });

  it("④ engineCmdline 空台账 → false（vacuous-true 守卫）", () => {
    const rec = makeRec({ engineCmdline: [] });
    expect(shouldKillEngine({ record: rec, enginePid: 4242, cmdlineNow: ["anything"] })).toBe(false);
  });

  it("cmdlineNow 空 / enginePid 非法 → false", () => {
    const rec = makeRec();
    expect(shouldKillEngine({ record: rec, enginePid: 4242, cmdlineNow: [] })).toBe(false);
    expect(shouldKillEngine({ record: rec, enginePid: -1, cmdlineNow: [...rec.engineCmdline] })).toBe(false);
    expect(shouldKillEngine({ record: rec, enginePid: 4242.5, cmdlineNow: [...rec.engineCmdline] })).toBe(false);
  });
});

// ============================================================
// killEngineTree 注入式分支（零动作红线）
// ============================================================
describe("killEngineTree —— 谓词不过即零动作（红线）", () => {
  function deps(over: Partial<KillEngineDeps>): KillEngineDeps {
    return over as KillEngineDeps;
  }

  it("台账无 enginePid → no_engine_pid + killTree 零调用", () => {
    const k = killRecorder();
    const r = killEngineTree(makeRec({ enginePid: null }), "cancel", deps({ killTree: k.fn }));
    expect(r).toMatchObject({ killed: false, action: "no_engine_pid" });
    expect(k.calls).toHaveLength(0);
  });

  it("② pid 已死 → engine_pid_not_alive + 零调用", () => {
    const k = killRecorder();
    const r = killEngineTree(
      makeRec(),
      "cancel",
      deps({ isPidAlive: () => false, killTree: k.fn }),
    );
    expect(r).toMatchObject({ killed: false, action: "engine_pid_not_alive" });
    expect(k.calls).toHaveLength(0);
  });

  it("ps 失败 → cmdline_unverifiable + 零调用（fail-closed）", () => {
    const k = killRecorder();
    const r = killEngineTree(
      makeRec(),
      "cancel",
      deps({ isPidAlive: () => true, psCommand: () => null, killTree: k.fn, log: () => {} }),
    );
    expect(r).toMatchObject({ killed: false, action: "cmdline_unverifiable" });
    expect(k.calls).toHaveLength(0);
  });

  it("③④ 归属不成立（cmdline 无 marker）→ ownership_rejected + 零调用", () => {
    const k = killRecorder();
    const r = killEngineTree(
      makeRec(),
      "cancel",
      deps({
        isPidAlive: () => true,
        psCommand: () => ["/Applications/Safari.app/Contents/MacOS/Safari", "--flag"],
        killTree: k.fn,
        log: () => {},
      }),
    );
    expect(r).toMatchObject({ killed: false, action: "ownership_rejected" });
    expect(k.calls).toHaveLength(0); // 🔴 红线断言：绝不 kill 未验证归属的 pid
  });

  it("四要素全过 → killed + killTree 收到任务定向 logTag", () => {
    const k = killRecorder();
    const rec = makeRec();
    const r = killEngineTree(
      rec,
      "user-cancel",
      deps({
        isPidAlive: () => true,
        psCommand: () => ["aria2c", ...rec.engineCmdline.slice(1)],
        killTree: k.fn,
        log: () => {},
      }),
    );
    expect(r).toMatchObject({ killed: true, action: "killed" });
    expect(k.calls).toEqual([[rec.enginePid, `download-cancel:${rec.taskId}`]]);
  });
});

// ============================================================
// 真子进程端到端（真 ps / 真树杀）
// ============================================================
describe("killEngineTree —— 真子进程端到端", () => {
  it(
    "真引擎（marker+taskId 在 argv）→ 真树杀：parent 与 sleep 孙进程双亡",
    { timeout: 15_000 },
    async () => {
      const taskId = randomUUID();
      const { child, grandchildPidFile } = await spawnEngineFixture(TREE_SCRIPT, taskId);
      const grandPid = Number(await fs.readFile(grandchildPidFile!, "utf8"));
      expect(isEnginePidAlive(child.pid!)).toBe(true);
      expect(isEnginePidAlive(grandPid)).toBe(true);

      const rec = makeRec({
        taskId,
        enginePid: child.pid!,
        engineCmdline: [path.join(tmpDir, `engine-${taskId}.cjs`), LASSO_DOWNLOAD_ARGV_MARKER, taskId],
      });
      const r = killEngineTree(rec, "test-tree-kill");
      expect(r).toMatchObject({ killed: true, action: "killed" });

      expect(await waitUntil(() => !isEnginePidAlive(child.pid!))).toBe(true);
      expect(await waitUntil(() => !isEnginePidAlive(grandPid))).toBe(true); // 树杀非独杀
    },
  );

  it(
    "无辜进程（argv 无 marker）→ ownership_rejected 零动作，进程存活",
    { timeout: 15_000 },
    async () => {
      const taskId = randomUUID();
      // spawn 时省 marker：engine fixture 直接用裸 spawn（不经 helper 的 marker 注入）
      const scriptFile = path.join(tmpDir, `innocent-${taskId}.cjs`);
      await fs.writeFile(scriptFile, IDLE_SCRIPT, "utf8");
      const child = spawn(process.execPath, [scriptFile], { stdio: "ignore" });
      liveFixtures.push(child);
      await waitUntil(() => isEnginePidAlive(child.pid!));

      // 台账谎称这是我们的引擎（engineCmdline 带 marker+taskId）——ps 现值无 marker
      const rec = makeRec({
        taskId,
        enginePid: child.pid!,
        engineCmdline: [scriptFile, LASSO_DOWNLOAD_ARGV_MARKER, taskId],
      });
      const r = killEngineTree(rec, "test-innocent");
      expect(r).toMatchObject({ killed: false, action: "ownership_rejected" });
      expect(isEnginePidAlive(child.pid!)).toBe(true); // 未被杀
    },
  );
});

// ============================================================
// reconcile（D4 孤儿收养）
// ============================================================
describe("reconcileOrphans —— 注入式分支", () => {
  it("enginePid 死 → failed + diagnosis 决议原文 + ownerPid 不变", async () => {
    const rec = makeRec({ ownerPid: 999999, enginePid: 999999 });
    await createTask(rec);
    const r = await reconcileOrphans(process.pid, { isPidAlive: () => false });
    expect(r.failed).toEqual([rec.taskId]);
    const after = readTask(rec.taskId)!;
    expect(after.progress.state).toBe("failed");
    expect(after.diagnosis).toBe(ENGINE_DIED_DIAGNOSIS);
    expect(after.ownerPid).toBe(999999);
  });

  it("enginePid null（spawn 窗口内 owner 死）→ failed", async () => {
    const rec = makeRec({ ownerPid: 999999, enginePid: null, progress: { ...makeRec().progress, state: "starting" } });
    await createTask(rec);
    const r = await reconcileOrphans(process.pid, { isPidAlive: () => true });
    expect(r.failed).toEqual([rec.taskId]);
    expect(readTask(rec.taskId)!.progress.state).toBe("failed");
  });

  it("pid 活但归属不成立（pid 复用）→ failed + 复用注记", async () => {
    const rec = makeRec({ ownerPid: 999999 });
    await createTask(rec);
    const r = await reconcileOrphans(process.pid, {
      isPidAlive: () => true,
      psCommand: () => ["some", "unrelated", "process"],
      log: () => {},
    });
    expect(r.failed).toEqual([rec.taskId]);
    expect(readTask(rec.taskId)!.diagnosis).toBe(
      `${ENGINE_DIED_DIAGNOSIS} (pid reused by unrelated process)`,
    );
  });

  it("classifyOrphan 三值直测（adopt / fail:dead / fail:reused）", () => {
    const rec = makeRec();
    expect(
      classifyOrphan(rec, {
        isPidAlive: () => true,
        psCommand: () => ["aria2c", ...rec.engineCmdline.slice(1)],
      }),
    ).toBe("adopt");
    expect(classifyOrphan(rec, { isPidAlive: () => false })).toBe("fail:dead");
    expect(
      classifyOrphan(rec, { isPidAlive: () => true, psCommand: () => ["other"] }),
    ).toBe("fail:reused");
    expect(classifyOrphan(makeRec({ enginePid: null }))).toBe("fail:dead");
  });

  it("非候选零触碰：终态 / 本会话自有任务不进收养面", async () => {
    const done = makeRec({ ownerPid: 999999, progress: { ...makeRec().progress, state: "completed" } });
    const mine = makeRec({ ownerPid: process.pid });
    await createTask(done);
    await createTask(mine);
    const r = await reconcileOrphans(process.pid, { isPidAlive: () => false });
    expect(r).toEqual({ adopted: [], failed: [], untouched: 2 });
    expect(readTask(done.taskId)!.progress.state).toBe("completed"); // 终态不被翻
  });
});

describe("reconcileOrphans —— 真子进程收养", () => {
  it(
    "ownerPid=999999 + 活引擎（marker argv）→ 收养：ownerPid/state 落盘；二次扫描幂等",
    { timeout: 15_000 },
    async () => {
      const taskId = randomUUID();
      const { child } = await spawnEngineFixture(IDLE_SCRIPT, taskId);
      const rec = makeRec({
        taskId,
        ownerPid: 999999, // macOS pid 上限 99998——999999 必不存在的死 owner
        enginePid: child.pid!,
        engineCmdline: [path.join(tmpDir, `engine-${taskId}.cjs`), LASSO_DOWNLOAD_ARGV_MARKER, taskId],
      });
      await createTask(rec);

      const r1 = await reconcileOrphans(process.pid);
      expect(r1.adopted).toEqual([taskId]);
      const after = readTask(taskId)!;
      expect(after.ownerPid).toBe(process.pid); // 换防
      expect(after.progress.state).toBe("downloading"); // 保持/升级 downloading

      // 幂等：owner 已是自己 → 零动作
      const r2 = await reconcileOrphans(process.pid);
      expect(r2).toEqual({ adopted: [], failed: [], untouched: 1 });

      // 收尾：真杀（收养的引擎由测试负责关）
      expect(killEngineTree(after, "test-cleanup")).toMatchObject({ killed: true });
      expect(await waitUntil(() => !isEnginePidAlive(child.pid!))).toBe(true);
    },
  );
});
