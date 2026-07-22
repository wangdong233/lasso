/**
 * ResourceMonitor —— 子进程 RSS / CPU 旁路采样（parse8 §3.3 / F3.5.12）
 *
 * 设计原则（parse8 §3.3）：
 *  - **不引入第三方依赖**（守简单性）：Node 原生 fs + process.memoryUsage
 *  - **不渗协议帧**（守 INV-46 parse8 §5.3 —— ResourceMonitor 不读子进程 stdin/stdout）
 *  - **不阻塞主路径**：60s setInterval + timer.unref + 旁路采样
 *  - **不 kill 进程**：仅告警；admin 决策
 *
 * 平台差异（parse8 §3.3 关键边界 + R15）：
 *  - Linux：精确读 /proc/<pid>/statm[1]（resident pages × 4096 = RSS bytes）
 *  - macOS：内核不暴露子进程 RSS → 降级为 host process.memoryUsage()
 *    （doctor 标注"linux 精确 / macos 近似"，告警阈值运维校准）
 *  - CPU：当前实装仅 Linux（/proc/<pid>/stat）；macOS 暂报 null（不引入 pidusage）
 *
 * 借鉴源（parse8 §3.3）：
 *  - SubprocessManager.procs / rustProcs Map（复用既有追踪，不另起 pid Map）
 *  - startZombieReaper 60s setInterval + unref 模式
 */
import { promises as fs } from "node:fs";
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
export interface SubprocResourceSnapshot {
  /** spec 名（"headless" / "logged_in" / "rust-helper" / ...） */
  name: string;
  /** 子进程 PID（未启动 / 已退出 / macOS http 模式为 null） */
  pid: number | null;
  /**
   * RSS MB（Linux 精确；macOS 降级为 host 进程 RSS，近似值）。
   * null = 读 /proc 失败或不支持平台。
   */
  rss_mb: number | null;
  /**
   * CPU 百分比（仅 Linux 计划实装；v0.7 Phase A 简化为 null）。
   * parse8 §3.3 预留接口，实装推 v0.8（需两次采样算 delta）。
   */
  cpu_percent: number | null;
  /** 采样 epoch ms */
  sampled_at: number;
}

export interface ResourceThreshold {
  /** RSS MB 上限（默认 1024 = 1GB） */
  rss_mb: number;
  /** CPU 百分比上限（默认 80；当前 cpu_percent 恒 null → 此项 v0.7 不生效） */
  cpu_percent: number;
  /** 连续超阈值次数触发 logger.warn（默认 5 = 5 分钟连续超阈值） */
  hot_streak: number;
}

// ============================================================
// ResourceMonitor
// ============================================================
/**
 * 采样器：经注入的 listPids 提供器枚举所有受管子进程。
 *
 * INV-46（parse8 §5.3）：不 import McpClient / RustBridge / StdioClientTransport；
 *                       只读 OS 文件（/proc）+ SubprocessManager 的 pid 数字。
 */
export class ResourceMonitor {
  private timer: NodeJS.Timeout | null = null;
  /** 连续超阈值次数（name → count；阈值未超则清零） */
  private hotStreak = new Map<string, number>();

  constructor(
    /**
     * 受管子进程枚举器（注入；SubprocessManager.listManagedPids）。
     * 返回 [{name, pid}] 数组；pid=null 表示该 spec 当前未运行（采样会记 host_rss 降级）。
     */
    private readonly listPids: () => Array<{ name: string; pid: number | null }>,
    private readonly threshold: ResourceThreshold = {
      rss_mb: 1024,
      cpu_percent: 80,
      hot_streak: 5,
    },
  ) {}

  /**
   * 启动 60s 周期采样（旁路监控）。
   * timer.unref → 不阻止 Node 进程退出（守 v0.6 INV-7 衍生：lifecycle 纯净性）。
   */
  start(intervalMs = 60_000): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.sample().catch((e) =>
        logger.error({
          evt: "resource_monitor_error",
          error: String(e),
        }),
      );
    }, intervalMs);
    // unref：让 timer 不阻止 Node 退出（doctor / 进程关闭时无残留 timer）
    this.timer.unref?.();
  }

  /**
   * 手动触发一次采样（测试 + doctor 手测用）。
   * 返回所有受管子进程的 snapshot 数组。
   */
  async sample(): Promise<SubprocResourceSnapshot[]> {
    const out: SubprocResourceSnapshot[] = [];
    for (const { name, pid } of this.listPids()) {
      const snap = await this._sampleOne(name, pid);
      out.push(snap);
      this._checkThreshold(snap);
    }
    return out;
  }

  /** 停止周期采样（shutdown 钩子 / 测试 teardown 用）。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 当前 hot streak 计数（测试 + doctor 用）。 */
  hotStreakCount(name: string): number {
    return this.hotStreak.get(name) ?? 0;
  }

  // ============================================================
  // 私有
  // ============================================================
  /**
   * 采样单个子进程。
   *
   * 平台分支：
   *  - Linux + pid 非 null → 读 /proc/<pid>/statm[1] (resident pages × 4096)
   *  - 非 Linux / pid null → 降级 host process.memoryUsage() 的 rss 字段
   *  - 读 /proc 抛错（进程刚退出 / 权限不足）→ null 不告警
   */
  private async _sampleOne(
    name: string,
    pid: number | null,
  ): Promise<SubprocResourceSnapshot> {
    const sampledAt = Date.now();

    // 非 Linux：降级为 host RSS
    if (process.platform !== "linux") {
      const mem = process.memoryUsage();
      return {
        name,
        pid,
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        cpu_percent: null,
        sampled_at: sampledAt,
      };
    }

    // Linux + pid null：仍报 host（避免丢样本）
    if (pid === null) {
      const mem = process.memoryUsage();
      return {
        name,
        pid,
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        cpu_percent: null,
        sampled_at: sampledAt,
      };
    }

    // Linux + pid：读 /proc/<pid>/statm
    try {
      const statm = await fs.readFile(`/proc/${pid}/statm`, "utf8");
      const residentPages = Number(statm.split(" ")[1]);
      if (!Number.isFinite(residentPages)) {
        return {
          name,
          pid,
          rss_mb: null,
          cpu_percent: null,
          sampled_at: sampledAt,
        };
      }
      // Linux 页大小恒 4096（getconf PAGESIZE 在 x86_64 / arm64 均为此值）
      const rss_mb = Math.round((residentPages * 4096) / 1024 / 1024);
      return {
        name,
        pid,
        rss_mb,
        cpu_percent: null, // v0.7 简化；v0.8 加 /proc/<pid>/stat delta 计算
        sampled_at: sampledAt,
      };
    } catch {
      // 进程刚退出 / 权限不足 / 不存在
      return {
        name,
        pid,
        rss_mb: null,
        cpu_percent: null,
        sampled_at: sampledAt,
      };
    }
  }

  /**
   * 阈值检查 + hot streak 计数。
   *  - 未超阈值 → 该 name 计数清零
   *  - 超阈值且 streak ≥ threshold.hot_streak → logger.warn
   */
  private _checkThreshold(s: SubprocResourceSnapshot): void {
    const hot =
      (s.rss_mb !== null && s.rss_mb > this.threshold.rss_mb) ||
      (s.cpu_percent !== null && s.cpu_percent > this.threshold.cpu_percent);
    if (!hot) {
      this.hotStreak.delete(s.name);
      return;
    }
    const n = (this.hotStreak.get(s.name) ?? 0) + 1;
    this.hotStreak.set(s.name, n);
    if (n >= this.threshold.hot_streak) {
      logger.warn({
        evt: "resource_threshold_exceeded",
        name: s.name,
        pid: s.pid,
        rss_mb: s.rss_mb,
        cpu_percent: s.cpu_percent,
        hot_streak: n,
        threshold: this.threshold,
      });
    }
  }
}
