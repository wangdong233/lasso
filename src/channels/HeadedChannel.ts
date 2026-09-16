/**
 * HeadedChannel（W2，doc/bugs/09 决议 A.4，2026-09-16）—— L2 有头强力档
 *
 * 反爬防御梯的 L2：`chrome-devtools-mcp@<LOCKED_CDP_MCP_VERSION>` **不带
 * --headless** 起真实有头 Chromium（窗口可见）。覆盖无头检测站点的驻留 JS
 * 需求（驱动搜索框+轮询结果——喵虎场景本体）。
 *
 * WT0 前置 spike 已验证实效前提（2026-09-16，/tmp/wt0-spike/）：裸有头形态
 * （含 navigator.webdriver=true 的更脏 automation 面）对 tm.aliyun.com 两轮
 * 访问均驻留 ≥20s（headless 形态 2-3s 内被 JS 层驱逐）；保守迁移方向成立
 * （本 spec 比 spike 裸形态更干净——AutomationControlled + 排除
 * --enable-automation）。
 *
 * spawn 形态（决议 A.4②r1）：
 *  - 无 --headless（MCP 入口 headless 默认 false 已核实）；
 *  - **无裸 --isolated**：显式 `--chromeArg=--user-data-dir=<lasso-owned 路径>`
 *    替代——上游 browser.js:138 不传 isolated 且不传 userDataDir 会落
 *    `~/.cache/chrome-devtools-mcp/chrome-profile` 持久共享 profile；该路径
 *    同时是 ps 级归属锚 + post-kill rmSync 清理点（headless freshProfile 同款
 *    先例）。CDP 走 pipe（上游 browser.js pipe:true）——无 TCP 端口暴露。
 *  - --no-usage-statistics（INV-79b 五通道族）。
 *
 * stealth 取舍（决议 A.4③——与 HeadlessChannel **相反**，防后人「顺手对齐」）：
 *  - **不接 StealthEngine 指纹注入**：真实有头环境即真实指纹；注入痕迹本身
 *    是检测信号。仅保留 --disable-blink-features=AutomationControlled（抹
 *    navigator.webdriver）+ --ignoreDefaultChromeArg=--enable-automation
 *    （抹 puppeteer 默认 automation infobar 族 flag）。
 *
 * 生命周期两态（决议 A.4⑤r1——建立在 SubprocessManager procs 域，**不落
 * chrome-ledger**；visible/userTakenAt 豁免是 chrome-idle-reaper 域谓词，对
 * procs 域结构不可达——域事实见决议原文，勿再引错域）：
 *  - 态一·未接管：idle 收割走 LASSO_HEADED_IDLE_MS（默认 30min，非 headless
 *    域 5min——有头窗口弹出是显式可见事件，须覆盖「用户正走向电脑」竞态）。
 *  - 态二·已接管（粘滞永不回落）：30s 周期接管探测器 evaluate
 *    document.hasFocus()，命中 ⇒ SubprocessManager.markUserTaken ⇒ idle 收割
 *    永久豁免；BUG-06 式硬顶 LASSO_HEADED_HARD_CAP_MS（默认 24h）是唯一兜底
 *    出口（防孤儿舰队）。用户关闭出口 = 有头窗口点 X（pipe 断 ⇒ proc exit ⇒
 *    既有清理路径）；lasso 侧关闭出口 = 显式 stop()。
 *
 * 已知语义边界（L3 真机验证项，决议开放项 1/3）：窗口 frontmost 时
 * hasFocus()=true 即使无用户输入——若 agent 驱动期间窗口持续聚焦，探测器
 * 可能提前标 userTaken（后果有界：idle 豁免退化为仅 24h 硬顶兜底）。
 * 真机冒烟已列入 WT2 验收。
 *
 * 借鉴：SteelChannel 平级兄弟先例（extends BrowseChannel + 装配四处 +
 * INV-97）；HeadlessChannel freshProfile 的 profile 目录归属锚/前缀守卫/陈年
 * 双闸（本文件内 headed 域复制，headless-fresh-profile.ts 保持 headless 域
 * 单一真源不动——INV-96④ 锚零扰动）。
 */
import { mkdir } from "node:fs/promises";
import { readdirSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { parseEvalResult } from "../browse/upstream-response.js";
import {
  DEFAULT_HEADED_HARD_CAP_MS,
  DEFAULT_HEADED_IDLE_MS,
} from "../config/config.js";
import { logger } from "../util/logger.js";
import type { BrowseResult, InteractResult } from "../types.js";

// ============================================================
// headed profile 目录（纯常量 + 受守卫删除——headless-fresh-profile.ts 同构，
// headed 域自有实现）
// ============================================================
/** 全部 headed profile rmSync 的 basename 前缀守卫锚。 */
export const HEADED_PROFILE_PREFIX = "headed-profile-";
/** 陈年兜底 age 线（24h，同 HEADLESS_STALE_PROFILE_MS 语义）。 */
export const HEADED_STALE_PROFILE_MS = 24 * 60 * 60 * 1000;
/** headed profile 基目录（~/.cache/lasso/headed——headless 基目录的 headed 子域）。 */
export function headedProfileBaseDir(): string {
  return path.join(os.homedir(), ".cache", "lasso", "headed");
}

/** 构造带归属锚的 headed profile 目录名（`headed-profile-<epoch>-<rand>-p<ownerPid>`）。 */
export function buildHeadedProfileDirName(
  ownerPid: number,
  nowMs: number,
  rand: string,
): string {
  return `${HEADED_PROFILE_PREFIX}${nowMs}-${rand}-p${ownerPid}`;
}

/** 受守卫的 rmSync（全部 headed profile 删除的唯一出口；非法 basename 拒删）。 */
export function rmHeadedProfileDir(dir: string): void {
  const base = path.basename(dir);
  if (!base.startsWith(HEADED_PROFILE_PREFIX)) {
    throw new Error(
      `headed_profile_refuse_delete: basename "${base}" lacks prefix guard ${HEADED_PROFILE_PREFIX}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

// ============================================================
// HeadedChannel
// ============================================================
export interface HeadedChannelOptions {
  /** 态一 idle 收割阈值（config.headedIdleMs；缺省 DEFAULT_HEADED_IDLE_MS）。 */
  idleMs?: number;
  /** 硬顶（config.headedHardCapMs；缺省 DEFAULT_HEADED_HARD_CAP_MS；0 = 无顶）。 */
  hardCapMs?: number;
  /** profile 基目录（测试隔离注入；缺省 headedProfileBaseDir()）。 */
  profileBase?: string;
  /**
   * 窗口位置/尺寸（决议 A.4④）。当前取「角落小窗完全可见」——边缘滑出形态
   * 待开放项 1（macOS occlusion L3：屏幕外窗口 visibilityState:hidden 可能
   * 反成行为评分负信号）验证后收敛；此为显式保守选择非缺省遗漏。
   */
  windowPosition?: string;
  windowSize?: string;
}

export class HeadedChannel extends BrowseChannel {
  readonly name = "browse_headed";
  /** SubprocessManager spec 名（procs 域；与 channel name 分离，headless/steel 同款）。 */
  private readonly specName = "headed";

  private readonly idleMs: number;
  private readonly hardCapMs: number;
  private readonly profileBase: string;
  private readonly windowPosition: string;
  private readonly windowSize: string;
  /** 当前 spawn-epoch 的 lasso-owned profile 目录（null = 未分配，懒建）。 */
  private currentProfileDir: string | null = null;
  /** 陈年扫描每进程一次（首 spawn 前收敛上代崩溃残留）。 */
  private staleScanDone = false;
  /** 接管探测器 timer（null = 未运行；粘滞命中/respawn 停表，下次 getMcpClient 重启）。 */
  private probeTimer: NodeJS.Timeout | null = null;

  /** 探测周期（决议 A.4⑤r1：30s）。 */
  static readonly TAKEOVER_PROBE_INTERVAL_MS = 30_000;
  /** 单次探测 evaluate 的 MCP 调用上界（禁长阻塞——与在途 browse 调用并发安全）。 */
  static readonly TAKEOVER_PROBE_TIMEOUT_MS = 5_000;

  constructor(
    private readonly subproc: SubprocessManager,
    opts: HeadedChannelOptions = {},
  ) {
    super();
    this.idleMs = opts.idleMs ?? DEFAULT_HEADED_IDLE_MS;
    this.hardCapMs = opts.hardCapMs ?? DEFAULT_HEADED_HARD_CAP_MS;
    this.profileBase = opts.profileBase ?? headedProfileBaseDir();
    this.windowPosition = opts.windowPosition ?? "8,40";
    this.windowSize = opts.windowSize ?? "1024,768";
    // 注意：构造零磁盘副作用（profile 目录/spec 注册都懒到首次 getMcpClient——
    // 默认注册 browse_headed 工具不等于每次 server 启动都建目录，S1 静默守则）。
  }

  /** 态二 sticky 豁免恒开（两态生命周期的策略侧声明）。 */
  private get reapPolicy() {
    return {
      idleMs: this.idleMs,
      stickyExempt: true,
      hardCapMs: this.hardCapMs,
    };
  }

  /**
   * 注册 headed spec（懒：首次 getMcpClient / afterHeadedStackKilled 重建时调）。
   * args 序即锁定的 spawn 形态（INV-97 断言锚——禁 --headless / 禁裸 --isolated /
   * 必含 lasso-owned --user-data-dir / --no-usage-statistics / automation 面两抹）。
   */
  private registerHeadedSpec(profileDir: string): void {
    this.subproc.registerSpec(this.specName, {
      command: "npx",
      args: [
        // PERF-1 同款：--prefer-offline 防 npx 冷启动 registry 校验抖动
        "--prefer-offline",
        "-y",
        `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
        // —— 无 --headless（本通道的存在意义）——
        "--no-usage-statistics",
        // A.4③：automation 面仅做「抹痕迹」，禁 StealthEngine 注入（真实环境=真实指纹）
        "--chromeArg=--disable-blink-features=AutomationControlled",
        "--ignoreDefaultChromeArg=--enable-automation",
        // A.4②r1：显式 lasso-owned user-data-dir 替代裸 --isolated
        //（上游缺省形态落共享持久 profile；本路径同时是归属锚+清理点）
        `--chromeArg=--user-data-dir=${profileDir}`,
        // A.4④：角落小窗完全可见（边缘滑出待开放项 1 L3 后收敛）
        `--chromeArg=--window-position=${this.windowPosition}`,
        `--chromeArg=--window-size=${this.windowSize}`,
      ],
      mcpClientName: "lasso-browse-headed",
      reapPolicy: this.reapPolicy,
    });
  }

  /** 分配新 spawn-epoch 的 profile 目录（mkdir best-effort——Chromium 会自建）。 */
  private async assignNewProfileDir(): Promise<string> {
    const dir = path.join(
      this.profileBase,
      buildHeadedProfileDirName(
        process.pid,
        Date.now(),
        randomBytes(3).toString("hex"),
      ),
    );
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // best-effort：Chromium 首启会自建（render-launcher / headless 同款容忍）
    }
    this.currentProfileDir = dir;
    return dir;
  }

  protected async getMcpClient(): Promise<McpClient> {
    // 清理路径④：陈年兜底扫描每进程一次（收敛上代 SIGKILL 崩溃残留）
    if (!this.staleScanDone) {
      this.staleScanDone = true;
      try {
        const r = this.sweepStaleHeadedProfiles();
        if (r.removed.length > 0) {
          logger.info({
            evt: "headed_stale_profile_swept",
            removed: r.removed.length,
            kept: r.kept.length,
          });
        }
      } catch (e) {
        logger.warn({ evt: "headed_stale_profile_sweep_failed", error: String(e) });
      }
    }
    if (this.currentProfileDir === null) {
      // post-kill 重建 / 首次懒建：新 epoch = 新 profile = 新身份
      this.registerHeadedSpec(await this.assignNewProfileDir());
    }
    const client = await this.subproc.ensureRunning(this.specName);
    this.startTakeoverProbe(client);
    return client;
  }

  // ============================================================
  // 接管探测器（态二粘滞的唯一写径触发器）
  // ============================================================
  /**
   * 30s 周期 evaluate document.hasFocus()；命中 ⇒ markUserTaken 粘滞（永不回落）
   * ⇒ 探测使命完成停表。
   *
   * 并发安全（INV-99 锚）：
   *  - 探测器**绝不** ensureRunning/touch（会刷 lastUsedAt ⇒ 态一 idle 收割被
   *    饿死——设计禁令）；只持 spawn 时句柄。
   *  - 单次 callTool 5s 上界 + fire-and-forget（void tick）——JSON-RPC 请求
   *    幂等并发复用，不阻塞在途 browse 调用。
   *  - client 句柄失效（respawn 后旧句柄 not connected）→ 停表；下次
   *    getMcpClient 以新句柄重启。
   */
  private startTakeoverProbe(client: McpClient): void {
    if (this.probeTimer) return; // 单实例（防重复起表）
    const tick = async () => {
      try {
        const r = (await client.callTool(
          "evaluate_script",
          { function: "() => document.hasFocus()" },
          HeadedChannel.TAKEOVER_PROBE_TIMEOUT_MS,
        )) as Parameters<typeof parseEvalResult>[0];
        const v = parseEvalResult(r);
        if (v === true || v === "true") {
          const marked = this.subproc.markUserTaken(this.specName);
          logger.info({
            evt: "headed_user_takeover_detected",
            spec: this.specName,
            marked,
          });
          this.stopTakeoverProbe(); // 粘滞永不回落——无需继续探测
        }
      } catch (e) {
        if (/not connected/i.test(String(e))) {
          // 旧句柄已随 respawn 失效：停表，getMcpClient 会以新句柄重启
          this.stopTakeoverProbe();
          return;
        }
        // 其余（页面无 document / 5s 超时 / evaluate 报错）：best-effort 下轮重试
      }
    };
    this.probeTimer = setInterval(
      () => void tick(),
      HeadedChannel.TAKEOVER_PROBE_INTERVAL_MS,
    );
    this.probeTimer.unref?.(); // 不阻止进程退出
  }

  /** 停表（幂等）。 */
  private stopTakeoverProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /**
   * 停机路径公开出口（index.ts shutdown handler 调；同步零 await——只停 timer，
   * 栈本体的树杀/profile 清理走 exit 钩子，headless 同款分工）。
   */
  stopTakeoverProbeForShutdown(): void {
    this.stopTakeoverProbe();
  }

  /** 探测器在跑？（doctor / 测试观测；只读）。 */
  isTakeoverProbeActive(): boolean {
    return this.probeTimer !== null;
  }

  // ============================================================
  // freshProfile 逃生门（headless 域语义——headed 显式拒，LoggedInChannel 同款）
  // ============================================================
  protected override async applyFreshProfile(): Promise<InteractResult<BrowseResult> | null> {
    return {
      outcome: "didnt",
      data: null,
      served_by: this.name,
      fallback_used: false,
      retrieval_method: "fresh_profile_not_supported",
      error: "fresh_profile_not_supported_on_headed",
      hint: "headed tier identity rotates per spawn epoch (lasso-owned profile dir, auto on idle reap/explicit stop) — no manual rotation needed; stealth identity rotation is a headless-only concept (use browse_headless)",
    };
  }

  /** 观测标签区分于 headless/logged_in 的 chrome_devtools_mcp。 */
  protected override retrievalMethod(): string {
    return "chrome_devtools_mcp_headed";
  }

  /** 机制一保活：action/step dispatch 后刷 lastUsedAt（态一 idle 不误杀 in-flight）。 */
  protected override touchKeepalive(): void {
    this.subproc.touch(this.specName);
  }

  // ============================================================
  // 生命周期出口
  // ============================================================
  /**
   * lasso 侧显式关闭出口（决议 A.4⑤r1）：停探测器 + 退役整棵栈
   * （forgetSpec = 树杀 → post-kill hook 清 profile）。channel 可复用——
   * 下次 browse 走 getMcpClient 懒重建（新 epoch = 新 profile）。
   */
  async stop(): Promise<void> {
    this.stopTakeoverProbe();
    await this.subproc.forgetSpec(this.specName);
  }

  /**
   * post-kill hook 目标（index.ts 装配，name === "headed"）：树杀完成后的
   * profile 清理（先杀后删铁则——活体 Chromium 写盘与 rmSync 竞态封死）。
   * spec 不在此重建——下次 getMcpClient 懒分配新 epoch（identity = 新 profile）。
   */
  async afterHeadedStackKilled(): Promise<void> {
    const dir = this.currentProfileDir;
    this.currentProfileDir = null;
    if (dir === null) return;
    try {
      rmHeadedProfileDir(dir);
    } catch (e) {
      try {
        rmHeadedProfileDir(dir); // best-effort 重试一次
      } catch (e2) {
        logger.warn({
          evt: "headed_profile_remove_failed",
          dir,
          error: String(e2 ?? e),
        });
      }
    }
  }

  /**
   * exit 钩子同步兜底（index.ts process.on("exit")；零 await——异步
   * afterHeadedStackKilled 不可达）：killAllSync 完成后的同步 rmSync。
   */
  cleanupHeadedProfilesSync(): void {
    this.stopTakeoverProbe();
    const dir = this.currentProfileDir;
    this.currentProfileDir = null;
    if (dir === null) return;
    try {
      rmHeadedProfileDir(dir);
    } catch (e) {
      logger.warn({ evt: "headed_profile_exit_remove_failed", dir, error: String(e) });
    }
  }

  /**
   * 崩溃孤儿陈年兜底（清理路径④）：扫 headed-profile-* 目录，双闸
   * （ownerPid 死 + age>24h）全过才删（headless scanStaleFreshProfiles 同构；
   * 禁 glob 全删）。deps 可注入（测试隔离）。
   */
  sweepStaleHeadedProfiles(deps?: {
    isPidAlive?: (pid: number) => boolean;
    now?: () => number;
  }): { removed: string[]; kept: string[] } {
    const isPidAlive =
      deps?.isPidAlive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    const now = deps?.now ?? (() => Date.now());
    const removed: string[] = [];
    const kept: string[] = [];
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = readdirSync(this.profileBase, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
      }));
    } catch {
      return { removed, kept };
    }
    for (const e of entries) {
      if (!e.isDirectory || !e.name.startsWith(HEADED_PROFILE_PREFIX)) continue;
      const dir = path.join(this.profileBase, e.name);
      const m = e.name.match(/-p(\d+)$/);
      const ownerPid = m ? Number(m[1]) : null;
      // age 线 = 目录名编码的 epoch（锚缺失退化 mtime——headless 陈年扫描同构；
      // 目录名 epoch 是构造时真源，不受文件系统 mtime 语义漂移影响）
      const em = e.name.slice(HEADED_PROFILE_PREFIX.length).match(/^(\d+)-/);
      let ageMs: number;
      try {
        const epoch = em ? Number(em[1]) : statSync(dir).mtimeMs;
        ageMs = now() - epoch;
      } catch {
        continue; // stat 失败（并发删除等）跳过
      }
      // 双闸 fail-safe：owner 活（或锚缺失但未过 age 线）→ 跳过
      const ownerAlive = ownerPid !== null && isPidAlive(ownerPid);
      if (ownerAlive || ageMs <= HEADED_STALE_PROFILE_MS) {
        kept.push(dir);
        continue;
      }
      try {
        rmHeadedProfileDir(dir);
        removed.push(dir);
      } catch (err) {
        logger.warn({
          evt: "headed_stale_profile_remove_failed",
          dir,
          error: String(err),
        });
        kept.push(dir);
      }
    }
    return { removed, kept };
  }
}
