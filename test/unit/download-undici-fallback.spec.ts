/**
 * download-undici-fallback.spec.ts（doc/bugs/12 D9 降级引擎 / D12 安全面）
 *
 * 本机 127.0.0.1 Node http 服务器（Range 支持）：
 *  - SSRF：默认 config 拒私网（127.0.0.1 命中 private_ip）；allowRanges 放行后通
 *  - 单流/Range 分片字节一致
 *  - maxBytes 双点（HEAD 预检 oversize / 流式 watchdog）
 *  - redirect 链逐跳复检（公网→127.0.0.1 302 封死）
 *  - abort
 */
import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { undiciDownload } from "../../src/download/engines/undici-fallback.js";

const FIXTURE = Buffer.alloc(5 * 1024 * 1024, 7); // 5MiB（超 Range 阈值 4MiB → 分片路径）
const ALLOW: import("../../src/ssrf/ssrf-guard.js").SsrfConfig = {
  allowRanges: ["127.0.0.1/32", "::1/128"],
  denyRanges: [],
};

let server: http.Server | null = null;
let base = "";

async function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/redirect-into-loopback") {
      // 跳目标 127.0.0.2（127.0.0.0/8 私有段；仅 127.0.0.1/32 默认放行）——
      // 首检 127.0.0.1 放行、跳点复检必须拒
      res.writeHead(302, { location: `http://127.0.0.2:${(server!.address() as AddressInfo).port}/big.bin` });
      res.end();
      return;
    }
    if (url.pathname === "/no-length") {
      // chunked 未知长
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      for (let i = 0; i < 8; i++) res.write(FIXTURE.subarray(0, 64 * 1024));
      res.end();
      return;
    }
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, FIXTURE.length - Number(m[2]));
      const end = m[2] ? Math.min(FIXTURE.length - 1, Number(m[2])) : FIXTURE.length - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${FIXTURE.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      });
      res.end(FIXTURE.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      "Content-Length": String(FIXTURE.length),
      "Accept-Ranges": "bytes",
    });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterAll(() => {
  server?.close();
});

describe("undiciDownload", () => {
  it("SSRF 守卫前置：deny 命中拒（127.0.0.1/32 默认在 allow——用 deny 证明前置链路）", async () => {
    await startServer();
    const blocked = await undiciDownload({
      url: `${base}/big.bin`,
      outDir: tmpdir(),
      filename: "x",
      maxBytes: 1024 ** 3,
      proxy: null,
      ssrfConfig: { allowRanges: [], denyRanges: ["127.0.0.1/32"] }, // deny 优先于 allow
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("ssrf_blocked");

    const tmp = mkdtempSync(join(tmpdir(), "lasso-undici-"));
    try {
      const r = await undiciDownload({
        url: `${base}/big.bin`,
        outDir: tmp,
        filename: "big.bin",
        maxBytes: 1024 ** 3,
        proxy: null,
        ssrfConfig: ALLOW,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.bytes).toBe(FIXTURE.length);
        expect(readFileSync(r.filePath).equals(FIXTURE)).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("未知长 chunked 单流（HEAD 无 Content-Length → GET 流式）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lasso-undici-"));
    try {
      const r = await undiciDownload({
        url: `${base}/no-length`,
        outDir: tmp,
        filename: null, // 引擎自命名：URL basename
        maxBytes: 1024 ** 3,
        proxy: null,
        ssrfConfig: ALLOW,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.filePath).toBe(join(tmp, "no-length"));
        expect(r.bytes).toBe(8 * 64 * 1024);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("maxBytes 点一：HEAD Content-Length 预检 fail-fast（半成品不落盘）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lasso-undici-"));
    try {
      const r = await undiciDownload({
        url: `${base}/big.bin`,
        outDir: tmp,
        filename: "big.bin",
        maxBytes: 1024, // 5MiB fixture → 预检拒
        proxy: null,
        ssrfConfig: ALLOW,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("oversize");
      expect(existsSync(join(tmp, "big.bin"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("maxBytes 点二：流式 watchdog（未知长流超限中断+删半成品）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lasso-undici-"));
    try {
      const r = await undiciDownload({
        url: `${base}/no-length`,
        outDir: tmp,
        filename: "nl.bin",
        maxBytes: 128 * 1024, // 512KiB chunked 流 → 中途超限
        proxy: null,
        ssrfConfig: ALLOW,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("oversize");
      expect(existsSync(join(tmp, "nl.bin"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("redirect 链逐跳复检：127.0.0.1（默认放行）302 → 127.0.0.2（私有段）被拒", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lasso-undici-"));
    try {
      const r = await undiciDownload({
        url: `${base}/redirect-into-loopback`,
        outDir: tmp,
        filename: "x",
        maxBytes: 1024 ** 3,
        proxy: null,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("ssrf_blocked");
        expect(r.message).toMatch(/127\.0\.0\.2/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("abort：AbortSignal 中断 → aborted + 清理", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lasso-undici-"));
    const controller = new AbortController();
    try {
      const p = undiciDownload({
        url: `${base}/big.bin`,
        outDir: tmp,
        filename: "ab.bin",
        maxBytes: 1024 ** 3,
        proxy: null,
        ssrfConfig: ALLOW,
        signal: controller.signal,
      });
      controller.abort();
      const r = await p;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("aborted");
      expect(existsSync(join(tmp, "ab.bin"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
