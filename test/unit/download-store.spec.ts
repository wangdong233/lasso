/**
 * download-store.spec.ts（doc/bugs/12 D6/H6——WT-core 任务表单测）
 *
 * 守护面（mutation-killer 纪律：每个行为面至少一条「删实现必红」）：
 *  - env 覆盖路径隔离（LASSO_DOWNLOADS_PATH → mkdtemp 根）
 *  - 原子写：写后零 .tmp 残骸 + 内容完整（rename 后可读）
 *  - 损坏 JSON 跳过单文件（listTasks 不整目录失效）+ 形状不对跳过
 *  - taskId UUID 校验拒穿越（../../evil / .. / 非法形状）
 *  - updateTask RMW：合并 / updatedAt 戳新 / 主键不可篡改 / 缺失返 null
 *  - 并发同任务更新全部落地（per-task 串行队列）
 *  - 写失败 best-effort 不抛（路径被文件占位逼失败）
 *  - 枚举守卫往返（kind/engine/state 白名单漏改即红）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  createTask,
  readTask,
  listTasks,
  updateTask,
  deleteTask,
  downloadTasksRoot,
  isValidTaskId,
  InvalidTaskIdError,
  type DownloadTaskRecord,
} from "../../src/download/store.js";
import { DOWNLOADS_DIR_ENV } from "../../src/download/types.js";

let tmpDir: string;
let root: string;

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
    engineCmdline: ["aria2c", "--lasso-download-task", taskId],
    stdioFile: null,
    progress: {
      state: "downloading",
      progress: 0.5,
      speedBps: 1024,
      etaSec: 10,
      downloadedBytes: 512,
      totalBytes: 1024,
    },
    files: [],
    diagnosis: null,
    proxyUsed: null,
    maxBytes: 5 * 1024 * 1024 * 1024,
    subsFile: null,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-download-store-"));
  root = path.join(tmpDir, "tasks");
  process.env[DOWNLOADS_DIR_ENV] = root;
});

afterEach(async () => {
  delete process.env[DOWNLOADS_DIR_ENV];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("download-store —— 路径与校验", () => {
  it("downloadTasksRoot 受 LASSO_DOWNLOADS_PATH 覆盖（测试隔离钩子）", () => {
    expect(downloadTasksRoot()).toBe(root);
  });

  it("isValidTaskId：randomUUID 形状过；穿越/大写/短形拒", () => {
    expect(isValidTaskId(randomUUID())).toBe(true);
    expect(isValidTaskId("../../evil")).toBe(false);
    expect(isValidTaskId("..")).toBe(false);
    expect(isValidTaskId("abc")).toBe(false);
    expect(isValidTaskId(randomUUID().toUpperCase())).toBe(false);
    expect(isValidTaskId("-".repeat(36))).toBe(false); // 宽松式漏网形态，收紧式拒
  });

  it("createTask 非法 taskId 显式抛 invalid_task_id（防穿越）——../../evil 不落盘", async () => {
    for (const evil of ["../../evil", "..", "abc"]) {
      await expect(createTask(makeRec({ taskId: evil as string }))).rejects.toThrow(
        InvalidTaskIdError,
      );
    }
    // 无文件写出（穿越目标也不存在同目录副作用）
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it("readTask / deleteTask 非法 taskId：读侧 null（零磁盘访问）/ 写侧显式抛", async () => {
    expect(readTask("../../evil")).toBeNull();
    expect(readTask("..")).toBeNull();
    await expect(deleteTask("../../evil")).rejects.toThrow(InvalidTaskIdError);
    const err = new InvalidTaskIdError("../x");
    expect(err.code).toBe("invalid_task_id"); // 显式错误码纪律
  });
});

describe("download-store —— CRUD 往返", () => {
  it("createTask + readTask 往返（内容完整）+ 文件名 = <taskId>.json", async () => {
    const rec = makeRec();
    expect(await createTask(rec)).toBe(true);
    expect(readTask(rec.taskId)).toEqual(rec);
    const onDisk = readdirSync(root);
    expect(onDisk).toEqual([`${rec.taskId}.json`]);
  });

  it("原子写纪律：写后零 .tmp 残骸（create + update 后扫全目录）", async () => {
    const rec = makeRec();
    await createTask(rec);
    await updateTask(rec.taskId, { proxyUsed: "http://127.0.0.1:7890" });
    await createTask(makeRec());
    const tmpResidue = readdirSync(root).filter((f) => f.includes(".tmp"));
    expect(tmpResidue).toEqual([]);
    // rename 后内容完整可解析（无半截 JSON）
    const body = readFileSync(path.join(root, `${rec.taskId}.json`), "utf8");
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it("updateTask：浅合并 + updatedAt 自动戳新 + 返回落盘记录", async () => {
    const rec = makeRec();
    await createTask(rec);
    const before = readTask(rec.taskId)!.updatedAt;
    await new Promise((r) => setTimeout(r, 5)); // 确保 ts 可前进
    const merged = await updateTask(rec.taskId, { proxyUsed: "off" });
    expect(merged?.proxyUsed).toBe("off");
    expect(merged?.updatedAt).not.toBe(before);
    const reread = readTask(rec.taskId)!;
    expect(reread.proxyUsed).toBe("off");
    expect(reread.kind).toBe("http"); // 未 patch 字段保留
    expect(reread.updatedAt).not.toBe(before);
  });

  it("updateTask 主键不可篡改：patch.taskId 不改写目标文件", async () => {
    const rec = makeRec();
    const other = randomUUID();
    await createTask(rec);
    const merged = await updateTask(rec.taskId, { taskId: other } as Partial<DownloadTaskRecord>);
    expect(merged?.taskId).toBe(rec.taskId);
    expect(readTask(other)).toBeNull(); // 没有写到别的文件
  });

  it("updateTask 文件不存在 → null（不隐式创建）", async () => {
    expect(await updateTask(randomUUID(), { proxyUsed: "off" })).toBeNull();
    expect(listTasks()).toEqual([]); // 连 tasks 目录都未创建（零磁盘副作用）
  });

  it("deleteTask：true → 幂等 false", async () => {
    const rec = makeRec();
    await createTask(rec);
    expect(await deleteTask(rec.taskId)).toBe(true);
    expect(readTask(rec.taskId)).toBeNull();
    expect(await deleteTask(rec.taskId)).toBe(false);
  });
});

describe("download-store —— 容错（损坏跳过，绝不整目录失效）", () => {
  it("损坏 JSON：readTask null + listTasks 跳过该文件、其余照列", async () => {
    const good = makeRec();
    const bad = makeRec();
    await createTask(good);
    await createTask(bad);
    await fs.writeFile(path.join(root, `${bad.taskId}.json`), "{half-broken", "utf8");
    expect(readTask(bad.taskId)).toBeNull();
    const listed = listTasks();
    expect(listed.map((r) => r.taskId)).toEqual([good.taskId]);
  });

  it("形状不对（state 非法值）→ 跳过", async () => {
    const rec = makeRec();
    await createTask(rec);
    const raw = JSON.parse(readFileSync(path.join(root, `${rec.taskId}.json`), "utf8"));
    raw.progress.state = "weird-state";
    writeFileSync(path.join(root, `${rec.taskId}.json`), JSON.stringify(raw), "utf8");
    expect(readTask(rec.taskId)).toBeNull();
    expect(listTasks()).toEqual([]);
  });

  it("目录不存在 → listTasks []；非 UUID 文件名零读取", async () => {
    expect(listTasks()).toEqual([]); // root 尚不存在
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "evil.json"), "{}", "utf8"); // 非 UUID 名
    await fs.writeFile(path.join(root, "notes.txt"), "x", "utf8");
    expect(listTasks()).toEqual([]);
    // evil.json 从未被当任务解析（写了空对象也无害）
  });

  it("listTasks 按 createdAt 升序（跨会话寻址面可预测）", async () => {
    const mid = makeRec({ createdAt: "2026-09-20T02:00:00.000Z" });
    const early = makeRec({ createdAt: "2026-09-20T01:00:00.000Z" });
    const late = makeRec({ createdAt: "2026-09-20T03:00:00.000Z" });
    await createTask(mid);
    await createTask(early);
    await createTask(late);
    expect(listTasks().map((r) => r.taskId)).toEqual([early.taskId, mid.taskId, late.taskId]);
  });

  it("写失败 best-effort 不抛：根路径被文件占位 → createTask false / listTasks []", async () => {
    const blocker = path.join(tmpDir, "blocker");
    await fs.writeFile(blocker, "x", "utf8");
    process.env[DOWNLOADS_DIR_ENV] = path.join(blocker, "tasks"); // mkdir 必失败
    const rec = makeRec();
    await expect(createTask(rec)).resolves.toBe(false); // 不抛，可观测
    expect(listTasks()).toEqual([]);
    expect(await updateTask(rec.taskId, { proxyUsed: "off" })).toBeNull();
  });
});

describe("download-store —— 并发（红队 H6）", () => {
  it("同任务并发 updateTask 全部落地（per-task 串行队列）+ 记录不损", async () => {
    const rec = makeRec();
    await createTask(rec);
    await Promise.all([
      updateTask(rec.taskId, { proxyUsed: "http://127.0.0.1:7890" }),
      updateTask(rec.taskId, { subsFile: "/tmp/a.srt" }),
      updateTask(rec.taskId, { diagnosis: "bt-dpi-suspect" }),
      updateTask(rec.taskId, { enginePid: 555 }),
    ]);
    const final = readTask(rec.taskId)!;
    expect(final.proxyUsed).toBe("http://127.0.0.1:7890");
    expect(final.subsFile).toBe("/tmp/a.srt");
    expect(final.diagnosis).toBe("bt-dpi-suspect");
    expect(final.enginePid).toBe(555);
  });

  it("跨任务并发互不阻塞（每任务一文件零共享写面）", async () => {
    const recs = [makeRec(), makeRec(), makeRec(), makeRec()];
    await Promise.all(recs.map((r) => createTask(r)));
    await Promise.all(recs.map((r) => updateTask(r.taskId, { proxyUsed: "off" })));
    for (const r of recs) {
      expect(readTask(r.taskId)?.proxyUsed).toBe("off");
    }
  });
});

describe("download-store —— 枚举守卫往返（parseEnum 白名单漂移即红）", () => {
  it("kind=torrent / engine=undici / state=oversize（含 null 字段）全形状往返", async () => {
    const rec = makeRec({
      kind: "torrent",
      engine: "undici",
      enginePid: null,
      filename: null,
      progress: {
        state: "oversize",
        progress: null,
        speedBps: null,
        etaSec: null,
        downloadedBytes: 6 * 1024 ** 3,
        totalBytes: null,
      },
      stdioFile: null,
      diagnosis: null,
    });
    await createTask(rec);
    expect(readTask(rec.taskId)).toEqual(rec);
  });
});
