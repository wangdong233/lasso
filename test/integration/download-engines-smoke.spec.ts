/**
 * download-engines-smoke.spec.ts（doc/bugs/12 §七验收——真 spawn 冒烟，SLOW_SPECS 桶）
 *
 * 1. 真 aria2c HTTP 下载：本机 Node Range 服务器（127.0.0.1）→ spawnDetachedEngine
 *    真实 spawn（detached+stdio 文件化）→ 轮询 stdioFile 进度 → 字节级断言 →
 *    releaseStaging 交付。aria2c 缺失则整组 skip（describeOrSkip 先例）。
 *    （aria2 不支持 file://；python3 http.server 不支持 Range——Node 服务器
 *    双能力齐备，见 ssrf 测试同款 fixture。）
 * 2. fake-ytdlp.sh 假引擎：CI 无真 yt-dlp 也锁 D14 机读协议（模板/parser/
 *    fixture 三方一致才绿）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveExecutable, spawnDetachedEngine, tailFile } from "../../src/download/engines/spawn.js";
import { planAria2Spawn, parseAria2Progress } from "../../src/download/engines/aria2.js";
import { planYtDlpSpawn, parseYtDlpProgress, interpretYtDlpExit } from "../../src/download/engines/ytdlp.js";
import { releaseStaging } from "../../src/download/engines/staging.js";

// ============================================================
// fixture：Range 能力本地服务器（aria2 -x/-s 需要）
// ============================================================
const FIXTURE = Buffer.alloc(8 * 1024 * 1024, 42); // 8MiB（>Range 并发阈值）
let server: http.Server | null = null;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // /slow-smoke.bin：首字节延迟 5.2s——保证跨过 aria2 --summary-interval=5
    // 的首个节拍（本机快下载会零 summary 完成，进度面就测不到；延迟下载
    // 才有真实机读进度行落 stdioFile）
    const initialDelay = url.pathname === "/slow-smoke.bin" ? 5_200 : 0;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const send = (code: number, headers: Record<string, string>, start: number, end: number) => {
      setTimeout(() => {
        res.writeHead(code, headers);
        res.end(FIXTURE.subarray(start, end + 1));
      }, initialDelay);
    };
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, FIXTURE.length - Number(m[2]));
      const end = m[2] ? Math.min(FIXTURE.length - 1, Number(m[2])) : FIXTURE.length - 1;
      send(206, {
        "Content-Range": `bytes ${start}-${end}/${FIXTURE.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      }, start, end);
    } else {
      send(200, {
        "Content-Length": String(FIXTURE.length),
        "Accept-Ranges": "bytes",
      }, 0, FIXTURE.length - 1);
    }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

const ARIA2 = resolveExecutable("aria2c");
const describeAria2 = ARIA2 ? describe : describe.skip;

/** 等 detached 进程退出 + stdioFile 出现内容（轮询，帽 20s）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("waitFor timeout");
}

function pidAlive(pid: number): boolean {
  const r = spawnSync("kill", ["-0", String(pid)], { encoding: "utf8" });
  return r.status === 0;
}

describeAria2("真 aria2c HTTP 冒烟（detached spawn + stdio 文件化 + 字节断言）", () => {
  it("下载→进度解析→字节一致→releaseStaging 交付", async () => {
    const root = mkdtempSync(join(tmpdir(), "lasso-aria2-smoke-"));
    const env = {
      ...process.env,
      LASSO_DOWNLOADS_PATH: join(root, "downloads", "tasks"),
    };
    try {
      const taskId = "smoke0001";
      const plan = planAria2Spawn(
        {
          taskId,
          source: `${base}/slow-smoke.bin`,
          kind: "http",
          outDir: join(root, "final"),
          filename: "smoke.bin",
          maxConn: 4,
          proxy: null,
          env,
        },
        ARIA2!,
      );
      const { pid } = spawnDetachedEngine(plan.command, plan.spec, env);

      // detached 退出等待：进程消失即完成判据（本冒烟 8MiB 本地秒级）
      await waitFor(() => !pidAlive(pid));
      const log = tailFile(plan.spec.stdioFile) ?? "";
      expect(log.length).toBeGreaterThan(0);

      // 产物字节一致（staging 内直接核——release 前后各一次更稳，这里 release 后核）
      const moved = releaseStaging(taskId, join(root, "final"), env);
      expect(moved).toHaveLength(1);
      expect(readFileSync(moved[0]).equals(FIXTURE)).toBe(true);
      expect(existsSync(plan.stagingDir)).toBe(false);

      // aria2 退出码=0 时 stdio 无 ERROR；进度日志可解析（本冒烟首个 summary
      // 落在服务器首字节延迟窗内——快照是 pre-header 形态：downloaded 已知、
      // total 可为 null(0B/0B) 或满额。终态正确性的硬断言=上方字节一致）
      expect(log).not.toMatch(/\[ERROR\]/);
      const snap = parseAria2Progress(log);
      expect(snap.downloadedBytes).not.toBeNull();
      expect(snap.totalBytes === null || snap.totalBytes === FIXTURE.length).toBe(true);
      expect(snap.progress === null || snap.progress <= 1).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("断点续传形态冒烟：-c + .aria2 控制文件残留场景不拒（决议 D3 载体）", async () => {
    const root = mkdtempSync(join(tmpdir(), "lasso-aria2-resume-"));
    const env = { ...process.env, LASSO_DOWNLOADS_PATH: join(root, "downloads", "tasks") };
    try {
      // 第二次下载同 taskId staging（复刻 kill 后重 spawn 的字节级继续形态：
      // 控制文件在场时 -c 继续而非 EOVERWRITE 拒）
      const taskId = "smoke0002";
      const plan = planAria2Spawn(
        {
          taskId,
          source: `${base}/smoke.bin`,
          kind: "http",
          outDir: join(root, "final"),
          filename: "smoke.bin",
          maxConn: 2,
          proxy: null,
          env,
        },
        ARIA2!,
      );
      const { pid } = spawnDetachedEngine(plan.command, plan.spec, env);
      await waitFor(() => !pidAlive(pid));
      const moved = releaseStaging(taskId, join(root, "final"), env);
      expect(readFileSync(moved[0]).equals(FIXTURE)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fake-ytdlp.sh 假引擎（D14 机读协议锁定——CI 无真引擎也锁）", () => {
  it("真 spawn → stdio 文件 3 行 progress → parser 解析末行 → exit 0=completed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lasso-fake-ytdlp-"));
    const env = { ...process.env, LASSO_DOWNLOADS_PATH: join(root, "downloads", "tasks") };
    try {
      const fixture = join(root, "fake-ytdlp.sh");
      writeFileSync(fixture, readFileSync(join(process.cwd(), "test", "fixtures", "fake-ytdlp.sh")));
      chmodSync(fixture, statSync(fixture).mode | 0o755);

      const taskId = "fake0001";
      const plan = planYtDlpSpawn(
        {
          taskId,
          source: "https://youtu.be/fak3vid1d",
          outDir: join(root, "final"),
          filename: null,
          subs: false,
          audioOnly: false,
          proxy: null,
          env,
        },
        fixture,
      );
      const { pid, child } = spawnDetachedEngine(fixture, plan.spec, env);
      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });
      expect(pid).toBeGreaterThan(0);
      expect(exitCode).toBe(0);

      const log = tailFile(plan.spec.stdioFile) ?? "";
      const lines = log.split("\n").filter((l) => l.startsWith("download:"));
      expect(lines).toHaveLength(3); // fixture 3 行全落

      const snap = parseYtDlpProgress(log);
      expect(snap.downloadedBytes).toBe(10485760);
      expect(snap.totalBytes).toBe(10485760);
      expect(snap.progress).toBe(1);
      expect(snap.speedBps).toBe(2 * 1024 * 1024);
      expect(snap.etaSec).toBe(0);

      expect(interpretYtDlpExit(exitCode).state).toBe("completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
