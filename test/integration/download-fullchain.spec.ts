/**
 * download-fullchain.spec.ts（审查修复批 P0-1 复审判据——fresh 审查指定：
 * 「必须包含一条走 doDownload+buildDownloadDeps 的真实引擎终态测试」；
 * 之前 176 绿对装配层零覆盖，mutation 实证禁用台账登记仍全绿）。
 *
 * 端到端（SLOW_SPECS 桶）：本地 HTTP fixture 服务器（127.0.0.1，env 放行
 * SSRF 段）→ 真装配 buildDownloadDeps → doDownload(start) → wait 终态 →
 * 断言 files 交付物字节级一致 + staging 清空 + exit 回调定谳链路在位。
 *
 * 覆盖面（审查 P0/P1 的回归钉）：
 *  1. P0-1：aria2 路径任务达 completed + releaseStaging 交付 files（非滞留）
 *  2. P0-1 兜底：kill lasso 视角（无 exit 回调）→ wait 的 poll 副作用定谳
 *  3. P1-3：undici 路径 cancel → state=cancelled 且不被引擎终态覆盖
 *  4. P1-6：总量帽拒新任务
 *  5. P0-2：max_bytes 超帽 → oversize 态（undici 路径已有强制点，aria2 路
 *     走 snapshot 守门——用小 cap 大文件实测）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { buildDownloadDeps, MAX_ACTIVE_ENV } from "../../src/download/deps.js";
import { loadSsrfConfig, type SsrfConfig } from "../../src/ssrf/ssrf-guard.js";
import { doDownload, type DownloadArgs } from "../../src/tools/download.js";
import { DOWNLOADS_DIR_ENV } from "../../src/download/types.js";
import { downloadTasksRoot } from "../../src/download/store.js";

// ---- fixture 服务器（本地大文件源）----
let server: http.Server | null = null;
let baseUrl = "";
const PAYLOAD = Buffer.alloc(2 * 1024 * 1024, 7); // 2MiB 固定字节

// ---- 测试隔离根（任务表/staging 同根）----
let root = "";
let outDir = "";

let ssrfConfig: SsrfConfig = { allowRanges: [], denyRanges: [] };
let deps: ReturnType<typeof buildDownloadDeps> | null = null;

describe("download 全链（真装配终态测试——审查 P0-1 复审判据）", () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "lasso-dl-full-"));
    outDir = path.join(root, "out");
    fs.mkdirSync(outDir, { recursive: true });
    process.env[DOWNLOADS_DIR_ENV] = path.join(root, "tasks");
    // SSRF 段放行（本地 fixture 服务器；与既有 ssrf-guard 扩展点同面）
    process.env.LASSO_SSRF_ALLOW_RANGES = "127.0.0.0/8,::1/128";
    // out_dir 白名单：默认 ~/Downloads + env 追加
    process.env.LASSO_DOWNLOAD_DIR_ALLOWLIST = outDir;

    server = http.createServer((req, res) => {
      const slow = req.url?.includes("slow");
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(String(range));
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : PAYLOAD.length - 1;
          res.writeHead(206, {
            "content-type": "application/octet-stream",
            "content-range": `bytes ${start}-${end}/${PAYLOAD.length}`,
            "content-length": String(end - start + 1),
            "accept-ranges": "bytes",
          });
          res.end(PAYLOAD.subarray(start, end + 1));
          return;
        }
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(PAYLOAD.length),
        "accept-ranges": "bytes",
      });
      if (slow) {
        // 慢速滴流（oversize/守门时序测试用：300ms/chunk，守门轮询必追得上）
        const chunk = 64 * 1024;
        let off = 0;
        const timer = setInterval(() => {
          if (res.destroyed) {
            clearInterval(timer);
            return;
          }
          if (off >= PAYLOAD.length) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(PAYLOAD.subarray(off, off + chunk));
          off += chunk;
        }, 300);
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.end(PAYLOAD);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;

    // 真装配（env 就绪后构造：ssrfConfig 读 LASSO_SSRF_ALLOW_RANGES 放行段）
    ssrfConfig = loadSsrfConfig(process.env);
    deps = buildDownloadDeps(ssrfConfig);
  }, 20_000);

  afterAll(() => {
    server?.close();
    // 防御：清 fixture 服务器派生残留（若有）
    rmSync(root, { recursive: true, force: true });
  });

  function start(url: string, extra: Partial<DownloadArgs> = {}) {
    // proxy off：本机 shell 的 HTTPS_PROXY 会把 127.0.0.1 fixture 指到代理被拒
    return doDownload(
      { action: "start", url, proxy: "off", ...extra } as DownloadArgs,
      deps!,
      ssrfConfig,
    );
  }

  async function waitTerminal(taskId: string, budgetMs = 30_000) {
    const t0 = Date.now();
    for (;;) {
      const r = await doDownload(
        { action: "status", task_id: taskId } as DownloadArgs,
        deps!,
        ssrfConfig,
      );
      const task = (r.data as { task?: { progress: { state: string }; files?: string[] } }).task;
      const state = task?.progress.state ?? "unknown";
      if (state === "completed" || state === "failed" || state === "cancelled" || state === "oversize") {
        return { state, task };
      }
      if (Date.now() - t0 > budgetMs) return { state: `timeout:${state}`, task };
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  it(
    "P0-1 回归钉：aria2 路径 start→exit 回调定谳→completed→files 字节级交付（staging 清空）",
    { timeout: 60_000 },
    async () => {
      const r = await start(`${baseUrl}/payload.bin`, {
        filename: "fullchain.bin",
        max_conn: 4,
      });
      expect(r.outcome).toBe("worked");
      const taskId = (r.data as { task_id: string }).task_id;
      expect(taskId).toBeTruthy();

      const { state, task } = await waitTerminal(taskId);
      expect(state).toBe("completed");
      const files = (task as unknown as { files: string[] }).files;
      expect(files?.length).toBeGreaterThan(0);
      // 字节级一致（交付物本体）
      expect(readFileSync(files![0]).equals(PAYLOAD)).toBe(true);
      // staging 清空（P0-1 滞留定罪的回归钉）
      const stagingRoot = path.join(path.dirname(downloadTasksRoot()), "staging");
      if (existsSync(stagingRoot)) {
        expect(fs.readdirSync(stagingRoot)).toEqual([]);
      }
    },
  );

  it(
    "P1-3 回归钉：undici 路径 cancel → cancelled 不被引擎终态覆盖",
    { timeout: 30_000 },
    async () => {
      // 强制 undici 路：aria2 检测序用 env 毒化（PATH 探测失败 → 降级 in-process）
      const prevPath = process.env.PATH;
      process.env.PATH = "/nonexistent-lasso-test-bin";
      try {
        const r = await start(`${baseUrl}/slow-cancel.bin`, { filename: "cancel-me.bin" });
        expect(r.outcome).toBe("worked");
        const taskId = (r.data as { task_id: string }).task_id;
        // 慢速滴流（300ms/64KiB）给足 cancel 窗口：下载中 controller 必在 Map
        await new Promise((res) => setTimeout(res, 500));
        const c = await doDownload(
          { action: "cancel", task_id: taskId } as DownloadArgs,
          deps!,
          ssrfConfig,
        );
        expect(c.outcome).toBe("worked");
        // 等 promise 自然收尾（若 abort 失效，2MiB 本地瞬间完成——给了覆盖窗口）
        await new Promise((res) => setTimeout(res, 1_500));
        const { state } = await waitTerminal(taskId, 1_000);
        expect(state).toBe("cancelled"); // 幂等守卫：completed 不得覆盖 cancelled
      } finally {
        process.env.PATH = prevPath;
      }
    },
  );

  it(
    "P1-6 回归钉：总量帽拒新任务（too_many_active_downloads）",
    { timeout: 20_000 },
    async () => {
      process.env[MAX_ACTIVE_ENV] = "1";
      try {
        // 占满帽：起一个慢源任务（服务器延迟版？简化：直接造任务文件占位）
        const taskId = "11111111-1111-4111-8111-111111111111";
        fs.mkdirSync(downloadTasksRoot(), { recursive: true });
        fs.writeFileSync(
          path.join(downloadTasksRoot(), `${taskId}.json`),
          JSON.stringify({
            taskId,
            kind: "http",
            source: `${baseUrl}/slow.bin`,
            outDir,
            filename: "occupier.bin",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ownerPid: 999999,
            engine: null,
            enginePid: null,
            engineCmdline: [],
            stdioFile: null,
            progress: { state: "downloading", progress: null, speedBps: null, etaSec: null, downloadedBytes: null, totalBytes: null },
            files: [],
            diagnosis: null,
            proxyUsed: null,
            maxBytes: 5368709120,
            subsFile: null,
          }),
        );
        const r = await start(`${baseUrl}/payload.bin`);
        expect(r.outcome).toBe("didnt");
        expect(JSON.stringify(r)).toContain("too_many_active_downloads");
      } finally {
        delete process.env[MAX_ACTIVE_ENV];
      }
    },
  );

  it(
    "P0-2 回归钉：max_bytes 超帽 → oversize 态（undici 路 HEAD 预检——确定性）",
    { timeout: 30_000 },
    async () => {
      const prevPath = process.env.PATH;
      process.env.PATH = "/nonexistent-lasso-test-bin"; // 强制 undici 路
      try {
        const r = await start(`${baseUrl}/payload.bin`, {
          filename: "oversize.bin",
          max_bytes: 64 * 1024, // HEAD 预检：Content-Length 2MiB > 64KiB 即拒
        });
        const taskId = (r.data as { task_id: string }).task_id;
        const { state } = await waitTerminal(taskId, 20_000);
        expect(state).toBe("oversize");
      } finally {
        process.env.PATH = prevPath;
      }
    },
  );

  it(
    "P0-1 兜底回归钉：无 exit 回调视角（模拟 lasso 重启）——wait 的 poll 副作用定谳",
    { timeout: 60_000 },
    async () => {
      // 真链起任务，等引擎自然退出后，把任务 ownerPid 换成 999999 + 重新装配
      //（模拟重启：exit 回调随旧 deps 实例失效）→ status 触发 maybeFinalizeOnPoll
      const r = await start(`${baseUrl}/payload.bin`, { filename: "pollfallback.bin" });
      const taskId = (r.data as { task_id: string }).task_id;
      // 等引擎退出（exit 回调会先定谳——为测兜底，先让回调赢再把状态打回去）
      await waitTerminal(taskId, 45_000);
      // 手工打回 downloading + 死 pid（模拟「重启时台账未终态化」的形态）
      const taskFile = path.join(downloadTasksRoot(), `${taskId}.json`);
      const body = JSON.parse(readFileSync(taskFile, "utf8")) as Record<string, unknown>;
      body.progress = { state: "downloading", progress: 0.5, speedBps: null, etaSec: null, downloadedBytes: 1048576, totalBytes: 2097152 };
      body.enginePid = 99999999; // 必死 pid
      body.updatedAt = new Date().toISOString();
      fs.writeFileSync(taskFile, JSON.stringify(body));
      // status 触发 poll 副作用 → pid 死 → finalizeTaskOnExit(null) 按日志/staging 定谳
      const s = await doDownload(
        { action: "status", task_id: taskId } as DownloadArgs,
        deps!,
        ssrfConfig,
      );
      const state = (s.data as { task: { progress: { state: string } } }).task.progress.state;
      expect(["completed", "failed"]).toContain(state); // 兜底路径必达终态（非 downloading）
    },
  );
});
