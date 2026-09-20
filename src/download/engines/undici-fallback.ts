/**
 * undici-fallback.ts（doc/bugs/12 D9——引擎全缺降级：HTTP only 单流下载）
 *
 * 触发面：kind=http 且 aria2c 检测缺失（start.ts spawn 时 detect 逻辑）。
 * 能力面（与决议对齐，不越界）：
 *  - SSRF 全量前置（D12/H4：与 fetch_url 同函数同 config——INV-31 家族纪律，
 *    从 ssrf/ssrf-guard.ts 导入同一 ssrfGuard）；
 *  - maxBytes 双点强制（D12/H4）：HEAD Content-Length 预检 fail-fast +
 *    chunked/未知长流式 watchdog（超限 abort+删半成品，标 oversize 语义）；
 *  - 服务器支持 Range 且体量 ≥4MiB 时 ≤4 并发分片（复用 undici 直连 request；
 *    INV-32 作用域只限 fetch-url.ts，本文件新面用 undici 合规）；
 *  - proxy 走 resolveProxy 同源 dispatcher（D11 对齐 EnvHttpProxyAgent 语义）；
 *  - 重定向：undici 7 顶层 request 无 maxRedirections 选项——requestFollow
 *    手动循环（≤5 跳；每跳都过 ssrfGuard 的 fresh-DNS 面由首检承担，跳转
 *    目标再过一次守卫——redirect-to-private 二次攻击面封死）。
 *
 * 进度=bytes 计数（onProgress 回调；速度=起点至今平均——降级路径不追求
 * ETA 精度）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { request } from "undici";
import { ssrfGuard, loadSsrfConfig, type SsrfConfig } from "../../ssrf/ssrf-guard.js";
import { makeProxyDispatcher } from "./proxy.js";

export interface UndiciDownloadOptions {
  url: string;
  outDir: string;
  /** null → URL pathname basename → "download.bin"。 */
  filename: string | null;
  maxBytes: number;
  proxy: string | null;
  ssrfConfig?: SsrfConfig;
  signal?: AbortSignal;
  onProgress?: (p: {
    downloadedBytes: number | null;
    totalBytes: number | null;
    speedBps: number | null;
  }) => void;
}

export type UndiciDownloadFailureCode =
  | "invalid_url"
  | "ssrf_blocked"
  | "http_error"
  | "network_error"
  | "oversize"
  | "aborted";

export type UndiciDownloadResult =
  | { ok: true; filePath: string; bytes: number }
  | { ok: false; code: UndiciDownloadFailureCode; message: string };

/** Range 并发阈值/上限。 */
const RANGE_PARALLEL_THRESHOLD = 4 * 1024 * 1024;
const RANGE_PARTS = 4;
const MAX_REDIRECT_HOPS = 5;

type RequestOptions = Parameters<typeof request>[1];
interface FollowContext {
  ssrfConfig: SsrfConfig;
}

/**
 * 手动重定向循环（≤5 跳）。每个跳转目标都重过 ssrfGuard（fresh DNS）——
 * 公网 URL 302 → 127.0.0.1 的经典 SSRF redirect 链在此封死。
 * 返回非 3xx 的最终响应（body 由调用方消费）。
 */
async function requestFollow(
  url: string,
  opts: RequestOptions,
  ctx: FollowContext,
): Promise<{ res: Awaited<ReturnType<typeof request>>; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const guard = await ssrfGuard(current, ctx.ssrfConfig);
    if (!guard.allowed) {
      throw new RedirectGuardError(`ssrf:${guard.reason}`);
    }
    const res = await request(current, opts);
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const loc = res.headers["location"];
      await res.body.dump().catch(() => undefined);
      if (typeof loc !== "string" || !loc) {
        return { res, finalUrl: current }; // 无 location 的 3xx 当终态处理
      }
      current = new URL(loc, current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error("too_many_redirects");
}

/** 守卫拒绝（映射 ssrf_blocked 而非 network_error）。 */
class RedirectGuardError extends Error {}

function defaultFilenameForUrl(url: string): string {
  try {
    const base = path.basename(decodeURIComponent(new URL(url).pathname));
    const safe = base.replace(/[/\\]/g, "_").trim();
    return safe || "download.bin";
  } catch {
    return "download.bin";
  }
}

/**
 * 下载入口。失败**不抛**（结构化返回——tools 层映射 diagnosis 用）。
 */
export async function undiciDownload(
  opts: UndiciDownloadOptions,
): Promise<UndiciDownloadResult> {
  const ctx: FollowContext = { ssrfConfig: opts.ssrfConfig ?? loadSsrfConfig() };

  // ── SSRF 前置（D12：同函数同 config；跳转目标由 requestFollow 逐跳复检）──
  const guard = await ssrfGuard(opts.url, ctx.ssrfConfig);
  if (!guard.allowed) {
    return { ok: false, code: "ssrf_blocked", message: `ssrf:${guard.reason}` };
  }

  const dispatcher = makeProxyDispatcher(opts.proxy);
  const maxBytes = Math.max(1, opts.maxBytes);
  const startedAt = Date.now();
  let downloaded = 0;
  const reportProgress = (total: number | null): void => {
    if (!opts.onProgress) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    opts.onProgress({
      downloadedBytes: downloaded,
      totalBytes: total,
      speedBps: elapsed > 0 ? Math.round(downloaded / elapsed) : null,
    });
  };

  // HEAD 探测（重定向跟随；405/501=服务器不支持→GET 流式未知长路径）
  let totalBytes: number | null = null;
  let acceptsRanges = false;
  try {
    const { res: head } = await requestFollow(
      opts.url,
      {
        method: "HEAD",
        dispatcher,
        headersTimeout: 20_000,
        signal: opts.signal,
      },
      ctx,
    );
    await head.body.dump().catch(() => undefined);
    if (head.statusCode >= 200 && head.statusCode < 300) {
      const cl = Number(head.headers["content-length"]);
      if (Number.isFinite(cl) && cl >= 0) totalBytes = cl;
      acceptsRanges = String(head.headers["accept-ranges"] ?? "").includes("bytes");
    }
  } catch (e) {
    if (opts.signal?.aborted) {
      await dispatcher?.close().catch(() => undefined);
      return { ok: false, code: "aborted", message: String(e) };
    }
    if (e instanceof RedirectGuardError) {
      await dispatcher?.close().catch(() => undefined);
      return { ok: false, code: "ssrf_blocked", message: e.message };
    }
    // HEAD 失败不致命——降级 GET 流式（未知长）
  }

  // D12/H4 点一：Content-Length 预检
  if (totalBytes !== null && totalBytes > maxBytes) {
    await dispatcher?.close().catch(() => undefined);
    return {
      ok: false,
      code: "oversize",
      message: `content_length=${totalBytes} > max_bytes=${maxBytes}`,
    };
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const filename = opts.filename ?? defaultFilenameForUrl(opts.url);
  // basename 强制（D12/H5——与工具层 resolveFilename 同纪律，降级路径双保险）
  const filePath = path.join(opts.outDir, path.basename(filename));
  const fd = fs.openSync(filePath, "w");
  const fail = async (
    code: UndiciDownloadFailureCode,
    message: string,
  ): Promise<UndiciDownloadResult> => {
    fs.closeSync(fd);
    fs.rmSync(filePath, { force: true });
    await dispatcher?.close().catch(() => undefined);
    return { ok: false, code, message };
  };
  // D12/H4 点二：流式 watchdog（超限中断——Range 与单流两路径共用）
  const enforceCap = (): boolean => downloaded > maxBytes;

  try {
    if (acceptsRanges && totalBytes !== null && totalBytes >= RANGE_PARALLEL_THRESHOLD) {
      // ── Range 分片并发（≤4）──────────────────────────────────
      const bounds = splitRange(totalBytes, RANGE_PARTS);
      await Promise.all(
        bounds.map(async ([start, end]) => {
          const { res } = await requestFollow(
            opts.url,
            {
              dispatcher,
              headers: { range: `bytes=${start}-${end}` },
              headersTimeout: 30_000,
              signal: opts.signal,
            },
            ctx,
          );
          if (res.statusCode !== 206) {
            await res.body.dump().catch(() => undefined);
            throw new Error(`range_http_${res.statusCode}`);
          }
          let pos = start;
          for await (const chunk of res.body) {
            const buf = chunk as Buffer;
            fs.writeSync(fd, buf, 0, buf.length, pos);
            pos += buf.length;
            downloaded += buf.length;
            reportProgress(totalBytes);
            if (enforceCap()) throw new Error("oversize");
          }
        }),
      );
    } else {
      // ── 单流（未知长/小文件/无 Range）────────────────────────
      const { res } = await requestFollow(
        opts.url,
        {
          dispatcher,
          headersTimeout: 30_000,
          bodyTimeout: 600_000,
          signal: opts.signal,
        },
        ctx,
      );
      if (!(res.statusCode >= 200 && res.statusCode < 300)) {
        await res.body.dump().catch(() => undefined);
        return await fail("http_error", `status_${res.statusCode}`);
      }
      const cl = Number(res.headers["content-length"]);
      if (Number.isFinite(cl) && cl > maxBytes) {
        await res.body.dump().catch(() => undefined);
        return await fail("oversize", `content_length=${cl} > max_bytes=${maxBytes}`);
      }
      for await (const chunk of res.body) {
        const buf = chunk as Buffer;
        fs.writeSync(fd, buf, 0, buf.length, downloaded);
        downloaded += buf.length;
        reportProgress(Number.isFinite(cl) && cl >= 0 ? cl : null);
        if (enforceCap()) {
          await res.body.dump().catch(() => undefined);
          return await fail("oversize", `streamed=${downloaded} > max_bytes=${maxBytes}`);
        }
      }
    }
    fs.closeSync(fd);
    await dispatcher?.close().catch(() => undefined);
    reportProgress(totalBytes);
    return { ok: true, filePath, bytes: downloaded };
  } catch (e) {
    if (opts.signal?.aborted) {
      return await fail("aborted", String(e));
    }
    if (e instanceof RedirectGuardError) {
      return await fail("ssrf_blocked", e.message);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "oversize") {
      return await fail("oversize", `downloaded=${downloaded} > max_bytes=${maxBytes}`);
    }
    return await fail("network_error", msg);
  }
}

function splitRange(total: number, parts: number): Array<[number, number]> {
  const size = Math.ceil(total / parts);
  const out: Array<[number, number]> = [];
  for (let start = 0; start < total; start += size) {
    out.push([start, Math.min(total - 1, start + size - 1)]);
  }
  return out;
}
