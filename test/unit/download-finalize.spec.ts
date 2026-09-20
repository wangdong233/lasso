/**
 * download-finalize.spec.ts（审查修复批——终态检测层 unit 面）
 *
 * 覆盖修复批两个新行为面的 mutation-killer：
 *  1. enforceMaxBytes：totalBytes/downloadedBytes 超帽 → 杀树+oversize 态
 *     （删掉实现任一分支测试必红——P0-2 aria2 主路径守门的确定性钉）
 *  2. enforceIdleHardCap：updatedAt 超硬顶 → 杀树+failed+diagnosis（P1-6）
 *  3. kill 谓词含空格 filename：join 子串匹配路径（P1-4——原逐元素相等
 *     使该类合法任务恒拒杀的回归钉）
 *  4. finalizeTaskOnExit 幂等守卫：state=cancelled 不被引擎终态覆盖（P1-3
 *     的纯函数面——真链竞态在 fullchain spec 已有端到端钉）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import {
  enforceMaxBytes,
  enforceIdleHardCap,
  finalizeTaskOnExit,
  IDLE_HARD_CAP_ENV,
} from "../../src/download/finalize.js";
import { createTaskSync, readTask } from "../../src/download/store.js";
import { DOWNLOADS_DIR_ENV } from "../../src/download/types.js";
import { shouldKillEngine } from "../../src/download/kill.js";
import { stagingDirForTask } from "../../src/download/engines/staging.js";
import type { DownloadTaskRecord } from "../../src/download/types.js";

let root = "";
const liveFixtures: ChildProcess[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lasso-dl-fin-"));
  process.env[DOWNLOADS_DIR_ENV] = path.join(root, "tasks");
});

// 🔴 跨文件 env 竞争防御（2026-09-20 定罪）：threads 池同 worker 并发跑多个
// 测试文件时 process.env 共享——download-store.spec/kill-reconcile.spec 的
// afterAll `delete process.env[DOWNLOADS_DIR_ENV]` 会把本文件 beforeAll 设置
// 的隔离根打穿（实测 finalize 定谳落到 ~/.cache 缺省）。beforeEach 重设收口。
import { beforeEach } from "vitest";
beforeEach(() => {
  if (root !== "") process.env[DOWNLOADS_DIR_ENV] = path.join(root, "tasks");
});

afterAll(() => {
  for (const c of liveFixtures) {
    try {
      process.kill(c.pid!, "SIGKILL");
    } catch {
      /* 已死 */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function makeRecord(over: Partial<DownloadTaskRecord> = {}): DownloadTaskRecord {
  // env 内联重设（it 必经之路）：beforeEach 曾出现时序性不生效（实测 env UNSET
  // 而 root 有值）——不究 hook 怪癖，直接在数据构造点钉死隔离根
  if (root !== "") process.env[DOWNLOADS_DIR_ENV] = path.join(root, "tasks");
  const taskId = over.taskId ?? randomUUID();
  return {
    taskId,
    kind: "http",
    source: "https://example.com/file.bin",
    outDir: path.join(root, "out"),
    filename: "file.bin",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerPid: process.pid,
    engine: "aria2c",
    enginePid: 424242,
    engineCmdline: ["aria2c", "--dir", path.join(root, "staging", taskId), "-x", "8", "https://example.com/file.bin"],
    stdioFile: null,
    progress: {
      state: "downloading",
      progress: 0.5,
      speedBps: 1024,
      etaSec: 10,
      downloadedBytes: 1048576,
      totalBytes: 2097152,
    },
    files: [],
    diagnosis: null,
    proxyUsed: null,
    maxBytes: 5 * 1024 * 1024 * 1024,
    subsFile: null,
    ...over,
  };
}

/** 活引擎 fixture（cmdline 带 staging 锚——enforce* 的杀树目标）。 */
async function liveEngine(taskId: string): Promise<number> {
  const script = path.join(root, `engine-${taskId}.cjs`);
  fs.writeFileSync(script, "setInterval(() => {}, 1000);", "utf8");
  const child = spawn(
    process.execPath,
    [script, "--dir", path.join(root, "staging", taskId)],
    { stdio: "ignore" },
  );
  liveFixtures.push(child);
  await new Promise((r) => setTimeout(r, 150));
  return child.pid!;
}

describe("enforceMaxBytes —— P0-2 守门（mutation-killer）", () => {
  it("totalBytes 超帽 → 杀活引擎 + state=oversize + diagnosis", async () => {
    const script0 = path.join(root, `engine-${"m-" + "x"}.cjs`); // 占位——下方真值
    void script0;
    const rec0 = makeRecord({ maxBytes: 1024 * 1024 }); // cap 1MiB vs total 2MiB
    createTaskSync(rec0);
    const pid = await liveEngine(rec0.taskId);
    // 杀树谓词④=engineCmdline 集合包含：须与 fixture 真实 argv 一致（node 脚本形态）
    const withPid = makeRecord({
      ...rec0,
      enginePid: pid,
      engineCmdline: [path.join(root, `engine-${rec0.taskId}.cjs`), "--dir", path.join(root, "staging", rec0.taskId)],
    });
    createTaskSync(withPid);

    const acted = enforceMaxBytes(withPid);
    expect(acted).toBe(true);
    const after = readTask(rec0.taskId);
    expect(after?.progress.state).toBe("oversize");
    expect(after?.diagnosis).toContain("oversize");
    // 引擎被杀
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it("downloadedBytes 超帽（chunked 未知总长形态）→ oversize", () => {
    const rec = makeRecord({
      maxBytes: 512 * 1024, // cap 512KiB vs downloaded 1MiB
      progress: {
        state: "downloading",
        progress: null,
        speedBps: 1024,
        etaSec: null,
        downloadedBytes: 1048576,
        totalBytes: null, // chunked：无 total
      },
      enginePid: null, // 已死引擎（守门仍应标 oversize——杀树谓词自然跳过）
    });
    createTaskSync(rec);
    expect(enforceMaxBytes(rec)).toBe(true);
    expect(readTask(rec.taskId)?.progress.state).toBe("oversize");
  });

  it("帽内 → 零动作（state 不变）", () => {
    const rec = makeRecord({ maxBytes: 10 * 1024 * 1024 }); // 10MiB cap > 2MiB total
    createTaskSync(rec);
    expect(enforceMaxBytes(rec)).toBe(false);
    expect(readTask(rec.taskId)?.progress.state).toBe("downloading");
  });

  it("终态任务 → 零动作（幂等）", () => {
    const rec = makeRecord({
      maxBytes: 1024,
      progress: { state: "completed", progress: 1, speedBps: null, etaSec: null, downloadedBytes: 2097152, totalBytes: 2097152 },
    });
    createTaskSync(rec);
    expect(enforceMaxBytes(rec)).toBe(false);
  });
});

describe("enforceIdleHardCap —— P1-6 硬顶（mutation-killer）", () => {
  it("updatedAt 超硬顶 → 杀树 + failed + diagnosis 含 hard cap", async () => {
    process.env[IDLE_HARD_CAP_ENV] = "60000"; // 1min 硬顶（测试压缩）
    const rec0 = makeRecord({
      updatedAt: new Date(Date.now() - 120_000).toISOString(), // 2min 前
    });
    createTaskSync(rec0);
    const pid = await liveEngine(rec0.taskId);
    const withPid = makeRecord({
      ...rec0,
      enginePid: pid,
      engineCmdline: [path.join(root, `engine-${rec0.taskId}.cjs`), "--dir", path.join(root, "staging", rec0.taskId)],
    });
    createTaskSync(withPid);

    expect(enforceIdleHardCap(withPid)).toBe(true);
    const after = readTask(rec0.taskId);
    expect(after?.progress.state).toBe("failed");
    expect(after?.diagnosis).toContain("idle hard cap");
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
    delete process.env[IDLE_HARD_CAP_ENV];
  }, 10_000);

  it("窗内 → 零动作", () => {
    const rec = makeRecord(); // updatedAt=now
    createTaskSync(rec);
    expect(enforceIdleHardCap(rec)).toBe(false);
  });
});

describe("kill 谓词含空格 filename —— P1-4 回归钉", () => {
  it("engineCmdline 含空格元素 → join 子串匹配仍可杀", () => {
    const taskId = randomUUID();
    const rec = makeRecord({
      taskId,
      engine: "aria2c",
      engineCmdline: [
        "aria2c",
        "--dir",
        path.join(root, "staging", taskId),
        "--out",
        "my file.iso", // 含空格 filename（原实现恒拒杀）
        "https://example.com/t",
      ],
    });
    // ps 空白切分形态：my file.iso 被切成 my / file.iso 两个 token
    const cmdlineNow = ["aria2c", "--dir", path.join(root, "staging", taskId), "--out", "my", "file.iso", "https://example.com/t"];
    expect(shouldKillEngine({ record: rec, enginePid: rec.enginePid!, cmdlineNow })).toBe(true);
  });

  it("无空格路径仍精确匹配（回归面不回退）", () => {
    const rec = makeRecord();
    expect(
      shouldKillEngine({ record: rec, enginePid: rec.enginePid!, cmdlineNow: [...rec.engineCmdline] }),
    ).toBe(true);
    expect(
      shouldKillEngine({ record: rec, enginePid: rec.enginePid!, cmdlineNow: ["aria2c", "--dir", "/elsewhere"] }),
    ).toBe(false);
  });
});

describe("finalizeTaskOnExit 幂等守卫 —— P1-3 纯函数面", () => {
  it("state=cancelled → 引擎退出不覆盖（终态保持）", () => {
    const rec = makeRecord({
      progress: { state: "cancelled", progress: null, speedBps: null, etaSec: null, downloadedBytes: null, totalBytes: null },
    });
    createTaskSync(rec);
    finalizeTaskOnExit(rec, 0); // 引擎 exit 0（completed 语义）
    expect(readTask(rec.taskId)?.progress.state).toBe("cancelled"); // 不被覆盖
  });

  it("downloading + exit 0 → completed（正常定谳路径）", () => {
    const rec = makeRecord({ outDir: path.join(root, "out2") });
    fs.mkdirSync(path.join(root, "out2"), { recursive: true });
    // staging 放一个假产物（releaseStaging 搬运源）
    const stagingDir = path.join(root, "staging", rec.taskId);
    // env 根一致性自检（显式传 env：vitest 模块实例双份 process 下默认参数
    // === 比较为假会落独立分支——显式传测试进程 env 走同一条解析）
    expect(stagingDir).toBe(stagingDirForTask(rec.taskId, process.env));
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "file.bin"), "x".repeat(16), "utf8");
    createTaskSync(rec);
    finalizeTaskOnExit(rec, 0);
    const after = readTask(rec.taskId);
    expect(after?.progress.state).toBe("completed");
    expect(after?.files.length).toBe(1);
    expect(after?.files[0]).toContain("file.bin");
    expect(fs.existsSync(path.join(path.join(root, "out2"), "file.bin"))).toBe(true);
  });
});
