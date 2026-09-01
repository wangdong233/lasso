/**
 * render-launcher.ts（v1.19 渲染档设计决议 —— 确定性渲染档 Chrome 拉起引擎）
 *
 * 职责（设计决议 §4.1）：
 *  - spawn detached Chrome（冻结旗标快照 + per-instance user-data-dir/port）
 *  - CDP 探活（/json/version 是 wsEndpoint 权威来源）
 *  - **reused 四条件门（r2 修订）**：①台账有该 port 的 render 记录 ②pid 探活在
 *    ③归属验证 verifyOwnership（chrome-stop 既有导出原语——ps cmdline 含
 *    `--user-data-dir=<profileDir>` 精确标记；🔴 防「台账陈留 + 第三方占 9224」把
 *    他人 wsEndpoint 当 reused 交付、确定性静默击穿）④CDP /json/version 探活通过
 *  - 收尸重拉（四条件任一失败）：stopLaunchedChromes({port}) 走 chrome-stop 验证
 *    路径（already_dead→清账+rmSync profile；pid_reused→只清账绝不杀非归属 pid）
 *  - 20s 超时预算 + 单飞锁（wx 独占；败者轮询转正；持锁者死+超陈化夺锁）
 *  - 台账记录（launchMode:"render" + idleMs）+ touch（跨仓库契约文件）+ 执守补拉
 *    （ensure 成功路径全分支——r2：fresh / reused / 败者转正三出口都拉）
 *
 * Chrome 本体持有者 =「无人」（detached PPID=1 + 磁盘台账共有制）——本 CLI 进程
 * 退出后 Chrome 独立存活；收割调度宿主是 render-guardian 执守进程（本模块只负责
 * 拉起时顺手 ensure 它在世）。
 *
 * 退出码契约（设计决议 3.6，消费方 JSON.parse(stdout) 强依赖）：
 *  2 = Chrome 二进制不存在；3 = 端口被非渲染档占用 / 既有渲染档不健康且重生失败；
 *  4 = 拉起超时（>20s）；5 = 内部错误。台账写失败不改退出码（best-effort）。
 *
 * INV-64 修订合规：只 import node:* 内置 + ../launcher/*（chrome 生命周期原语）；
 * 零 npm dep（旗标面是冻结快照非运行时依赖，裁决二）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import { openSync, readFileSync, writeSync, closeSync, unlinkSync, mkdirSync } from "node:fs";
import * as Net from "node:net";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import {
  chromeCandidatesForPlatform,
  type ChromePathCandidate,
} from "../launcher/chrome-paths.js";
import { recordLaunch, readLedgerSync, type LedgerLogFn } from "../launcher/chrome-ledger.js";
import { stopLaunchedChromes, verifyOwnership } from "../launcher/chrome-stop.js";
import { touchChromePort, chromeTouchPath } from "../launcher/chrome-touch.js";
import { ensureRenderGuardianRunning } from "./render-guardian.js";
import {
  RENDER_DETERMINISTIC_FLAGS,
  RENDER_PROFILE_PREFIX,
  renderCdpPort,
  renderIdleDefaultMs,
} from "./render-flags.js";

// ============================================================
// 类型与常量
// ============================================================
export type RenderEnsureExitCode = 2 | 3 | 4 | 5;

export interface RenderEnsureOk {
  ok: true;
  /** true = 复用既有健康实例（四条件门全过 / 单飞败者转正）。 */
  reused: boolean;
  port: number;
  pid?: number;
  /** ws://127.0.0.1:<port>/devtools/browser/<uuid>（取自 /json/version）。 */
  wsEndpoint: string;
  /** epoch ms，与台账 launchedAt 同源。 */
  startedAt: number;
  /** 消费方 heartbeat 目标文件绝对路径（由 ensure 下发，消费方不硬编码）。 */
  touchPath: string;
  profileDir?: string;
}

export interface RenderEnsureFail {
  ok: false;
  exitCode: RenderEnsureExitCode;
  /** 机器可读原因 token + 人话提示（走 stderr）。 */
  error: string;
}

export type RenderEnsureResult = RenderEnsureOk | RenderEnsureFail;

/** 拉起超时预算（设计决议 3.6：Chrome spawn 实测 ~2.3s + CDP 探活，余量充足）。 */
export const RENDER_LAUNCH_TIMEOUT_MS = 20_000;
/** 单飞锁陈化阈值（> 拉起预算：持锁者 pid 已死且锁龄超此值 → 夺锁重试）。 */
export const RENDER_LOCK_STALE_MS = 30_000;
/** CDP 探活轮询间隔（launch-chrome CDP_PROBE_INTERVAL_MS 同款）。 */
export const RENDER_PROBE_INTERVAL_MS = 300;
/** 单次探活 fetch 超时。 */
const RENDER_PROBE_FETCH_TIMEOUT_MS = 1_000;

export interface RenderLaunchOptions {
  port?: number;
  /** 落台账的 per-launch idle（默认 renderIdleDefaultMs()=env LASSO_RENDER_IDLE_MS）。 */
  idleMs?: number;
  platform?: "mac" | "win" | "linux" | "unknown";
  /** profile 基目录（默认 ~/.cache/lasso；测试隔离注入 tmp）。 */
  profileBaseDir?: string;
  /** 单飞锁目录（默认 ~/.cache/lasso；测试隔离注入 tmp）。 */
  lockDir?: string;
  /** 测试注入：Chrome 二进制存在性探测（默认 fs.access X_OK）。 */
  probeExists?: (p: string) => Promise<boolean>;
  /** 测试注入：spawn（默认 node:child_process.spawn detached+stdio ignore）。 */
  spawnFn?: (cmd: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => ChildProcess;
  /** 测试注入：CDP fetch（默认 global fetch + 1s 超时；返回 { ok, json }）。 */
  fetchFn?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  /** 测试注入：TCP 占用探测（默认 tcpConnectable）。 */
  tcpProbeFn?: (port: number) => Promise<boolean>;
  /** 测试注入：pid 探活（默认 process.kill(pid,0)）。 */
  aliveFn?: (pid: number) => boolean;
  /** 测试注入：ps cmdline（归属验证；默认 spawnSync ps）。 */
  psFn?: (pid: number) => string;
  /** 测试注入：收尸出口（默认 stopLaunchedChromes({port})——chrome-stop 验证路径）。 */
  stopFn?: (opts: { port: number }) => Promise<unknown>;
  /** 测试注入：执守补拉（默认 ensureRenderGuardianRunning；测试 no-op 防真 spawn）。 */
  ensureGuardianFn?: () => Promise<unknown>;
  probeIntervalMs?: number;
  launchTimeoutMs?: number;
  /** 测试注入：时钟（默认 Date.now）。 */
  nowFn?: () => number;
  logFn?: LedgerLogFn;
}

/** CDP /json/version URL（只绑 127.0.0.1，与 --remote-debugging-port 一致）。 */
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
  return fetch(url, { signal: AbortSignal.timeout(RENDER_PROBE_FETCH_TIMEOUT_MS) });
}

/** TCP 可连性探测（launch-chrome tcpConnectable 同款；connect 成功=端口被占）。 */
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

// ============================================================
// CDP 探活（/json/version 是 wsEndpoint 权威来源——设计 §2.4）
// ============================================================
export interface RenderHealthProbe {
  ok: boolean;
  wsEndpoint?: string;
}

export async function probeRenderHealth(
  port: number,
  fetchFn: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = defaultFetchFn,
): Promise<RenderHealthProbe> {
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
// 单飞锁（设计决议 3.6：wx 独占；不做 double-launch）
// ============================================================
export interface RenderLaunchLock {
  locked: boolean;
  /** 败者可读到的持锁者 pid（诊断用）。 */
  holderPid?: number;
  /** 释放锁（仅持锁者调用有效；best-effort）。 */
  release(): void;
}

/** 单飞锁路径：<lockDir>/render-launch-<port>.lock。 */
export function renderLaunchLockPath(port: number, lockDir?: string): string {
  const dir = lockDir ?? path.join(os.homedir(), ".cache", "lasso");
  return path.join(dir, `render-launch-${port}.lock`);
}

/**
 * 以 `wx` 独占创建单飞锁（内容 {pid, ts}）。
 * EEXIST 时：持锁者 pid 已死 **且** 锁龄 > RENDER_LOCK_STALE_MS → 夺锁（unlink 重试，
 * 上限 3 次）；否则返回 locked:false（败者轮询转正，见 launchRenderChrome）。
 */
export function acquireRenderLaunchLock(
  port: number,
  opts: { lockDir?: string; aliveFn?: (pid: number) => boolean; nowFn?: () => number } = {},
): RenderLaunchLock {
  const target = renderLaunchLockPath(port, opts.lockDir);
  const aliveFn = opts.aliveFn ?? defaultAliveFn;
  const nowFn = opts.nowFn ?? (() => Date.now());
  try {
    mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    /* 目录已存在/不可建——wx 创建会诚实失败 */
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
            /* best-effort：锁文件已消失（崩溃恢复/夺锁）不抛 */
          }
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return { locked: false, release: () => {} };
      }
      // 锁被占：读持有者，判「已死且超陈化」→ 夺锁
      let holderPid: number | undefined;
      let stale = false;
      try {
        const body = JSON.parse(readFileSync(target, "utf8")) as { pid?: unknown; ts?: unknown };
        if (typeof body.pid === "number") holderPid = body.pid;
        const ts = typeof body.ts === "number" ? body.ts : 0;
        stale = (holderPid === undefined || !aliveFn(holderPid)) && nowFn() - ts > RENDER_LOCK_STALE_MS;
      } catch {
        // 锁文件不可读（半写/损坏）：按 ts=0 兜底判陈化——不可读且超陈化仍可夺，
        // 否则一个损坏锁会永久卡死该端口的 ensure
        stale = nowFn() - 0 > RENDER_LOCK_STALE_MS;
      }
      if (stale) {
        try {
          unlinkSync(target);
        } catch {
          /* 并发者已夺走——下轮 wx 重试见分晓 */
        }
        continue;
      }
      return { locked: false, holderPid, release: () => {} };
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

// ============================================================
// 主入口（ensure 引擎——消费方 `render-chrome --ensure` 的核心）
// ============================================================
/**
 * 确保渲染档 Chrome 在世（幂等）：健康 → reused:true；陈留/不在 → 收尸重拉。
 * 并发单飞：败者轮询台账 + CDP 健康至超时转正（reused:true），不 double-launch。
 */
export async function launchRenderChrome(
  opts: RenderLaunchOptions = {},
): Promise<RenderEnsureResult> {
  const port = opts.port ?? renderCdpPort();
  const log = opts.logFn ?? defaultLog;
  const aliveFn = opts.aliveFn ?? defaultAliveFn;
  const psFn = opts.psFn ?? defaultPsFn;
  const fetchFn = opts.fetchFn ?? defaultFetchFn;
  const tcpProbeFn = opts.tcpProbeFn ?? tcpConnectable;
  const stopFn =
    opts.stopFn ??
    (async (o: { port: number }) => stopLaunchedChromes({ port: o.port, logFn: log }));
  const ensureGuardianFn =
    opts.ensureGuardianFn ??
    (async () => {
      await ensureRenderGuardianRunning({ logFn: log });
    });
  const probeIntervalMs = opts.probeIntervalMs ?? RENDER_PROBE_INTERVAL_MS;
  const nowFn = opts.nowFn ?? (() => Date.now());
  const deadline = nowFn() + (opts.launchTimeoutMs ?? RENDER_LAUNCH_TIMEOUT_MS);
  const touchPath = chromeTouchPath(port);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---- 1. Chrome 二进制探测（chrome-paths 候选表单一真源；exit 2）----
  const candidates = chromeCandidatesForPlatform({ platform: opts.platform });
  if (candidates.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      error: `render_chrome_not_found:unsupported_platform:${opts.platform ?? process.platform}`,
    };
  }
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
      exitCode: 2,
      error: `render_chrome_not_found:no chrome binary in ${candidates.length} candidates (chrome-paths 单一真源；doctor #5 同源)`,
    };
  }

  // ---- 2. reused 四条件门（r2：+pid 探活 +归属验证）----
  const reuseGate = async (): Promise<
    { pass: true; pid: number; wsEndpoint: string; startedAt: number; profileDir: string } | { pass: false; reasons: string[]; cdpUp: boolean }
  > => {
    const rec = readLedgerSync().find((r) => r.port === port && r.launchMode === "render");
    const health = await probeRenderHealth(port, fetchFn);
    if (!rec) {
      return { pass: false, reasons: ["no_ledger_record"], cdpUp: health.ok };
    }
    const reasons: string[] = [];
    const alive = aliveFn(rec.pid); // ②pid 探活
    const owner = alive && verifyOwnership(rec.pid, rec.profileDir, psFn); // ③归属验证
    if (!alive) reasons.push("pid_dead");
    else if (!owner) reasons.push("ownership_failed");
    if (!health.ok) reasons.push("cdp_unhealthy"); // ④CDP 探活
    if (reasons.length === 0 && health.wsEndpoint !== undefined) {
      return { pass: true, pid: rec.pid, wsEndpoint: health.wsEndpoint, startedAt: rec.launchedAt, profileDir: rec.profileDir };
    }
    return { pass: false, reasons, cdpUp: health.ok };
  };

  const gate0 = await reuseGate();
  if (gate0.pass) {
    // reused:true 直接返回前也补拉执守（r2：防 guardian 死后永不补拉 = P0 泄漏形态复活）
    await touchChromePort(port);
    await ensureGuardianFn();
    log({ evt: "render_ensure_reused", port, pid: gate0.pid });
    return {
      ok: true,
      reused: true,
      port,
      pid: gate0.pid,
      wsEndpoint: gate0.wsEndpoint,
      startedAt: gate0.startedAt,
      touchPath,
      profileDir: gate0.profileDir,
    };
  }
  if (gate0.cdpUp) {
    // CDP 有响应但无台账 render 记录 = 第三方占口（健康但非我方）→ exit 3。
    // 容忍一个探针间隔的落盘竞态（持锁者 CDP bind → recordLaunch 之间的亚毫秒窗）：
    // 复查一次仍无记录才判第三方，防并发 ensure 误伤。
    await sleep(probeIntervalMs);
    const recheck = await reuseGate();
    if (!recheck.pass && recheck.cdpUp && recheck.reasons.includes("no_ledger_record")) {
      return {
        ok: false,
        exitCode: 3,
        error: `render_port_in_use:CDP is responding on port ${port} but no render ledger record (foreign chrome? run \`render-chrome doctor\` 清孤儿)`,
      };
    }
    if (recheck.pass) {
      await touchChromePort(port);
      await ensureGuardianFn();
      log({ evt: "render_ensure_reused", port, pid: recheck.pid, note: "ledger_landed_race" });
      return {
        ok: true,
        reused: true,
        port,
        pid: recheck.pid,
        wsEndpoint: recheck.wsEndpoint,
        startedAt: recheck.startedAt,
        touchPath,
        profileDir: recheck.profileDir,
      };
    }
    // 复查后 CDP 已不响应（瞬时占用）→ 继续走收尸/拉起路径
  }
  if (gate0.reasons.includes("no_ledger_record") === false) {
    // 有陈留记录但不健康 → 收尸重拉（stopLaunchedChromes 验证路径：
    // already_dead→清账+rmSync profile；pid_reused_skipped→只清账绝不杀非归属 pid）
    log({ evt: "render_ensure_stale_record_collected", port, reasons: gate0.reasons });
    await stopFn({ port });
  }

  // ---- 3. 单飞锁 + fresh launch ----
  const freshLaunch = async (lock: RenderLaunchLock): Promise<RenderEnsureResult> => {
    try {
      // 3.1 拉起前 TCP 探测（收尸后/无记录时端口仍被占 = 非渲染档占用 → exit 3）
      const [tcpBusy, health0] = await Promise.all([tcpProbeFn(port), probeRenderHealth(port, fetchFn)]);
      if (tcpBusy || health0.ok) {
        return {
          ok: false,
          exitCode: 3,
          error: `render_port_in_use:port ${port} is occupied by a non-render process (chrome bind would silently fail; run \`render-chrome doctor\` 清孤儿 / LASSO_RENDER_PORT 换测试端口)`,
        };
      }
      // 3.2 per-instance 项：临时 profile + 固定端口（冻结快照不含）
      const base = opts.profileBaseDir ?? path.join(os.homedir(), ".cache", "lasso");
      const profileDir = path.join(
        base,
        `${RENDER_PROFILE_PREFIX}${nowFn()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        await fs.mkdir(profileDir, { recursive: true });
      } catch {
        /* best-effort：Chrome 会自建 */
      }
      const args = [
        ...RENDER_DETERMINISTIC_FLAGS,
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        "about:blank",
      ];
      const spawnFn =
        opts.spawnFn ??
        ((cmd: string, a: string[], o: { detached: boolean; stdio: "ignore" }) => spawn(cmd, a, o));
      let child: ChildProcess;
      try {
        child = spawnFn(found!.path, args, { detached: true, stdio: "ignore" });
      } catch (e) {
        return { ok: false, exitCode: 5, error: `render_spawn_error:${String(e).slice(0, 120)}` };
      }
      let exited = false;
      child.on("exit", () => {
        exited = true;
      });
      child.unref();
      const pid = child.pid ?? undefined;
      // 3.3 CDP 探活轮询至 deadline（通才成功；窗口内未通 → 记 cdp_not_ready + exit 4）
      while (nowFn() < deadline) {
        if (exited) break;
        const health = await probeRenderHealth(port, fetchFn);
        if (health.ok && health.wsEndpoint !== undefined) {
          const startedAt = nowFn();
          if (pid !== undefined) {
            // 台账写失败 best-effort（recordLaunch 内部 catch）——不改退出码
            await recordLaunch({
              port,
              pid,
              profileDir,
              launchedAt: startedAt,
              status: "ready",
              launchMode: "render",
              idleMs: opts.idleMs ?? renderIdleDefaultMs(),
            });
          }
          await touchChromePort(port);
          await ensureGuardianFn();
          log({ evt: "render_ensure_launched", port, pid, profileDir });
          return { ok: true, reused: false, port, pid, wsEndpoint: health.wsEndpoint, startedAt, touchPath, profileDir };
        }
        await sleep(probeIntervalMs);
      }
      // 超时/早退：诚实记录（launch-chrome 先例——不在 launch 时刻代 kill 慢启动；
      // cdp_not_ready 记录由后续 ensure 收尸 / reaper / doctor 接管）
      if (!exited && pid !== undefined) {
        await recordLaunch({
          port,
          pid,
          profileDir,
          launchedAt: nowFn(),
          status: "cdp_not_ready",
          launchMode: "render",
          idleMs: opts.idleMs ?? renderIdleDefaultMs(),
        });
        await touchChromePort(port);
      }
      return {
        ok: false,
        exitCode: 4,
        error: exited
          ? "render_launch_timeout:chrome exited before CDP became ready"
          : `render_launch_timeout:CDP not ready within ${opts.launchTimeoutMs ?? RENDER_LAUNCH_TIMEOUT_MS}ms (cdp_not_ready recorded; next ensure will collect and relaunch)`,
      };
    } finally {
      lock.release();
    }
  };

  let lock = acquireRenderLaunchLock(port, { lockDir: opts.lockDir, aliveFn, nowFn });
  if (lock.locked) {
    return await freshLaunch(lock);
  }

  // ---- 4. 单飞败者：轮询台账 + CDP 健康至 deadline；转正 / 第三方 / 超时 ----
  let foreignSince: number | null = null;
  while (nowFn() < deadline) {
    await sleep(probeIntervalMs);
    const gate = await reuseGate();
    if (gate.pass) {
      // 持锁者已完成拉起 → 本轮转正（reused:true）
      await touchChromePort(port);
      await ensureGuardianFn();
      log({ evt: "render_ensure_reused", port, pid: gate.pid, note: "single_flight_promoted" });
      return {
        ok: true,
        reused: true,
        port,
        pid: gate.pid,
        wsEndpoint: gate.wsEndpoint,
        startedAt: gate.startedAt,
        touchPath,
        profileDir: gate.profileDir,
      };
    }
    if (gate.cdpUp && gate.reasons.includes("no_ledger_record")) {
      // CDP 有响应但台账始终无 render 记录：短暂窗口（持锁者 recordLaunch 落盘前）
      // 容忍；持续到 deadline → 第三方占口 → exit 3（非 4——端口确有非我方 CDP 在服务）
      if (foreignSince === null) foreignSince = nowFn();
    } else {
      foreignSince = null;
    }
    // 持锁者死 + 锁超陈化 → 夺锁重试（acquireRenderLaunchLock 内部判定）
    const retry = acquireRenderLaunchLock(port, { lockDir: opts.lockDir, aliveFn, nowFn });
    if (retry.locked) {
      return await freshLaunch(retry);
    }
  }
  return {
    ok: false,
    exitCode: foreignSince !== null ? 3 : 4,
    error:
      foreignSince !== null
        ? `render_port_in_use:CDP responding on port ${port} without render ledger record (foreign chrome; run \`render-chrome doctor\`)`
        : `render_launch_timeout:concurrent ensure did not become healthy within ${opts.launchTimeoutMs ?? RENDER_LAUNCH_TIMEOUT_MS}ms`,
  };
}
