/**
 * doctor readiness 检查（parse1 §3.11 + §6 验收 #2）
 *
 * 10 项 check（≥10 验收要求）：
 *   1. node_version          — Node ≥ 20
 *   2. zhipu_api_key         — ZHIPU_API_KEY 存在
 *   3. zhipu_endpoint_reachable — 智谱 MCP endpoint 网络可达（HTTP HEAD/GET，不深测协议）
 *   4. cdp_mcp_installable   — chrome-devtools-mcp@<LOCKED> 在 npm 可装（npm view 查询）
 *   5. chrome_binary         — Chrome / Chromium 二进制存在（browse_logged_in 需要）
 *   6. cdp_9222_logged_in    — 本机 :9222 CDP 可达 + 至少 1 个 tab
 *   7. cache_writable        — cacheDir 可写（mkdir + writeFile + unlink）
 *   8. ssrf_config           — loadSsrfConfig 能解析（env CSV 非法时不崩）
 *   9. serp_selectors        — 百度/Google selector 表非空
 *  10. invariants            — 8 条架构不变量脚本 exit 0
 *
 * 结构化 JSON：
 *   {
 *     ready: bool,
 *     timestamp: ISO,
 *     lasso_version: "0.1.0-dev",
 *     checks: [{ name, status: 'pass'|'fail'|'warn', detail, next_step? }, ...],
 *     blockers: string[]   // status='fail' 的 name 列表
 *   }
 *
 * ready = (blockers.length === 0)。warn 不阻塞 ready。
 *
 * 借鉴：parse1 §3.11；09 §2.1 验收「doctor CLI 覆盖 ≥10 项」。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { BAIDU_SELECTORS, GOOGLE_SELECTORS } from "../serp/selectors.js";
import { loadSsrfConfig } from "../ssrf/ssrf-guard.js";

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LASSO_VERSION = "0.1.0-dev";

// ============================================================
// 类型
// ============================================================
export interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  next_step?: string;
}

export interface DoctorReport {
  ready: boolean;
  timestamp: string;
  lasso_version: string;
  checks: DoctorCheck[];
  blockers: string[];
}

export interface DoctorOptions {
  /** 覆盖 ZHIPU_API_KEY（默认读 process.env）。 */
  zhipuKey?: string;
  /** 覆盖 ZHIPU endpoint。 */
  zhipuEndpoint?: string;
  /** 覆盖 CDP 端口（默认 9222）。 */
  cdpPort?: number;
  /** 覆盖 cache 目录（默认 ~/.cache/lasso）。 */
  cacheDir?: string;
  /**
   * 跳过 invariants spawn（测试环境/无源码场景）。
   * 注：此 check 改为 warn，不算 blocker。
   */
  skipInvariants?: boolean;
  /** 跳过触网检查（zhipu_endpoint_reachable + cdp_9222_logged_in + cdp_mcp_installable）。 */
  skipNetwork?: boolean;
}

// ============================================================
// runDoctor
// ============================================================
export async function runDoctor(
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const zhipuKey = opts.zhipuKey ?? process.env.ZHIPU_API_KEY;
  const zhipuEndpoint =
    opts.zhipuEndpoint ??
    process.env.ZHIPU_ENDPOINT ??
    "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
  const cdpPort = opts.cdpPort ?? parseInt(process.env.LASSO_CDP_PORT ?? "9222", 10);
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".cache", "lasso");

  // 1. node_version
  checks.push(checkNodeVersion());

  // 2. zhipu_api_key
  checks.push(checkZhipuKey(zhipuKey));

  // 3. zhipu_endpoint_reachable
  checks.push(
    opts.skipNetwork
      ? {
          name: "zhipu_endpoint_reachable",
          status: "warn",
          detail: "skipped (skipNetwork=true)",
        }
      : await checkZhipuEndpoint(zhipuEndpoint),
  );

  // 4. cdp_mcp_installable
  checks.push(
    opts.skipNetwork
      ? {
          name: "cdp_mcp_installable",
          status: "warn",
          detail: "skipped (skipNetwork=true)",
        }
      : await checkCdpMcpInstallable(),
  );

  // 5. chrome_binary
  checks.push(await checkChromeBinary());

  // 6. cdp_9222_logged_in
  checks.push(
    opts.skipNetwork
      ? {
          name: "cdp_9222_logged_in",
          status: "warn",
          detail: "skipped (skipNetwork=true)",
        }
      : await checkCdp9222(cdpPort),
  );

  // 7. cache_writable
  checks.push(await checkCacheWritable(cacheDir));

  // 8. ssrf_config
  checks.push(checkSsrfConfig());

  // 9. serp_selectors
  checks.push(checkSerpSelectors());

  // 10. invariants
  checks.push(
    opts.skipInvariants
      ? {
          name: "invariants",
          status: "warn",
          detail: "skipped (skipInvariants=true)",
        }
      : await checkInvariants(),
  );

  const blockers = checks.filter((c) => c.status === "fail").map((c) => c.name);

  return {
    ready: blockers.length === 0,
    timestamp: new Date().toISOString(),
    lasso_version: LASSO_VERSION,
    checks,
    blockers,
  };
}

// ============================================================
// 单项 check
// ============================================================

/** 1. Node ≥ 20（package.json engines）。 */
function checkNodeVersion(): DoctorCheck {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return {
    name: "node_version",
    status: major >= 20 ? "pass" : "fail",
    detail: `Node ${process.versions.node}`,
    next_step:
      major >= 20 ? undefined : "升级到 Node >= 20（推荐 22 LTS 或更高）",
  };
}

/** 2. ZHIPU_API_KEY 存在（不验证有效性）。 */
function checkZhipuKey(key: string | undefined): DoctorCheck {
  return {
    name: "zhipu_api_key",
    status: key ? "pass" : "fail",
    detail: key ? "已配置（有效性未深测）" : "ZHIPU_API_KEY 未设置",
    next_step: key ? undefined : "export ZHIPU_API_KEY=<your-key>",
  };
}

/** 3. 智谱 MCP endpoint 可达（HEAD 请求，2xx/4xx 都算"可达"；网络错才算 fail）。 */
async function checkZhipuEndpoint(endpoint: string): Promise<DoctorCheck> {
  try {
    const resp = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      // 不带 Authorization 也行——只测 TCP/TLS+HTTP 通
    });
    return {
      name: "zhipu_endpoint_reachable",
      // 401/403/405 都说明端点活着；5xx 视为不稳定 → warn
      status: resp.status < 500 ? "pass" : "warn",
      detail: `HTTP ${resp.status} ${resp.statusText}`,
    };
  } catch (e) {
    return {
      name: "zhipu_endpoint_reachable",
      status: "fail",
      detail: String(e),
      next_step: `检查网络 / endpoint: ${endpoint}`,
    };
  }
}

/** 4. chrome-devtools-mcp@<LOCKED> 在 npm registry 可装。 */
async function checkCdpMcpInstallable(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileP(
      "npm",
      ["view", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`, "version"],
      { timeout: 30_000 },
    );
    return {
      name: "cdp_mcp_installable",
      status: "pass",
      detail: `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION} -> ${stdout.trim()}`,
    };
  } catch (e) {
    return {
      name: "cdp_mcp_installable",
      status: "fail",
      detail: String(e),
      next_step: `npm install -g chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
    };
  }
}

/** 5. Chrome 二进制存在（macOS 优先路径）。 */
async function checkChromeBinary(): Promise<DoctorCheck> {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    // Linux 常见路径
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of candidates) {
    try {
      await fs.access(p, fsConstants.X_OK);
      return {
        name: "chrome_binary",
        status: "pass",
        detail: p,
      };
    } catch {
      // try next
    }
  }
  return {
    name: "chrome_binary",
    status: "warn",
    detail: "未找到 Chrome（browse_headless 仍可用 chrome-devtools-mcp 的 bundled chromium；browse_logged_in 需要真实 Chrome）",
    next_step: "安装 Google Chrome（macOS 放到 /Applications）",
  };
}

/** 6. 本机 :9222 CDP 已开 + 至少 1 个 tab。 */
async function checkCdp9222(port: number): Promise<DoctorCheck> {
  try {
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!versionResp.ok) {
      return {
        name: "cdp_9222_logged_in",
        status: "fail",
        detail: `CDP /json/version returned HTTP ${versionResp.status}`,
        next_step: `重启 Chrome with --remote-debugging-port=${port}`,
      };
    }
    const tabsResp = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    const tabs = (await tabsResp.json()) as unknown[];
    return {
      name: "cdp_9222_logged_in",
      status: tabs.length > 0 ? "pass" : "warn",
      detail: `${tabs.length} tabs on CDP port ${port}`,
      next_step:
        tabs.length > 0
          ? undefined
          : `在 Chrome 里打开任意页面后再调用 browse_logged_in`,
    };
  } catch (e) {
    return {
      name: "cdp_9222_logged_in",
      status: "warn",
      detail: String(e),
      next_step: `open -na 'Google Chrome' --args --remote-debugging-port=${port}`,
    };
  }
}

/** 7. cacheDir 可写。 */
async function checkCacheWritable(cacheDir: string): Promise<DoctorCheck> {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const testFile = path.join(cacheDir, ".doctor-write-test");
    await fs.writeFile(testFile, "ok");
    await fs.unlink(testFile);
    return {
      name: "cache_writable",
      status: "pass",
      detail: cacheDir,
    };
  } catch (e) {
    return {
      name: "cache_writable",
      status: "fail",
      detail: String(e),
      next_step: `修复权限或改 LASSO_CACHE_DIR: ${cacheDir}`,
    };
  }
}

/** 8. SSRF 配置可加载（env CSV 非法时不崩）。 */
function checkSsrfConfig(): DoctorCheck {
  try {
    const cfg = loadSsrfConfig();
    return {
      name: "ssrf_config",
      status: "pass",
      detail: `allow=${cfg.allowRanges.length} deny=${cfg.denyRanges.length} (DEFAULT_ALLOW_RANGES 内置 2 条)`,
    };
  } catch (e) {
    return {
      name: "ssrf_config",
      status: "fail",
      detail: String(e),
    };
  }
}

/** 9. SERP selector 表加载（百度 / Google）。 */
function checkSerpSelectors(): DoctorCheck {
  const total = BAIDU_SELECTORS.length + GOOGLE_SELECTORS.length;
  return {
    name: "serp_selectors",
    status: total > 0 ? "pass" : "fail",
    detail: `BAIDU=${BAIDU_SELECTORS.length} GOOGLE=${GOOGLE_SELECTORS.length}`,
  };
}

/** 10. 架构不变量脚本 exit 0。 */
async function checkInvariants(): Promise<DoctorCheck> {
  // 项目根定位：从 dist/doctor/doctor.js 或 src/doctor/doctor.ts 找到根
  // 优先级：process.cwd() → 向上找 package.json
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, "..", ".."),
    path.resolve(__dirname, "..", "..", ".."),
  ];
  let projectRoot: string | null = null;
  for (const c of candidates) {
    try {
      await fs.access(path.join(c, "package.json"));
      projectRoot = c;
      break;
    } catch {
      // try next
    }
  }
  if (!projectRoot) {
    return {
      name: "invariants",
      status: "warn",
      detail: "无法定位项目根（package.json 未找到）",
    };
  }

  // 优先找 src/invariants/check-invariants.mjs（dev 模式）
  const mjsPath = path.join(projectRoot, "src", "invariants", "check-invariants.mjs");
  try {
    await fs.access(mjsPath);
  } catch {
    return {
      name: "invariants",
      status: "warn",
      detail: `脚本缺失: ${mjsPath}`,
    };
  }

  try {
    const { stdout, stderr } = await execFileP(
      "node",
      [mjsPath],
      { timeout: 30_000, cwd: projectRoot },
    );
    const lastLine = (stdout || "").trim().split("\n").slice(-1)[0] || "";
    return {
      name: "invariants",
      status: "pass",
      detail: lastLine || "invariants exit 0",
      next_step: stderr ? `stderr: ${stderr.slice(0, 200)}` : undefined,
    };
  } catch (e) {
    return {
      name: "invariants",
      status: "fail",
      detail: String(e),
      next_step: `cd ${projectRoot} && node src/invariants/check-invariants.mjs`,
    };
  }
}
