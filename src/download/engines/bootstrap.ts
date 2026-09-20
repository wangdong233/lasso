/**
 * bootstrap.ts（doc/bugs/12 D10 引擎检测与 lazy opt-in 引导）
 *
 * 检测序：aria2c=PATH→bin 缓存（本机 brew 1.37.0 命中 PATH，引导低优先）；
 * yt-dlp=①LASSO_YTDLP_PATH ②bin 缓存 ③PATH（resolveYtDlpPath）。
 *
 * 引导：yt-dlp_macos standalone 走 GitHub latest release（undici 流式下载
 * ≤37MB，proxy 走 D11 解析）→sha256 校验→chmod 755。
 * **sha256 常量策略（红队 A1-刺②）**：v1 留 `"__UNPINNED__"` 占位（pin 动作
 * =主循环收尾时人工核验后替换；TODO 在常量旁）。非占位值时不匹配即拒用
 * （删文件+结构化错误）——禁安装时现取 SHA（TOCTOU）。
 *
 * aria2 引导（conda-forge）：v1 不自动拉——返回结构化手动提示（本机 brew
 * 已在，检测序命中，此路径低优先）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { request } from "undici";
import { logger } from "../../util/logger.js";
import { resolveExecutable } from "./spawn.js";
import { resolveYtDlpPath } from "./ytdlp.js";
import { ytDlpBinDir } from "./bin-dir.js";
import { makeProxyDispatcher } from "./proxy.js";

// ============================================================
// 检测
// ============================================================

export interface EngineDetectResult {
  path: string | null;
  version: string | null;
  source: "path" | "bin-cache" | "env" | null;
}

/** `--version` 输出首个语义行抽版本号（aria2 本地化输出「aria2 版本 1.37.0」也命中）。 */
function probeVersion(bin: string): string | null {
  try {
    const r = spawnSync(bin, ["--version"], { timeout: 5000, encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    const m = /(\d+\.\d+\.\d+)/.exec(r.stdout ?? "");
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** aria2c：PATH → bin 缓存 `<binDir>/aria2c`。 */
export function detectAria2(env: NodeJS.ProcessEnv = process.env): EngineDetectResult {
  const fromPath = resolveExecutable("aria2c", env);
  if (fromPath) {
    return { path: fromPath, version: probeVersion(fromPath), source: "path" };
  }
  const cached = path.join(ytDlpBinDir(env), "aria2c");
  try {
    fs.accessSync(cached, fs.constants.X_OK);
    return { path: cached, version: probeVersion(cached), source: "bin-cache" };
  } catch {
    return { path: null, version: null, source: null };
  }
}

/** yt-dlp：resolveYtDlpPath 三级 + source 归因（env 直信不验 X_OK——用户显式意志）。 */
export function detectYtDlp(env: NodeJS.ProcessEnv = process.env): EngineDetectResult {
  const p = resolveYtDlpPath(env);
  if (!p) return { path: null, version: null, source: null };
  const source: EngineDetectResult["source"] = (env.LASSO_YTDLP_PATH ?? "").trim()
    ? "env"
    : p === path.join(ytDlpBinDir(env), "yt-dlp_macos")
      ? "bin-cache"
      : "path";
  return { path: p, version: probeVersion(p), source };
}

// ============================================================
// yt-dlp 引导（D10 lazy opt-in）
// ============================================================

/**
 * 🔴 TODO(主循环收尾 pin)：以最新 release 的 yt-dlp_macos 资产 sha256 替换
 * 本占位（获取：curl -sL <asset-url> | shasum -a256）。占位期间跳过校验
 * （warn 日志可见）；替换后不匹配即拒用——下载供应链闭环。
 */
export const YT_DLP_MACOS_SHA256_PIN = "__UNPINNED__";

/** 引导资产上限（yt-dlp_macos 实际 ~37MB；200MiB 防恶意超发）。 */
const BOOTSTRAP_MAX_BYTES = 200 * 1024 * 1024;

export function manualYtDlpHint(env: NodeJS.ProcessEnv = process.env): string {
  const binDir = ytDlpBinDir(env);
  return [
    "手动引导（与自动引导等价）：",
    `  mkdir -p '${binDir}'`,
    `  curl -L -o '${binDir}/yt-dlp_macos' https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos`,
    `  chmod 755 '${binDir}/yt-dlp_macos'`,
  ].join("\n");
}

/**
 * lazy 引导：GitHub latest → yt-dlp_macos 资产 → 流式下载（sha256 增量计算）
 * → 校验 → chmod 755 → 落 bin 缓存。失败抛结构化错误（含 manualYtDlpHint
 * 文案——agent/用户一条命令自救）。
 */
export async function bootstrapYtDlp(opts?: {
  proxy?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<{ path: string }> {
  const env = opts?.env ?? process.env;
  const binDir = ytDlpBinDir(env);
  const dest = path.join(binDir, "yt-dlp_macos");
  const dispatcher = makeProxyDispatcher(opts?.proxy ?? null);
  try {
    // 1) latest release 元数据（带 UA——GitHub API 裸 node UA 会 403）
    const metaRes = await request(
      "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
      {
        dispatcher,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "lasso-mcp-bootstrap",
        },
        headersTimeout: 15_000,
      },
    );
    if (metaRes.statusCode !== 200) {
      throw new Error(`ytdlp_bootstrap_failed:github_api_${metaRes.statusCode}`);
    }
    const meta = (await metaRes.body.json()) as {
      assets?: { name: string; browser_download_url: string; size?: number }[];
    };
    const asset = meta.assets?.find((a) => a.name === "yt-dlp_macos");
    if (!asset?.browser_download_url) {
      throw new Error("ytdlp_bootstrap_failed:asset_not_found");
    }

    // 2) 流式下载到 tmp（同目录 rename 原子化）
    fs.mkdirSync(binDir, { recursive: true });
    const tmp = `${dest}.tmp`;
    const dlRes = await request(asset.browser_download_url, {
      dispatcher,
      headersTimeout: 30_000,
      bodyTimeout: 300_000,
    });
    if (dlRes.statusCode !== 200) {
      await dlRes.body.dump?.();
      throw new Error(`ytdlp_bootstrap_failed:asset_http_${dlRes.statusCode}`);
    }
    const hash = createHash("sha256");
    let total = 0;
    const out = fs.openSync(tmp, "w");
    try {
      for await (const chunk of dlRes.body) {
        total += (chunk as Buffer).length;
        if (total > BOOTSTRAP_MAX_BYTES) {
          throw new Error("ytdlp_bootstrap_failed:asset_oversize");
        }
        hash.update(chunk as Buffer);
        fs.writeSync(out, chunk as Buffer);
      }
    } finally {
      fs.closeSync(out);
    }

    // 3) sha256 校验（占位=跳过+warn；pin 值=不匹配拒用）
    const actual = hash.digest("hex");
    if (YT_DLP_MACOS_SHA256_PIN === "__UNPINNED__") {
      logger.warn({
        evt: "ytdlp_bootstrap_sha_unpinned",
        actual_sha256: actual,
        bytes: total,
        hint: "主循环收尾 pin 后此 warn 消失；不匹配即拒用",
      });
    } else if (actual !== YT_DLP_MACOS_SHA256_PIN) {
      fs.rmSync(tmp, { force: true });
      throw new Error(
        `ytdlp_bootstrap_failed:sha256_mismatch(expect=${YT_DLP_MACOS_SHA256_PIN} actual=${actual})`,
      );
    }

    // 4) 原子落位 + 执行位
    fs.renameSync(tmp, dest);
    fs.chmodSync(dest, 0o755);
    logger.info({ evt: "ytdlp_bootstrapped", path: dest, bytes: total, sha256: actual });
    return { path: dest };
  } catch (e) {
    // 半成品 tmp 清理（失败不留脏 bin 目录）
    try {
      fs.rmSync(`${dest}.tmp`, { force: true });
    } catch {
      // 清理失败不掩盖原始错误
    }
    const err = e instanceof Error ? e : new Error(String(e));
    if (!/^ytdlp_bootstrap_failed:/.test(err.message)) {
      err.message = `ytdlp_bootstrap_failed:${err.message}`;
    }
    err.message = `${err.message}\n${manualYtDlpHint(env)}`;
    throw err;
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

// ============================================================
// aria2 引导（v1 = 结构化手动提示，不自动拉）
// ============================================================

export interface BootstrapAria2ManualResult {
  ok: false;
  error: string;
  hint: string;
}

/** conda-forge 自动引导 v1 预留——本机 brew 检测序命中，此路径低优先。 */
export function bootstrapAria2(): BootstrapAria2ManualResult {
  return {
    ok: false,
    error: "aria2_bootstrap_not_implemented:v1 手动引导",
    hint: [
      "安装 aria2（任选其一）：",
      "  brew install aria2        # macOS（本批开发/测试基线 1.37.0）",
      "  conda install -c conda-forge aria2",
    ].join("\n"),
  };
}
