/**
 * launcher.ts（v1.31 登录接力档）——持久 profile CDP Chrome 拉起引擎（方案 §二 C1）
 *
 * render-launcher.ts 姊妹档（复用其台账/单飞锁/收尸委托/探活轮询骨架），刻意差异：
 *  - **持久 profile**（`login-chrome-profile/<ns>`，跨会话保登录态——与 render 的
 *    per-instance 临时目录语义相反）
 *  - launchMode "login"（台账第五值；idle 走常规非 render 路径，server 内 reaper 收割）
 *  - `--remote-allow-origins=<逗号多值>`（浏览器侧 screencast 链路的 WS Origin 放行）
 *  - 无 guardian（登录档只存在于 MCP server 进程内——server 自托管 ledger reaper，
 *    index.ts:514 先例；CLI 场景无此档）
 *
 * 拉起序注意（方案 §二）：relay 端口与 host 先解析（allow-origins 依赖两者），
 * 本模块只收 allowOrigins 字符串数组——端口/host 推导在 host.ts/login-flags.ts。
 *
 * INV-64 精神：只 import node:* 内置 + ../launcher/*（chrome 生命周期原语）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import { openSync, readFileSync, writeSync, closeSync, unlinkSync, mkdirSync } from "node:fs";
import * as Net from "node:net";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import { chromeCandidatesForPlatform, type ChromePathCandidate } from "../launcher/chrome-paths.js";
import { recordLaunch, readLedgerSync, type LedgerLogFn } from "../launcher/chrome-ledger.js";
import { stopLaunchedChromes, verifyOwnership } from "../launcher/chrome-stop.js";
import { touchChromePort } from "../launcher/chrome-touch.js";
import { LOGIN_FLAGS, LOGIN_PROFILE_PREFIX, loginChromeIdleMs } from "./login-flags.js";

// ============================================================
// 类型与常量
// ============================================================
export interface LoginChromeOk {
  ok: true;
  reused: boolean;
  port: number;
  pid?: number;
  /** ws://127.0.0.1:<port>/devtools/browser/<uuid>（/json/version 权威）。 */
  wsEndpoint: string;
  /** 持久 profile 绝对路径（ns 命名空间内，跨会话复用）。 */
  profileDir: string;
  startedAt: number;
}

export interface LoginChromeFail {
  ok: false;
  error: string;
}

export type LoginChromeResult = LoginChromeOk | LoginChromeFail;

export const LOGIN_LAUNCH_TIMEOUT_MS = 20_000;
export const LOGIN_LOCK_STALE_MS = 30_000;
export const LOGIN_PROBE_INTERVAL_MS = 300;
const LOGIN_PROBE_FETCH_TIMEOUT_MS = 1_000;

export interface LoginChromeOptions {
  /** CDP 端口（loginCdpPort()）。 */
  port: number;
  /** profile 命名空间（loginProfileNs()）。 */
  ns: string;
  /** allow-origins 全集（resolveBridgeHost().allowOrigins）。 */
  allowOrigins: string[];
  /** 台账 idle（默认 loginChromeIdleMs()）。 */
  idleMs?: number;
  platform?: "mac" | "win" | "linux" | "unknown";
  profileBaseDir?: string;
  lockDir?: string;
  probeExists?: (p: string) => Promise<boolean>;
  spawnFn?: (cmd: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => ChildProcess;
  fetchFn?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  tcpProbeFn?: (port: number) => Promise<boolean>;
  aliveFn?: (pid: number) => boolean;
  psFn?: (pid: number) => string;
  stopFn?: (opts: { port: number }) => Promise<unknown>;
  probeIntervalMs?: number;
  launchTimeoutMs?: number;
  nowFn?: () => number;
  logFn?: LedgerLogFn;
}

function cdpVersionUrl(port: number): string {
  return `http://127.0.0.1:${port}/json/version`;
}

function defaultLog(payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ts: Date.now(), ...payload })}\n`);
}

async function defaultProbeExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultFetchFn(url: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> {
  return fetch(url, { signal: AbortSignal.timeout(LOGIN_PROBE_FETCH_TIMEOUT_MS) });
}

/** TCP 可迺性探测（render-launcher tcpConnectable 同款）。 */
export function tcpConnectable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Net.Socket();
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function defaultAliveFn(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultPsFn(pid: number): string {
  try {
    return spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1_000 }).stdout ?? "";
  } catch {
    return "";
  }
}

/** CDP 健康探活（render probeRenderHealth 同款；wsEndpoint 权威来源）。 */
export async function probeLoginHealth(
  port: number,
  fetchFn: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = defaultFetchFn,
): Promise<{ ok: boolean; wsEndpoint?: string }> {
  try {
    const r = await fetchFn(cdpVersionUrl(port));
    if (!r.ok) return { ok: false };
    const data = (await r.json()) as Record<string, unknown>;
    const ws = data?.webSocketDebuggerUrl;
    if (typeof ws !== "string" || !ws.startsWith("ws://")) return { ok: false };
    return { ok: true, wsEndpoint: ws };
  } catch {
    return { ok: false };
  }
}

// ============================================================
// 单飞锁（render acquireRenderLaunchLock 同款骨架，锁名隔离）
// ============================================================
function loginLockPath(port: number, lockDir?: string): string {
  const dir = lockDir ?? path.join(os.homedir(), ".cache", "lasso");
  return path.join(dir, `login-launch-${port}.lock`);
}

export function acquireLoginLaunchLock(
  port: number,
  opts: { lockDir?: string; aliveFn?: (pid: number) => boolean; nowFn?: () => number } = {},
): { locked: boolean; release(): void } {
  const target = loginLockPath(port, opts.lockDir);
  const aliveFn = opts.aliveFn ?? defaultAliveFn;
  const nowFn = opts.nowFn ?? (() => Date.now());
  try {
    mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    /* 已存在/不可建——wx 创建会诚实失败 */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(target, "wx");
      writeSync(fd, `${JSON.stringify({ pid: process.pid, ts: nowFn() })}\n`, null, "utf8");
      return {
        locked: true,
        release: () => {
          try {
            unlinkSync(target);
          } catch {
            /* best-effort */
          }
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return { locked: false, release: () => {} };
      let stale = false;
      try {
        const body = JSON.parse(readFileSync(target, "utf8")) as { pid?: unknown; ts?: unknown };
        const holderPid = typeof body.pid === "number" ? body.pid : undefined;
        const ts = typeof body.ts === "number" ? body.ts : 0;
        stale = (holderPid === undefined || !aliveFn(holderPid)) && nowFn() - ts > LOGIN_LOCK_STALE_MS;
      } catch {
        stale = nowFn() - 0 > LOGIN_LOCK_STALE_MS;
      }
      if (stale) {
        try {
          unlinkSync(target);
        } catch {
          /* 并发者已夺走 */
        }
        continue;
      }
      return { locked: false, release: () => {} };
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return { locked: false, release: () => {} };
}

/** 持久 profile 路径（ns 命名空间；R-INT-08：LOGIN_PROFILE_PREFIX 带内无同名占用）。 */
export function loginProfileDir(ns: string, baseDir?: string): string {
  const base = baseDir ?? path.join(os.homedir(), ".cache", "lasso");
  return path.join(base, LOGIN_PROFILE_PREFIX, ns);
}

// ============================================================
// 主入口（ensure 引擎——幂等；健康→reused，陈留/不在→收尸重拉）
// ============================================================
export async function ensureLoginChrome(opts: LoginChromeOptions): Promise<LoginChromeResult> {
  const port = opts.port;
  const log = opts.logFn ?? defaultLog;
  const aliveFn = opts.aliveFn ?? defaultAliveFn;
  const psFn = opts.psFn ?? defaultPsFn;
  const fetchFn = opts.fetchFn ?? defaultFetchFn;
  const tcpProbeFn = opts.tcpProbeFn ?? tcpConnectable;
  const stopFn =
    opts.stopFn ?? (async (o: { port: number }) => stopLaunchedChromes({ port: o.port, logFn: log }));
  const probeIntervalMs = opts.probeIntervalMs ?? LOGIN_PROBE_INTERVAL_MS;
  const nowFn = opts.nowFn ?? (() => Date.now());
  const deadline = nowFn() + (opts.launchTimeoutMs ?? LOGIN_LAUNCH_TIMEOUT_MS);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---- 1. 二进制探测（chrome-paths 单一真源）----
  const candidates = chromeCandidatesForPlatform({ platform: opts.platform });
  const probe = opts.probeExists ?? defaultProbeExists;
  let found: ChromePathCandidate | null = null;
  for (const c of candidates) {
    if (await probe(c.path)) {
      found = c;
      break;
    }
  }
  if (!found) {
    return {
      ok: false,
      error:
        `login_chrome_not_found:no chrome binary in ${candidates.length} candidates — install Chrome/Chromium or run any browse_headless call once (puppeteer cache) — doctor #5 shares this source`,
    };
  }

  const profileDir = loginProfileDir(opts.ns, opts.profileBaseDir);

  // ---- 2. reused 三条件门（台账 login 记录 + pid 活 + 归属 + CDP 健康）----
  const reuseGate = async (): Promise<
    | { pass: true; pid: number; wsEndpoint: string; startedAt: number }
    | { pass: false; reasons: string[]; cdpUp: boolean }
  > => {
    const rec = readLedgerSync().find((r) => r.port === port && r.launchMode === "login");
    const health = await probeLoginHealth(port, fetchFn);
    if (!rec) return { pass: false, reasons: ["no_ledger_record"], cdpUp: health.ok };
    const reasons: string[] = [];
    const alive = aliveFn(rec.pid);
    const owner = alive && verifyOwnership(rec.pid, rec.profileDir, psFn);
    if (!alive) reasons.push("pid_dead");
    else if (!owner) reasons.push("ownership_failed");
    if (!health.ok) reasons.push("cdp_unhealthy");
    if (reasons.length === 0 && health.wsEndpoint !== undefined) {
      return { pass: true, pid: rec.pid, wsEndpoint: health.wsEndpoint, startedAt: rec.launchedAt };
    }
    return { pass: false, reasons, cdpUp: health.ok };
  };

  const gate0 = await reuseGate();
  if (gate0.pass) {
    await touchChromePort(port);
    log({ evt: "login_ensure_reused", port, pid: gate0.pid });
    return { ok: true, reused: true, port, pid: gate0.pid, wsEndpoint: gate0.wsEndpoint, profileDir, startedAt: gate0.startedAt };
  }
  if (gate0.cdpUp && gate0.reasons.includes("no_ledger_record")) {
    await sleep(probeIntervalMs);
    const recheck = await reuseGate();
    if (recheck.pass) {
      await touchChromePort(port);
      return { ok: true, reused: true, port, pid: recheck.pid, wsEndpoint: recheck.wsEndpoint, profileDir, startedAt: recheck.startedAt };
    }
    if (recheck.cdpUp && recheck.reasons.includes("no_ledger_record")) {
      return {
        ok: false,
        error: `login_port_in_use:CDP responding on ${port} without a login ledger record (foreign chrome? set LASSO_LOGIN_BRIDGE_CDP_PORT)`,
      };
    }
  }
  if (!gate0.reasons.includes("no_ledger_record")) {
    log({ evt: "login_ensure_stale_record_collected", port, reasons: gate0.reasons });
    await stopFn({ port });
  }

  // ---- 3. 单飞锁 + fresh launch ----
  const freshLaunch = async (lock: { locked: boolean; release(): void }): Promise<LoginChromeResult> => {
    try {
      const [tcpBusy, health0] = await Promise.all([tcpProbeFn(port), probeLoginHealth(port, fetchFn)]);
      if (tcpBusy || health0.ok) {
        return {
          ok: false,
          error: `login_port_in_use:port ${port} occupied by a non-login process — set LASSO_LOGIN_BRIDGE_CDP_PORT to a free port`,
        };
      }
      // 持久 profile：mkdir 保内容（与 render 临时目录语义相反）
      try {
        await fs.mkdir(profileDir, { recursive: true });
      } catch {
        /* best-effort：Chrome 会自建 */
      }
      const args = [
        ...LOGIN_FLAGS,
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        ...(opts.allowOrigins.length > 0 ? [`--remote-allow-origins=${opts.allowOrigins.join(",")}`] : []),
        "about:blank",
      ];
      const spawnFn =
        opts.spawnFn ?? ((cmd: string, a: string[], o: { detached: boolean; stdio: "ignore" }) => spawn(cmd, a, o));
      let child: ChildProcess;
      try {
        child = spawnFn(found!.path, args, { detached: true, stdio: "ignore" });
      } catch (e) {
        return { ok: false, error: `login_spawn_error:${String(e).slice(0, 120)}` };
      }
      let exited = false;
      child.on("exit", () => {
        exited = true;
      });
      child.unref();
      const pid = child.pid ?? undefined;
      while (nowFn() < deadline) {
        if (exited) break;
        const health = await probeLoginHealth(port, fetchFn);
        if (health.ok && health.wsEndpoint !== undefined) {
          const startedAt = nowFn();
          if (pid !== undefined) {
            await recordLaunch({
              port,
              pid,
              profileDir,
              launchedAt: startedAt,
              status: "ready",
              launchMode: "login",
              idleMs: opts.idleMs ?? loginChromeIdleMs(),
            });
          }
          await touchChromePort(port);
          log({ evt: "login_ensure_launched", port, pid, profileDir });
          return { ok: true, reused: false, port, pid, wsEndpoint: health.wsEndpoint, profileDir, startedAt };
        }
        await sleep(probeIntervalMs);
      }
      if (!exited && pid !== undefined) {
        await recordLaunch({
          port,
          pid,
          profileDir,
          launchedAt: nowFn(),
          status: "cdp_not_ready",
          launchMode: "login",
          idleMs: opts.idleMs ?? loginChromeIdleMs(),
        });
        await touchChromePort(port);
      }
      return {
        ok: false,
        error: exited
          ? "login_launch_timeout:chrome exited before CDP became ready"
          : `login_launch_timeout:CDP not ready within ${opts.launchTimeoutMs ?? LOGIN_LAUNCH_TIMEOUT_MS}ms (cdp_not_ready recorded)`,
      };
    } finally {
      lock.release();
    }
  };

  const lock = acquireLoginLaunchLock(port, { lockDir: opts.lockDir, aliveFn, nowFn });
  if (lock.locked) return await freshLaunch(lock);

  // ---- 4. 单飞败者：轮询至转正/超时 ----
  while (nowFn() < deadline) {
    await sleep(probeIntervalMs);
    const gate = await reuseGate();
    if (gate.pass) {
      await touchChromePort(port);
      log({ evt: "login_ensure_reused", port, pid: gate.pid, note: "single_flight_promoted" });
      return { ok: true, reused: true, port, pid: gate.pid, wsEndpoint: gate.wsEndpoint, profileDir, startedAt: gate.startedAt };
    }
    const retry = acquireLoginLaunchLock(port, { lockDir: opts.lockDir, aliveFn, nowFn });
    if (retry.locked) return await freshLaunch(retry);
  }
  return {
    ok: false,
    error: `login_launch_timeout:concurrent ensure did not become healthy within ${opts.launchTimeoutMs ?? LOGIN_LAUNCH_TIMEOUT_MS}ms`,
  };
}
