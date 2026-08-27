/**
 * resource-meter.ts（v1.9 parse17 测试纪律基建 —— doc/testing/01 §0.2 第 6 条配套）
 *
 * 测量「lasso 特征进程树」的 RSS 总和与 CPU 时间，供功能测试用例的
 * 「每个测试用例执行时测资源占用、完毕验证释放」纪律使用：
 *
 *   const meter = new ResourceMeter();
 *   const before = meter.before();     // 基线采样（同时启动 peak 轮询）
 *   ... 跑被测用例（browse / launch-chrome / server 生命周期）...
 *   const peak = meter.peak();         // 期间峰值（轮询采样最大值）
 *   const after = meter.after();       // 收尾采样（停止轮询）
 *   expect(meter.released(before, after)).toBe(true);  // 释放判定
 *
 * 特征匹配（pgrep 等价；macOS 无 /proc，统一走 `ps -axo` 单次快照 + 进程内过滤）：
 *  1. cmdline 含 `--user-data-dir=` 且路径含 "lasso"        —— lasso 起的 Chrome（launch-chrome 台账形态）
 *  2. cmdline 含 "chrome-devtools-mcp" 且 "--disable-blink-features" —— headless MCP 树根（npx shim/node）
 *  3. cmdline 含 "dist/index.js"                              —— lasso MCP server 自身
 * 匹配根 + 其全部后代（ppid 闭包）= lasso 特征进程树（Chromium helper 子进程
 * 的 cmdline 不重复 user-data-dir，必须靠 ppid 归属）。
 *
 * 判定口径（诚实声明）：
 *  - released() = after.count ≤ before.count 且 after.rssKb 回到 before 基线容差内
 *    （默认 +10% + 50MB 绝对 slack——RSS 页回收有噪声，零容差会 flaky）
 *  - 本机 CC 会话可能自带同签名进程（--isolated 的 chrome-devtools-mcp）：before
 *    基线把它们计入，released 用「差值回到基线」判定，不受静态共存进程干扰
 */
import { spawnSync } from "node:child_process";

// ============================================================
// 类型
// ============================================================
export interface ResourceProc {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuSeconds: number;
  cmd: string;
  /** 匹配原因（哪条特征命中；后代 = "descendant-of:<pid>"）。 */
  matchedBy: string;
}

export interface ResourceSample {
  /** epoch ms。 */
  at: number;
  /** 特征进程树内进程数。 */
  count: number;
  /** 特征进程树 RSS 总和（KB）。 */
  rssKb: number;
  /** 特征进程树 CPU 时间总和（秒）。 */
  cpuSeconds: number;
  procs: ResourceProc[];
}

export interface ResourceMeterOptions {
  /** 采样器注入（单测 mock 用；默认真实 ps -axo 快照）。 */
  sampleFn?: () => ResourceSample;
  /** peak 轮询间隔（默认 500ms）。 */
  pollMs?: number;
}

// ============================================================
// 特征匹配
// ============================================================
/** 三条 pgrep 等价特征（见文件头）。返回 null = 非特征根。 */
function matchRoot(cmd: string): string | null {
  if (cmd.includes("--user-data-dir=") && cmd.includes("lasso")) {
    return "user-data-dir-lasso";
  }
  if (cmd.includes("chrome-devtools-mcp") && cmd.includes("--disable-blink-features")) {
    return "chrome-devtools-mcp-headless";
  }
  if (cmd.includes("dist/index.js")) {
    return "lasso-server";
  }
  return null;
}

// ============================================================
// ps 解析
// ============================================================
/**
 * `ps -axo pid=,ppid=,rss=,time=,command=` 输出解析 + 特征树归属。
 * ps 不可用（非 POSIX）→ 空 procs 采样（count=0；released 判定退化为恒真——
 * 测试环境无 ps 时纪律降级而非误报）。
 */
export function sampleLassoTree(): ResourceSample {
  let stdout: string;
  try {
    const r = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) {
      return emptySample();
    }
    stdout = r.stdout;
  } catch {
    return emptySample();
  }

  const all: Array<Omit<ResourceProc, "matchedBy">> = [];
  for (const line of stdout.split("\n")) {
    // 固定前 4 列（pid ppid rss time）+ 其余全部为 command
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/);
    if (!m) continue;
    all.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      cpuSeconds: parseCpuTime(m[4]!),
      cmd: m[5]!,
    });
  }

  // 根匹配 + ppid 闭包（后代归属）
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const inTree = new Map<number, string>();
  for (const p of all) {
    const why = matchRoot(p.cmd);
    if (why) inTree.set(p.pid, why);
  }
  for (const p of all) {
    if (inTree.has(p.pid)) continue;
    // 沿 ppid 链上溯（≤32 层防环）
    let cur = p.ppid;
    for (let i = 0; i < 32; i++) {
      if (inTree.has(cur)) {
        inTree.set(p.pid, `descendant-of:${cur}`);
        break;
      }
      const parent = byPid.get(cur);
      if (!parent) break;
      cur = parent.ppid;
    }
  }

  const procs: ResourceProc[] = all
    .filter((p) => inTree.has(p.pid))
    .map((p) => ({ ...p, matchedBy: inTree.get(p.pid)! }));
  return {
    at: Date.now(),
    count: procs.length,
    rssKb: procs.reduce((n, p) => n + p.rssKb, 0),
    cpuSeconds: procs.reduce((n, p) => n + p.cpuSeconds, 0),
    procs,
  };
}

/** `[[DD-]HH:]MM:SS.ss` → 秒（ps time 列格式，含 DD- 天分隔）。 */
export function parseCpuTime(s: string): number {
  // 天段（"2-01:00:00" → 天 2 折 48h 加回时段）
  let days = 0;
  let rest = s;
  const dash = s.match(/^(\d+)-(.+)$/);
  if (dash) {
    days = Number(dash[1]);
    rest = dash[2];
  }
  const parts = rest.split(":").map((x) => parseFloat(x));
  if (parts.some((x) => Number.isNaN(x))) return 0;
  return parts.reduce((acc, x) => acc * 60 + x, 0) + days * 86_400;
}

function emptySample(): ResourceSample {
  return { at: Date.now(), count: 0, rssKb: 0, cpuSeconds: 0, procs: [] };
}

// ============================================================
// ResourceMeter
// ============================================================
export class ResourceMeter {
  private readonly sampleFn: () => ResourceSample;
  private readonly pollMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private peakSample: ResourceSample | null = null;
  private stopped = true;

  constructor(opts: ResourceMeterOptions = {}) {
    this.sampleFn = opts.sampleFn ?? sampleLassoTree;
    this.pollMs = opts.pollMs ?? 500;
  }

  /** 基线采样（同时启动 peak 轮询；timer unref 不阻止进程退出）。 */
  before(): ResourceSample {
    const base = this.sampleFn();
    this.peakSample = base;
    this.stopped = false;
    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      const s = this.sampleFn();
      if (
        this.peakSample &&
        (s.rssKb > this.peakSample.rssKb ||
          (s.rssKb === this.peakSample.rssKb && s.count > this.peakSample.count))
      ) {
        this.peakSample = s;
      }
    }, this.pollMs);
    this.pollTimer.unref?.();
    return base;
  }

  /** 期间峰值采样（RSS 最大者，平手取 count 大者；未 before() → 立即采一次）。 */
  peak(): ResourceSample {
    if (!this.peakSample) this.peakSample = this.sampleFn();
    return this.peakSample;
  }

  /** 收尾采样（停止轮询）。 */
  after(): ResourceSample {
    this.stop();
    return this.sampleFn();
  }

  /** 停止轮询（after() 已含；显式停用于异常路径清理）。 */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 释放判定：after 进程数与 RSS 回到 before 基线。
   * 容差：rss ≤ before.rssKb × (1 + tolerancePct/100) + slackKb（默认 10% + 50MB——
   * RSS 页回收噪声；进程数必须不增）。
   */
  released(
    before: ResourceSample,
    after: ResourceSample,
    opts: { tolerancePct?: number; slackKb?: number } = {},
  ): boolean {
    const tolerancePct = opts.tolerancePct ?? 10;
    const slackKb = opts.slackKb ?? 50 * 1024;
    if (after.count > before.count) return false;
    return after.rssKb <= before.rssKb * (1 + tolerancePct / 100) + slackKb;
  }
}
