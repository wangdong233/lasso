/**
 * chrome-idle-reaper.ts（v1.10 parse18 §2 机制一 —— 台账 Chrome idle 用完即关）
 *
 * 设计原理（parse18 §2.1「第二消费者，不是第二套调度」）：
 *  launched Chrome（detached + unref）与 SubprocessManager 的 procs map 零交集
 *  （白盒 §1.4），zombie reaper 结构性看不见它。本 reaper 只做三件事——
 *   1. 读磁盘台账（readLedgerSync）
 *   2. 判 idle（now - max(launchedAt, touch) > idleMs）
 *   3. 调既有 stopLaunchedChromes({port})（归属验证/树杀/删账 100% 复用 chrome-stop.ts）
 *  **零新 kill 原语、零第二份 pgrep 递归**（INV-78c 守：本文件函数体不含
 *  killTreeSync / process.kill 直接调用——杀必须经 chrome-stop 验证路径）。
 *
 * 与 zombie reaper 的分工（两个数据域、两个调度器、一个致死原语族）：
 *  - zombie reaper 管 procs（MCP shim→node 树，LASSO_HEADLESS_IDLE_MS）
 *  - chrome reaper 管 ledger（detached Chrome，LASSO_LAUNCH_IDLE_MS）
 *  两者都最终走 util/kill-tree.ts / chrome-stop 的验证杀。
 *
 * 活动源：LoggedInChannel 每次 browse 经注入回调 onChromeUse → touch(port)。
 * touchMap 是「reaper 读 / LoggedInChannel 经回调写」单写多读形态（R-INT-07 自查：
 * reaper 不写 touchMap，只读；与 SubprocessManager.lastUsedAt 同范式）。
 *
 * 只活在 server 进程（index.ts 装配）——CLI 单独 launch-chrome 无 reaper，chrome-stop
 * 仍是显式出口（诚实边界 parse18 §5.1）。
 *
 * INV-64 合规：只 import node:* 内置 + 同目录 chrome-ledger.js / chrome-stop.js。
 */
import {
  readLedgerSync,
  type LaunchedChromeRecord,
  type LedgerLogFn,
} from "./chrome-ledger.js";
import { stopLaunchedChromes } from "./chrome-stop.js";
// C2（v1.18，doc/28-静默守则审计 D-2）：登录完成自动转后台的 hide 原语
// （PID 定向，永不按进程名——E8 事故红线；非 kill，登录态无损可逆）
import { hideChromeByPid } from "./chrome-hide.js";

// ============================================================
// 类型
// ============================================================
export interface ChromeIdleReaperOptions {
  /** 调度周期（默认 15_000；parse18 §2.2 裁决 4：关窗最坏延迟 = idle + 周期）。 */
  intervalMs?: number;
  /** 全局默认 idle 阈值 ms（= config.launchIdleMs；≤0 时仅当 autoHide 开启才运行）。 */
  defaultIdleMs: number;
  /** 装配时已知的活动端口（= config.cdpPort；启动即 touch 一次给宽限）。 */
  touchPorts?: Set<number>;
  /**
   * C2（v1.18，doc/28 D-2，用户运行守则「介入后及时恢复」）：
   * 对**台账在案 visible 档** Chrome 做「登录完成 → 自动 hide 转后台静默」。
   * **默认 false（opt-in）**——假阳性会把用户正在看的窗口收走（虽 chrome-show
   * 可逆），交用户裁决。四重防误判护栏见 considerAutoHide。
   */
  autoHideAfterLogin?: boolean;
  /** C2：登录墙消失后的等待窗 ms（默认 10_000；窗内再见墙重新计时）。 */
  autoHideDelayMs?: number;
  /** 测试注入：读台账 Chrome 的 tab URL 列表（默认 CDP /json；失败=降级不 hide）。 */
  tabUrlsFn?: (port: number) => Promise<string[]>;
  /** 测试注入：hide 原语（默认 chrome-hide.ts hideChromeByPid）。 */
  hideFn?: (pid: number | undefined) => { ok: boolean; reason?: string };
  /** 测试注入：读台账（默认 readLedgerSync）。 */
  readLedgerFn?: () => LaunchedChromeRecord[];
  /** 测试注入：时钟（默认 Date.now）。 */
  nowFn?: () => number;
  /** 测试注入：回收出口（默认 stopLaunchedChromes({port})）。 */
  stopFn?: (opts: { port: number }) => Promise<unknown>;
  /** 结构化日志注入（index.ts 用 logger 包）。 */
  logFn?: LedgerLogFn;
}

export interface ChromeIdleReaper {
  /** LoggedInChannel 注入回调打点（browse 活动源；重置该 port 的 lastUse）。 */
  touch(port: number): void;
  /** 清 interval（server 停机 best-effort；幂等）。 */
  stop(): void;
}

/** 默认调度周期 15s（parse18 §2.2：读一个小 JSON 文件的定时器开销可忽略）。 */
export const CHROME_IDLE_REAPER_INTERVAL_MS = 15_000;

/**
 * C2：登录墙消失后的默认等待窗（config.ts 从这里取单一真源）。
 * 10s = 用户「提交最后一步登录 → 意识到完成了」的收尾余量；窗内再见墙重新计时。
 */
export const AUTO_HIDE_AFTER_LOGIN_DELAY_MS = 10_000;

/**
 * C2：登录墙 URL 判据（粗筛，与 LoggedInChannel TWOFA_KEYWORDS 同款「粗筛 + 保守
 * 失效方向」哲学）。两侧词边界（前后非字母数字）防 "/authorizations"、"/login-tips"
 * 类假阳性；**假阴性 = 永不自动 hide 降级回手动 chrome-hide**——失效方向安全。
 */
export const LOGIN_WALL_URL_RE =
  /(?:^|[^a-z0-9])(?:login|log-?in|logon|sign-?in|sign_in|oauth|sso|2fa|two-?factor|verify|verification|auth)(?:$|[^a-z0-9-])/i;

/** C2：默认 tab URL 读取——CDP /json（HTTP GET，1s 超时；只绑 127.0.0.1）。 */
async function defaultTabUrlsFn(port: number): Promise<string[]> {
  const r = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!r.ok) throw new Error(`cdp_json_http_${r.status}`);
  const data: unknown = await r.json();
  if (!Array.isArray(data)) return [];
  const urls: string[] = [];
  for (const e of data) {
    if (e && typeof e === "object" && typeof (e as Record<string, unknown>).url === "string") {
      urls.push((e as Record<string, unknown>).url as string);
    }
  }
  return urls;
}

// ============================================================
// 主入口
// ============================================================
/**
 * 启动台账 Chrome idle reaper。
 *
 * 每 tick（单条记录，parse18 §2.3）：
 *  1. rec.idleMs ?? defaultIdleMs ≤ 0 → 跳过（record 级 0=禁用；全局 0 调用方不启动）
 *  2. lastUse = max(rec.launchedAt, touchMap.get(rec.port) ?? 0)
 *  3. now - lastUse > idleMs → await stopFn({port: rec.port})
 *  4. 单条 stop 抛错 → logFn warn 继续（reaper 不因一条记录死）
 *
 * C2（v1.18，doc/28 D-2）：autoHideAfterLogin（opt-in 默认 off）时，visible 记录
 * 在「登录墙观测到→消失→延迟窗过→agent 无近期活动」四重护栏全过后续走
 * hideChromeByPid（PID 定向 hide，非 kill）转后台静默；台账 launchMode 不变
 * （kill 豁免语义不动）。visible 记录永不进 stopFn（N4 红线）。
 *
 * @returns ChromeIdleReaper（timer unref 不阻退出）；defaultIdleMs ≤ 0 且
 *          autoHideAfterLogin 关闭 → null（不启 timer；index.ts 侧配
 *          chrome_idle_reaper_disabled 日志）。
 */
export function startChromeIdleReaper(
  opts: ChromeIdleReaperOptions,
): ChromeIdleReaper | null {
  const intervalMs = opts.intervalMs ?? CHROME_IDLE_REAPER_INTERVAL_MS;
  const defaultIdleMs = opts.defaultIdleMs;
  const autoHideAfterLogin = opts.autoHideAfterLogin === true;
  const autoHideDelayMs = opts.autoHideDelayMs ?? AUTO_HIDE_AFTER_LOGIN_DELAY_MS;
  // 0=禁用（parse18 §2.4）——但 C2 autoHide 开启时 reaper 仍需运行（visible 记录
  // 不受 defaultIdleMs 影响，见 tick 内 per-record idleMs<=0 跳过）
  if (defaultIdleMs <= 0 && !autoHideAfterLogin) return null;
  const readLedgerFn = opts.readLedgerFn ?? readLedgerSync;
  const nowFn = opts.nowFn ?? (() => Date.now());
  const logFn = opts.logFn ?? (() => {});
  const stopFn =
    opts.stopFn ??
    (async (o: { port: number }) =>
      stopLaunchedChromes({ port: o.port, logFn }));
  const tabUrlsFn = opts.tabUrlsFn ?? defaultTabUrlsFn;
  const hideFn = opts.hideFn ?? ((pid: number | undefined) => hideChromeByPid(pid));

  /** port → 最后活动时间（touch 写 / tick 读；单写多读）。 */
  const touchMap = new Map<number, number>();
  const now0 = nowFn();
  for (const p of opts.touchPorts ?? []) touchMap.set(p, now0);

  let stopped = false;
  let ticking = false; // 上一 tick 的 async stop 未完时不叠 tick（守并发）
  const timer = setInterval(() => {
    if (stopped || ticking) return;
    ticking = true;
    void tick()
      .catch(() => {
        /* tick 整体异常不致死（readLedgerFn 已容错；防御外部注入抛错） */
      })
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  timer.unref();

  async function tick(): Promise<void> {
    const now = nowFn();
    const ledger = readLedgerFn();
    for (const rec of ledger) {
      // P1（v1.17.3，得到实战根因）：visible 档 Chrome 是**用户拥有的窗口**
      // （用户在里面登录/查看），永不 idle 收割——关闭出口只有显式 chrome-stop。
      // hidden 档维持「用完即关」语义。
      if (rec.launchMode === "visible") {
        // C2（v1.18，doc/28 D-2）：opt-in 时「登录完成 → 自动 hide 转后台静默」
        //（hide 非 kill；N4 红线不受影响——本分支 continue，永不进 kill 路径）
        if (autoHideAfterLogin) await considerAutoHide(rec, now);
        continue;
      }
      const idleMs = rec.idleMs ?? defaultIdleMs;
      if (idleMs <= 0) continue; // record 级禁用（parse18 §2.5 per-launch 覆盖）
      const lastUse = Math.max(rec.launchedAt, touchMap.get(rec.port) ?? 0);
      if (now - lastUse <= idleMs) continue;
      try {
        await stopFn({ port: rec.port });
        logFn({
          evt: "chrome_idle_reaped",
          port: rec.port,
          pid: rec.pid,
          idle_ms: idleMs,
          idle_for_ms: now - lastUse,
        });
      } catch (e) {
        // 单条失败继续（reaper 不死）；下次 tick 重试（台账条目未被删时）
        logFn({
          evt: "chrome_idle_reap_error",
          port: rec.port,
          pid: rec.pid,
          error: String(e),
        });
      }
    }
  }

  // ----- C2（v1.18，doc/28 D-2）：登录完成自动 hide 状态机（进程内态，不落盘） -----
  /** port → 是否见过登录墙（护栏①的前提：从未见墙 → 永不 hide）。 */
  const loginWallSeen = new Set<number>();
  /** port → 墙消失时刻（延迟窗起点；再见墙则重置）。 */
  const wallClearSince = new Map<number, number>();
  /** port → 已 hide（true）或已永久降级（"failed"；本 server 进程内不再试）。 */
  const autoHideDone = new Map<number, true | "failed">();

  /**
   * C2 四重防误判护栏（任一不满足 → 本 tick 不 hide）：
   *  ① 曾观测到登录墙且现已消失（从未见墙 = 用户可能只是开着看 → 不动）
   *  ② 墙消失后已过 autoHideDelayMs 等待窗（窗内再见墙重新计时——多步登录）
   *  ③ agent 侧无近期活动（touch 距今 ≥ delayMs；in-flight 的粗近似）
   *  ④ 探测失败/形状异常 → 降级不 hide（hide 失败 → 永久降级回手动 chrome-show/hide）
   * 结构性护栏：只迭代台账记录 + hide 按 PID 定向（永不按进程名；永不碰用户自开
   * Chrome）；台账 launchMode 保持 "visible"（后续 tick 继续 continue，kill 豁免
   * 语义不变），chrome-show 可逆。
   */
  async function considerAutoHide(
    rec: LaunchedChromeRecord,
    now: number,
  ): Promise<void> {
    if (autoHideDone.has(rec.port)) return;
    let urls: string[];
    try {
      urls = await tabUrlsFn(rec.port);
    } catch (e) {
      // 护栏④：信息不全绝不收窗口（重置延迟窗，下轮重探）
      wallClearSince.delete(rec.port);
      logFn({ evt: "chrome_auto_hide_probe_error", port: rec.port, error: String(e) });
      return;
    }
    const wallNow = urls.some((u) => LOGIN_WALL_URL_RE.test(u));
    if (wallNow) {
      loginWallSeen.add(rec.port);
      wallClearSince.delete(rec.port); // 用户在登录流程中（可能多步）
      return;
    }
    if (!loginWallSeen.has(rec.port)) return; // 护栏①
    let since = wallClearSince.get(rec.port);
    if (since === undefined) {
      wallClearSince.set(rec.port, now); // 墙刚消失：起表
      return;
    }
    if (now - since < autoHideDelayMs) return; // 护栏②
    const lastUse = Math.max(rec.launchedAt, touchMap.get(rec.port) ?? 0);
    if (now - lastUse < autoHideDelayMs) return; // 护栏③
    const r = hideFn(rec.pid);
    if (r.ok) {
      autoHideDone.set(rec.port, true);
      logFn({
        evt: "chrome_auto_hidden_after_login",
        port: rec.port,
        pid: rec.pid,
        delay_ms: autoHideDelayMs,
        note: "login wall cleared + delay elapsed; PID-targeted hide (reversible via chrome-show); ledger launchMode stays visible (kill-exempt)",
      });
    } else {
      // 护栏④：hide 失败（TCC 缺失等）→ 永久降级回 L0 手动出口，不重试不抛
      autoHideDone.set(rec.port, "failed");
      logFn({
        evt: "chrome_auto_hide_failed",
        port: rec.port,
        pid: rec.pid,
        reason: r.reason ?? "unknown",
        note: "degraded to manual chrome-hide for this server process",
      });
    }
  }

  return {
    touch(port: number) {
      touchMap.set(port, nowFn());
    },
    stop() {
      if (stopped) return; // 幂等
      stopped = true;
      clearInterval(timer);
    },
  };
}