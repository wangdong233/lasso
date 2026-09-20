/**
 * download-tool.spec.ts（v1.30，doc/bugs/12 决议 §四工具面契约 + §八 WT-tools 面）
 *
 * 测试策略：handler 纯逻辑面用 fake deps 表驱动（DownloadDeps 接口注入的
 * 天然收益——WT-core/WT-engines 实装并行开发，本面只测工具层契约）：
 *  - start 全链：resolveFilename 拒 ../→显式错 / out_dir 白名单拒→显式错 /
 *    非法组合 start+task_id→invalid_params+ignored_options / ssrfGuard 仅 http kind
 *    （IP 字面量 URL 离线可测：203.0.113.0/24 = TEST-NET-3 公网文档段；
 *    127.0.0.1 = 私网拒——不触 DNS）
 *  - status："all" 先 reconcileOrphans 再 listTasks（D13 顺序契约）
 *  - wait：超时→outcome unknown+hint（D8）；终态→worked
 *  - cancel：幂等（引擎已死仍 true）
 *  - BT 双因诊断（D16）：torrent 零 peer 超 60s→diagnosis 双因文案
 *  - 未接线降级：deps=null→didnt "download engine layer not wired (merge pending)"
 */
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";
import {
  doDownload,
  expandHome,
  isValidProxy,
  maybeBtZeroPeerDiagnosis,
  BT_ZERO_PEER_DIAGNOSIS,
  WAIT_TIMEOUT_HINT,
  type DownloadArgs,
  type DownloadDeps,
  type DownloadTaskRecord,
  type StartTaskInput,
  type EngineSnapshotWithPeers,
} from "../../src/tools/download.js";
import type { DownloadKind, DownloadKindInput, RoutedDownload } from "../../src/download/types.js";

// ============================================================
// fake deps（表驱动状态机）
// ============================================================
/** 白名单根随真实 homedir（缺省 ~/Downloads 展开后必须落在白名单内）。 */
const ALLOWED_ROOT = path.join(os.homedir(), "Downloads");

interface FakeOpts {
  /** readEngineSnapshot 返回的 peers 数（BT 诊断输入）。 */
  peers?: number | null;
  /** readTask 第 N 次调用后把状态翻成该值（wait 终态测试用）。 */
  flipStateAfterReads?: { reads: number; state: DownloadTaskRecord["progress"]["state"] };
}

function makeFakeDeps(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const tasks = new Map<string, DownloadTaskRecord>();
  let seq = 0;
  let reads = 0;

  const routeKind = (
    source: string,
    explicit: DownloadKindInput,
  ): RoutedDownload => {
    calls.push("routeKind");
    if (explicit !== "auto") {
      return {
        kind: explicit,
        engine: explicit === "stream" ? "yt-dlp" : "aria2c",
      };
    }
    if (source.startsWith("magnet:") || source.endsWith(".torrent")) {
      return { kind: "torrent", engine: "aria2c" };
    }
    if (/youtube\.com|youtu\.be/.test(source)) {
      return { kind: "stream", engine: "yt-dlp" };
    }
    return { kind: "http", engine: "aria2c" };
  };

  const deps: DownloadDeps = {
    routeKind,
    resolveFilename(filename) {
      calls.push("resolveFilename");
      if (filename === null || filename === undefined) return null;
      if (filename.includes("/") || filename.includes("..")) {
        throw new Error(
          `filename_must_be_basename: got ${JSON.stringify(filename)}`,
        );
      }
      return filename;
    },
    assertOutDirAllowed(outDir) {
      calls.push("assertOutDirAllowed");
      if (!outDir.startsWith(ALLOWED_ROOT)) {
        throw new Error(
          `out_dir_not_allowed: ${outDir} is outside the allowlist`,
        );
      }
      return outDir;
    },
    createTask(input: StartTaskInput) {
      calls.push("createTask");
      const taskId = `t-${++seq}`;
      const now = new Date().toISOString();
      const record: DownloadTaskRecord = {
        taskId,
        kind: input.kind,
        source: input.source,
        outDir: input.outDir,
        filename: input.filename,
        createdAt: now,
        updatedAt: now,
        ownerPid: process.pid,
        engine: input.engine,
        enginePid: null,
        engineCmdline: ["aria2c", "--lasso-download-task", taskId],
        stdioFile: `/tmp/lasso/downloads/${taskId}.log`,
        progress: {
          state: "starting",
          progress: null,
          speedBps: null,
          etaSec: null,
          downloadedBytes: null,
          totalBytes: null,
        },
        files: [],
        diagnosis: null,
        proxyUsed: null,
        maxBytes: input.maxBytes,
        subsFile: null,
      };
      tasks.set(taskId, record);
      return record;
    },
    spawnEngine(record, spawnOpts) {
      calls.push("spawnEngine");
      const r = tasks.get(record.taskId)!;
      r.enginePid = 4242;
      r.progress = { ...r.progress, state: "downloading" };
      r.proxyUsed = spawnOpts.proxy;
    },
    readTask(taskId) {
      reads++;
      const flip = opts.flipStateAfterReads;
      const rec = tasks.get(taskId);
      if (rec && flip && reads > flip.reads) {
        rec.progress = { ...rec.progress, state: flip.state };
      }
      return rec ? { ...rec, progress: { ...rec.progress } } : null;
    },
    listTasks() {
      calls.push("listTasks");
      return [...tasks.values()].map((r) => ({
        ...r,
        progress: { ...r.progress },
      }));
    },
    updateTask(taskId, patch) {
      calls.push(`updateTask:${taskId}`);
      const rec = tasks.get(taskId);
      if (!rec) return null;
      Object.assign(rec, patch);
      rec.updatedAt = new Date().toISOString();
      return { ...rec, progress: { ...rec.progress } };
    },
    killEngineTree(record) {
      calls.push("killEngineTree");
      const rec = tasks.get(record.taskId);
      if (!rec) return false;
      const wasAlive = rec.enginePid !== null;
      rec.enginePid = null;
      return wasAlive;
    },
    reconcileOrphans() {
      calls.push("reconcileOrphans");
      return 0;
    },
    readEngineSnapshot(record): EngineSnapshotWithPeers {
      calls.push("readEngineSnapshot");
      return {
        progress: 0.42,
        speedBps: 1024 * 1024,
        etaSec: 30,
        downloadedBytes: 440_000_000,
        totalBytes: 1_000_000_000,
        exitCode: null,
        peers: opts.peers ?? 0,
      };
    },
  };

  return { deps, calls, tasks };
}

/** 离线 SSRF 配置（空 env：默认 allow/deny；IP 字面量不走 DNS）。 */
const ssrfConfig: SsrfConfig = { allowRanges: [], denyRanges: [] };

const startArgs = (over: Partial<DownloadArgs> = {}): DownloadArgs => ({
  action: "start",
  url: "http://203.0.113.10/big.iso", // TEST-NET-3 公网文档段：ssrf 放行且零 DNS
  ...over,
});

// ============================================================
// 纯 helper
// ============================================================
describe("expandHome / isValidProxy（纯函数面）", () => {
  it("expandHome：~ 与 ~/ 前缀展开，其余透传", () => {
    expect(expandHome("~/Downloads").endsWith("Downloads")).toBe(true);
    expect(expandHome("~/Downloads").startsWith("/")).toBe(true);
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });

  it("isValidProxy：auto/off/host:port 三值合法，其余拒", () => {
    expect(isValidProxy("auto")).toBe(true);
    expect(isValidProxy("off")).toBe(true);
    expect(isValidProxy("127.0.0.1:7890")).toBe(true);
    expect(isValidProxy("[::1]:7890")).toBe(true);
    expect(isValidProxy("socks5://x")).toBe(false);
    expect(isValidProxy("")).toBe(false);
  });
});

// ============================================================
// 未接线降级（WT-tools 分支的诚实防线）
// ============================================================
describe("download · 未接线降级", () => {
  it("deps=null → 所有 action 返 didnt 'download engine layer not wired (merge pending)'（宁可 didnt 不可悬空）", async () => {
    for (const action of ["start", "status", "wait", "cancel"] as const) {
      const r = await doDownload({ action } as DownloadArgs, null, ssrfConfig);
      expect(r.outcome).toBe("didnt");
      expect(r.error).toBe(
        "download engine layer not wired (merge pending)",
      );
      expect(r.retrieval_method).toBe("download_engine_layer_not_wired");
    }
  });
});

// ============================================================
// start 全链
// ============================================================
describe("download · start", () => {
  it("http 直链全链：routeKind→ssrf 放行→createTask→spawnEngine→{task_id, kind, engine, out_dir, state:'starting'}", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(startArgs(), f.deps, ssrfConfig);
    expect(r.outcome).toBe("worked");
    expect(r.data).toMatchObject({
      kind: "http",
      engine: "aria2c",
      state: "starting",
    });
    expect((r.data as { task_id: string }).task_id).toMatch(/^t-\d+$/);
    expect((r.data as { out_dir: string }).out_dir.startsWith("/")).toBe(true);
    // 任务序（决议指定链序）
    expect(f.calls.indexOf("resolveFilename")).toBeLessThan(
      f.calls.indexOf("assertOutDirAllowed"),
    );
    expect(f.calls.indexOf("assertOutDirAllowed")).toBeLessThan(
      f.calls.indexOf("routeKind"),
    );
    expect(f.calls.indexOf("createTask")).toBeLessThan(
      f.calls.indexOf("spawnEngine"),
    );
  });

  it("filename 含 ../ → 显式错 filename_must_be_basename，且不建任务", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(startArgs({ filename: "../evil.iso" }), f.deps, ssrfConfig);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("filename_must_be_basename");
    expect(f.calls).not.toContain("createTask");
  });

  it("filename 含 / → 同拒（basename 强制）", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(startArgs({ filename: "a/b.iso" }), f.deps, ssrfConfig);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("filename_must_be_basename");
  });

  it("out_dir 越白名单 → 显式错 out_dir_not_allowed", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(startArgs({ out_dir: "/etc" }), f.deps, ssrfConfig);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("out_dir_not_allowed");
    expect(f.calls).not.toContain("createTask");
  });

  it("非法组合 start+task_id → invalid_params + ignored_options 回显（家法先例）", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      startArgs({ task_id: "t-999" }),
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("invalid_params_combination");
    expect(r.error).toContain("task_id");
    expect((r.data as { ignored_options: string[] }).ignored_options).toContain(
      "task_id",
    );
    expect(f.calls).not.toContain("createTask");
  });

  it("start 缺 url → url_required_for_start", async () => {
    const f = makeFakeDeps();
    const r = await doDownload({ action: "start" }, f.deps, ssrfConfig);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("url_required_for_start");
  });

  it("proxy 非三值 → invalid_params_proxy", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      startArgs({ proxy: "socks5://x" }),
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("invalid_params_proxy");
  });

  it("magnet: → torrent kind 引擎路由，不经 ssrfGuard 冒充（D12）", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      startArgs({ url: "magnet:?xt=urn:btih:0123456789abcdef" }),
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data).toMatchObject({ kind: "torrent", engine: "aria2c" });
  });

  it("kind=http 但 url=magnet: → url_scheme_mismatch 显式错", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      startArgs({ url: "magnet:?xt=urn:btih:x", kind: "http" }),
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("url_scheme_mismatch");
  });

  it("kind=torrent 但 url 是 http → url_scheme_mismatch（torrent 只收 magnet:/.torrent 绝对路径）", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      startArgs({ url: "http://203.0.113.10/x.torrent", kind: "torrent" }),
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("url_scheme_mismatch");
  });

  it("http kind 私网 IP → ssrf_blocked（与 fetch_url 同函数同 config，D12；127.0.0.1 在 DEFAULT_ALLOW_RANGES 是 browse_logged_in 的 load-bearing 放行，故用 192.168.1.1 验拒）", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      startArgs({ url: "http://192.168.1.1/x" }),
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("ssrf_blocked:private_ip");
    expect(f.calls).not.toContain("createTask");
  });

  it("stream kind 不走 ssrfGuard（网络面由 yt-dlp 决定——诚实边界）", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      startArgs({
        url: "https://youtube.com/watch?v=X",
        kind: "stream",
        audio_only: true,
        subs: true,
      }),
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data).toMatchObject({ kind: "stream", engine: "yt-dlp" });
  });
});

// ============================================================
// status
// ============================================================
describe("download · status", () => {
  it('task_id="all" → 先 reconcileOrphans 再 listTasks（D13 顺序契约）+ 产物清单', async () => {
    const f = makeFakeDeps();
    await doDownload(startArgs(), f.deps, ssrfConfig); // 建一个任务
    f.calls.length = 0;
    const r = await doDownload(
      { action: "status", task_id: "all" },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("worked");
    expect(f.calls.indexOf("reconcileOrphans")).toBeLessThan(
      f.calls.indexOf("listTasks"),
    );
    const data = r.data as { reconciled: number; count: number; tasks: DownloadTaskRecord[] };
    expect(data.count).toBe(1);
    expect(Array.isArray(data.tasks[0].files)).toBe(true);
  });

  it("status 缺 task_id → didnt", async () => {
    const f = makeFakeDeps();
    const r = await doDownload({ action: "status" }, f.deps, ssrfConfig);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("task_id_required_for_status");
  });

  it("单 id：任务在案 → 合并快照进度视图", async () => {
    const f = makeFakeDeps();
    const started = await doDownload(startArgs(), f.deps, ssrfConfig);
    const taskId = (started.data as { task_id: string }).task_id;
    const r = await doDownload(
      { action: "status", task_id: taskId },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("worked");
    const task = (r.data as { task: DownloadTaskRecord }).task;
    expect(task.progress.progress).toBe(0.42);
    expect(task.progress.downloadedBytes).toBe(440_000_000);
  });

  it("单 id 不存在 → didnt download_task_not_found（hint 教 status all 寻址）", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      { action: "status", task_id: "t-nope" },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("download_task_not_found");
  });

  it("BT 双因诊断（D16）：torrent 零 peer 超 60s → diagnosis 双因文案并落盘", async () => {
    const f = makeFakeDeps({ peers: 0 });
    const started = await doDownload(
      startArgs({ url: "magnet:?xt=urn:btih:dead" }),
      f.deps,
      ssrfConfig,
    );
    const taskId = (started.data as { task_id: string }).task_id;
    // 拨回 createdAt 到 120s 前（诊断窗 >60s）
    const rec = f.tasks.get(taskId)!;
    rec.createdAt = new Date(Date.now() - 120_000).toISOString();
    const r = await doDownload(
      { action: "status", task_id: taskId },
      f.deps,
      ssrfConfig,
    );
    const task = (r.data as { task: DownloadTaskRecord }).task;
    expect(task.diagnosis).toBe(BT_ZERO_PEER_DIAGNOSIS);
    expect(task.diagnosis).toContain("dead torrent OR");
    expect(task.diagnosis).toContain("DPI blocking");
    // 落盘（updateTask 收到 diagnosis patch）
    expect(f.calls).toContain(`updateTask:${taskId}`);
  });

  it("BT 有 peer → 不诊断（单因禁断言的另一面：有 peer 不是死路）", async () => {
    const f = makeFakeDeps({ peers: 7 });
    const started = await doDownload(
      startArgs({ url: "magnet:?xt=urn:btih:alive" }),
      f.deps,
      ssrfConfig,
    );
    const taskId = (started.data as { task_id: string }).task_id;
    const rec = f.tasks.get(taskId)!;
    rec.createdAt = new Date(Date.now() - 120_000).toISOString();
    const r = await doDownload(
      { action: "status", task_id: taskId },
      f.deps,
      ssrfConfig,
    );
    const task = (r.data as { task: DownloadTaskRecord }).task;
    expect(task.diagnosis).toBeNull();
  });

  it("非 torrent 任务零 peer 不诊断（kind 门）", () => {
    const rec = {
      kind: "http" as DownloadKind,
      diagnosis: null,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    } as DownloadTaskRecord;
    expect(maybeBtZeroPeerDiagnosis(rec, 0, Date.now())).toBeNull();
  });
});

// ============================================================
// wait（D8：超时=partial+unknown+教轮询；不烧穿 MCP 超时）
// ============================================================
describe("download · wait", () => {
  it("超时 → outcome unknown + partial 快照 + hint 教轮询", async () => {
    const f = makeFakeDeps();
    const started = await doDownload(startArgs(), f.deps, ssrfConfig);
    const taskId = (started.data as { task_id: string }).task_id;
    const t0 = Date.now();
    const r = await doDownload(
      { action: "wait", task_id: taskId, timeout_s: 0.2 },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("unknown");
    expect(r.hint).toBe(WAIT_TIMEOUT_HINT);
    expect(r.hint).toContain('download({action:"wait"})');
    const data = r.data as { task: DownloadTaskRecord; waited_ms: number };
    expect(data.task.taskId).toBe(taskId);
    expect(data.task.progress.state).toBe("downloading"); // partial 快照非终态
    expect(Date.now() - t0).toBeLessThan(5_000); // 不烧穿（远小于 MCP 超时）
  });

  it("终态到达 → worked + 终态任务体", async () => {
    const f = makeFakeDeps({
      flipStateAfterReads: { reads: 1, state: "completed" },
    });
    const started = await doDownload(startArgs(), f.deps, ssrfConfig);
    const taskId = (started.data as { task_id: string }).task_id;
    const r = await doDownload(
      { action: "wait", task_id: taskId, timeout_s: 1 },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("worked");
    const data = r.data as { task: DownloadTaskRecord; waited_ms: number };
    expect(data.task.progress.state).toBe("completed");
  });

  it("wait 缺 task_id / 传 all → didnt", async () => {
    const f = makeFakeDeps();
    const r1 = await doDownload({ action: "wait" }, f.deps, ssrfConfig);
    expect(r1.error).toContain("task_id_required_for_wait");
    const r2 = await doDownload(
      { action: "wait", task_id: "all" },
      f.deps,
      ssrfConfig,
    );
    expect(r2.error).toContain("task_id_required_for_wait");
  });

  it("wait 不存在的任务 → didnt download_task_not_found", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      { action: "wait", task_id: "t-nope", timeout_s: 1 },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("download_task_not_found");
  });
});

// ============================================================
// cancel（幂等：引擎已死仍 true）
// ============================================================
describe("download · cancel", () => {
  it("downloading → killEngineTree + state=cancelled + cancelled:true", async () => {
    const f = makeFakeDeps();
    const started = await doDownload(startArgs(), f.deps, ssrfConfig);
    const taskId = (started.data as { task_id: string }).task_id;
    const r = await doDownload(
      { action: "cancel", task_id: taskId },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("worked");
    const data = r.data as { cancelled: boolean; engine_killed: boolean };
    expect(data.cancelled).toBe(true);
    expect(data.engine_killed).toBe(true);
    expect(f.calls).toContain("killEngineTree");
    expect(f.tasks.get(taskId)!.progress.state).toBe("cancelled");
  });

  it("引擎已死（enginePid=null）→ 仍 cancelled:true 幂等（diagnosis 注明 already）", async () => {
    const f = makeFakeDeps();
    const started = await doDownload(startArgs(), f.deps, ssrfConfig);
    const taskId = (started.data as { task_id: string }).task_id;
    f.tasks.get(taskId)!.enginePid = null; // 引擎先死了
    const r = await doDownload(
      { action: "cancel", task_id: taskId },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("worked");
    const data = r.data as { cancelled: boolean; engine_killed: boolean; already?: string };
    expect(data.cancelled).toBe(true);
    expect(data.engine_killed).toBe(false);
    expect(data.already).toBe("engine_already_dead");
  });

  it("重复 cancel → 幂等 true（already:cancelled）", async () => {
    const f = makeFakeDeps();
    const started = await doDownload(startArgs(), f.deps, ssrfConfig);
    const taskId = (started.data as { task_id: string }).task_id;
    await doDownload({ action: "cancel", task_id: taskId }, f.deps, ssrfConfig);
    const r = await doDownload(
      { action: "cancel", task_id: taskId },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("worked");
    expect((r.data as { cancelled: boolean }).cancelled).toBe(true);
  });

  it("completed 任务再 cancel → didnt task_already_terminal（无可取消）", async () => {
    const f = makeFakeDeps();
    const started = await doDownload(startArgs(), f.deps, ssrfConfig);
    const taskId = (started.data as { task_id: string }).task_id;
    f.tasks.get(taskId)!.progress = {
      ...f.tasks.get(taskId)!.progress,
      state: "completed",
    };
    const r = await doDownload(
      { action: "cancel", task_id: taskId },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("task_already_terminal");
  });

  it("不存在的任务 → didnt", async () => {
    const f = makeFakeDeps();
    const r = await doDownload(
      { action: "cancel", task_id: "t-nope" },
      f.deps,
      ssrfConfig,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("download_task_not_found");
  });
});
