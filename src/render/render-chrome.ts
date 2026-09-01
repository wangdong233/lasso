/**
 * render-chrome.ts（v1.19 渲染档设计决议 3.6/3.7/3.9 —— 渲染档 CLI 入口）
 *
 * 子命令面（消费方与用户的唯一入口是 `render-chrome --ensure`）：
 *  - `--ensure`：幂等确保实例在世 → stdout **单行 JSON**
 *    {wsEndpoint, port, startedAt, reused, touchPath, pid}（消费方 JSON.parse(stdout)
 *    强依赖——stdout 纯净性是硬约束，一切日志/警告走 stderr）
 *  - `--status`：自省（恒 exit 0）；`renderSessions` = 当前打开 page/target 数
 *    （CDP /json/list 实时计数——台账契约禁新字段下的诚实降级，设计决议 3.7）
 *  - `--stop`：幂等（不在运行也 exit 0），输出 {"stopped":[{port,pid,action}]}
 *  - `doctor [--clean]`：孤儿检测 + 陈年 profile 清理（默认 dry-run）
 *
 * 退出码全集（设计决议 3.6）：0 成功；2 Chrome 二进制不存在；3 端口被非渲染档
 * 占用 / 既有渲染档不健康且重生失败；4 拉起超时（>20s）；5 内部错误；1 用法错。
 * 未列举非零 = 未知失败（消费方按通用失败降级、stderr 原样透传）。台账写失败
 * 不改退出码（best-effort）。
 *
 * INV-64 修订合规 (c)：路由经 index.ts（本文件不 auto-execute；顶级禁裸调 run*）。
 */
import process from "node:process";
import { readLedgerSync, type LedgerLogFn } from "../launcher/chrome-ledger.js";
import { stopLaunchedChromes } from "../launcher/chrome-stop.js";
import { chromeTouchPath, chromeTouchMtimeSync } from "../launcher/chrome-touch.js";
import {
  launchRenderChrome,
  probeRenderHealth,
  type RenderLaunchOptions,
} from "./render-launcher.js";
import { renderDoctor } from "./render-doctor.js";
import { renderCdpPort, renderIdleDefaultMs } from "./render-flags.js";

export type RenderChromeCommand = "ensure" | "status" | "stop" | "doctor";

export interface RenderChromeArgs {
  command: RenderChromeCommand;
  /** doctor --clean。 */
  clean?: boolean;
  help?: boolean;
}

/** argv 解析（单独导出便于单测）。--ensure/--status/--stop 为 flag 形态；doctor 子命令。 */
export function parseRenderChromeArgs(argv: string[]): RenderChromeArgs {
  const out: RenderChromeArgs = { command: "ensure" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--ensure") {
      out.command = "ensure";
    } else if (a === "--status") {
      out.command = "status";
    } else if (a === "--stop") {
      out.command = "stop";
    } else if (a === "doctor" || a === "--doctor") {
      out.command = "doctor";
    } else if (a === "--clean") {
      out.clean = true;
    }
    // 未知 flag 忽略（forward-compat）
  }
  return out;
}

const RENDER_CHROME_USAGE = `lasso-mcp render-chrome — 确定性 headless 渲染档 Chrome 治理（服务 media-gen-mcp 等外部消费方）

Usage:
  lasso-mcp render-chrome --ensure              Idempotent: healthy render Chrome →
                                               {wsEndpoint,port,startedAt,reused,touchPath};
                                               else launch (deterministic flags snapshot,
                                               detached, port 9224). Single-line JSON on
                                               stdout; logs go to stderr
  lasso-mcp render-chrome --status              Introspection (always exit 0)
  lasso-mcp render-chrome --stop                Stop render-mode Chrome(s), idempotent
  lasso-mcp render-chrome doctor [--clean]      Orphan render-Chrome scan + stale profile
                                               sweep (dry-run by default; --clean executes)

Exit codes (--ensure): 0 ok; 2 chrome binary missing; 3 port occupied by non-render
process / unhealthy render chrome and respawn failed; 4 launch timeout (>20s);
5 internal error. Env: LASSO_RENDER_PORT (default 9224), LASSO_RENDER_IDLE_MS
(default 600000; <=0 disables auto-reap), LASSO_RENDER_GUARDIAN_PID_PATH.`;

/** stderr 单行 JSON 日志（stdout 纯净性——一切日志走 stderr）。 */
function cliLog(payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ts: Date.now(), ...payload })}\n`);
}

// ============================================================
// status / stop 子命令实现
// ============================================================
export interface RenderStatusOutput {
  running: boolean;
  port: number;
  pid?: number;
  wsEndpoint?: string;
  startedAt?: number;
  idleMs: number;
  lastUseAt?: number;
  /** 当前打开 page/target 数（CDP /json/list 实时计数；非累计会话数——3.7 诚实降级）。 */
  renderSessions: number;
  touchPath: string;
}

async function countRenderSessions(
  port: number,
  fetchFn: RenderLaunchOptions["fetchFn"],
): Promise<number> {
  try {
    const f = fetchFn ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(1_000) }));
    const r = await f(`http://127.0.0.1:${port}/json/list`);
    if (!r.ok) return 0;
    const data = (await r.json()) as unknown;
    if (!Array.isArray(data)) return 0;
    return data.filter(
      (e) => e && typeof e === "object" && (e as Record<string, unknown>).type === "page",
    ).length;
  } catch {
    return 0;
  }
}

async function runStatus(
  writeStdout: (s: string) => void,
  fetchFn?: RenderLaunchOptions["fetchFn"],
): Promise<void> {
  const port = renderCdpPort();
  const rec = readLedgerSync().find((r) => r.port === port && r.launchMode === "render");
  const health = await probeRenderHealth(port, fetchFn);
  const out: RenderStatusOutput = {
    running: health.ok,
    port,
    ...(rec ? { pid: rec.pid, startedAt: rec.launchedAt } : {}),
    ...(health.ok && health.wsEndpoint !== undefined ? { wsEndpoint: health.wsEndpoint } : {}),
    idleMs: rec?.idleMs ?? renderIdleDefaultMs(),
    // lastUseAt = max(launchedAt, touch 文件 mtime)（CLI 进程无 server touchMap，取可得两源）
    ...(rec
      ? { lastUseAt: Math.max(rec.launchedAt, chromeTouchMtimeSync(port) ?? 0) }
      : {}),
    renderSessions: await countRenderSessions(port, fetchFn),
    touchPath: chromeTouchPath(port),
  };
  writeStdout(`${JSON.stringify(out)}\n`);
}

async function runStop(writeStdout: (s: string) => void): Promise<void> {
  // 实现在 stopLaunchedChromes({modes:["render"]}) 之上（设计决议 3.7）：收全部
  // render 记录（任意 port）；归属验证/树杀/删账/profile 清理 100% 走 chrome-stop。
  const result = await stopLaunchedChromes({ modes: ["render"], logFn: cliLog as LedgerLogFn });
  writeStdout(`${JSON.stringify(result)}\n`);
}

// ============================================================
// CLI 主入口（index.ts 子命令 `render-chrome` 路由）
// ============================================================
/**
 * @param opts DI 注入（测试）：writeStdout/writeStderr/writeExit 面板 + fetchFn。
 * 生产路径：process.stdout / process.stderr / process.exit。
 */
export async function runRenderChromeCli(
  argv: string[] = process.argv.slice(3),
  opts: {
    writeStdout?: (s: string) => void;
    writeStderr?: (s: string) => void;
    exitFn?: (code?: number) => void;
    fetchFn?: RenderLaunchOptions["fetchFn"];
    launchOpts?: Omit<RenderLaunchOptions, "port" | "fetchFn" | "logFn">;
  } = {},
): Promise<void> {
  const writeStdout = opts.writeStdout ?? ((s: string) => process.stdout.write(s));
  const writeStderr = opts.writeStderr ?? ((s: string) => process.stderr.write(s));
  const exitFn = opts.exitFn ?? ((code?: number) => process.exit(code));
  const parsed = parseRenderChromeArgs(argv);
  if (parsed.help) {
    writeStdout(RENDER_CHROME_USAGE + "\n");
    exitFn(0);
    return;
  }
  try {
    if (parsed.command === "doctor") {
      const report = renderDoctor({ clean: parsed.clean, logFn: cliLog as LedgerLogFn });
      writeStdout(`${JSON.stringify(report)}\n`);
      exitFn(0);
      return;
    }
    if (parsed.command === "status") {
      await runStatus(writeStdout, opts.fetchFn);
      exitFn(0);
      return;
    }
    if (parsed.command === "stop") {
      await runStop(writeStdout);
      exitFn(0);
      return;
    }
    // --ensure（默认命令）
    const result = await launchRenderChrome({
      ...opts.launchOpts,
      fetchFn: opts.fetchFn,
      logFn: cliLog as LedgerLogFn,
    });
    if (result.ok) {
      // stdout 只这一行 JSON（消费方 JSON.parse 强依赖；未知字段消费方须忽略）
      writeStdout(
        `${JSON.stringify({
          wsEndpoint: result.wsEndpoint,
          port: result.port,
          startedAt: result.startedAt,
          reused: result.reused,
          touchPath: result.touchPath,
          pid: result.pid,
        })}\n`,
      );
      exitFn(0);
      return;
    }
    writeStderr(
      `${JSON.stringify({ evt: "render_ensure_failed", exitCode: result.exitCode, error: result.error })}\n`,
    );
    exitFn(result.exitCode);
    return;
  } catch (e) {
    // 未列举内部错误 → exit 5（消费方按通用失败降级，stderr 原样透传）
    writeStderr(`${JSON.stringify({ evt: "render_chrome_internal_error", error: String(e) })}\n`);
    exitFn(5);
    return;
  }
}
