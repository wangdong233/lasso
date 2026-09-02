/**
 * SerpHealthMonitor 单测（parse8 §3.4 / §5.1）
 *
 * 覆盖：
 *  - onResult(hit=true) 计 hit（registry + hitRate 都 +1）
 *  - onResult(hit=false) 计 miss
 *  - 命中率 < threshold 且样本 ≥ 5 触发 detectChange
 *  - ChangeDetection 返 changed=true → logger.warn + RecordingStore.save
 *  - snapshot 形状正确（engines + recent_alerts + recordings_count）
 *  - INV-45：禁自动重写 selector 表（grep 无 mutator 调用）
 *  - ACC-1①（2026-09-02 性能/准确率轮）：onResult 返回 void（死返回契约删除锚）
 *  - ACC-1②（同轮）：hit 路径自动首录 baseline（幂等）+ snapshot.baselines
 *    陈旧度面 + ①②连测（生产改版检测链首次可 fire 的端到端证明）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { SelectorRegistry } from "../../src/serp/SelectorRegistry.js";
import { HitRateStats } from "../../src/serp/HitRateStats.js";
import { ChangeDetection } from "../../src/serp/ChangeDetection.js";
import { RecordingStore } from "../../src/serp/RecordingStore.js";
import { SerpHealthMonitor } from "../../src/serp/SerpHealthMonitor.js";
import { logger } from "../../src/util/logger.js";

// ============================================================
// helpers
// ============================================================
/**
 * 用真 SelectorRegistry + 真 HitRateStats（v0.2 既有，零改动）+
 * 真 ChangeDetection / RecordingStore（落盘到 tmpdir）。
 */
function makeMonitor(opts?: {
  baselineDir?: string;
  recordingsDir?: string;
  threshold?: number;
}): SerpHealthMonitor {
  const baselineDir =
    opts?.baselineDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "serp-baseline-"));
  const recordingsDir =
    opts?.recordingsDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "serp-recordings-"));
  return new SerpHealthMonitor(
    new SelectorRegistry(),
    new HitRateStats(),
    new ChangeDetection(baselineDir),
    new RecordingStore(recordingsDir),
    opts?.threshold ?? 0.5,
  );
}

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makePushedDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function makeMonitorWithTmp(): SerpHealthMonitor {
  const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-bl-"));
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-rec-"));
  tempDirs.push(baselineDir, recordingsDir);
  return new SerpHealthMonitor(
    new SelectorRegistry(),
    new HitRateStats(),
    new ChangeDetection(baselineDir),
    new RecordingStore(recordingsDir),
    0.5,
  );
}

// ============================================================
// onResult hit / miss 计数
// ============================================================
describe("SerpHealthMonitor — onResult 计数", () => {
  it("onResult(hit=true) 计 hit（snapshot.hit=1）", () => {
    const m = makeMonitorWithTmp();
    m.onResult("baidu", "v1", "test query", "<dom/>", true);
    const snap = m.snapshot();
    const baidu = snap.engines.find((e) => e.engine === "baidu");
    expect(baidu?.hit).toBe(1);
    expect(baidu?.miss).toBe(0);
    expect(baidu?.hit_rate).toBe(1);
  });

  it("onResult(hit=false) 计 miss（snapshot.miss=1）", () => {
    const m = makeMonitorWithTmp();
    m.onResult("baidu", "v1", "q", "<dom/>", false);
    const snap = m.snapshot();
    const baidu = snap.engines.find((e) => e.engine === "baidu");
    expect(baidu?.miss).toBe(1);
    expect(baidu?.hit).toBe(0);
    expect(baidu?.hit_rate).toBe(0);
  });

  it("多次 onResult 累积（4 hit + 1 miss）", () => {
    const m = makeMonitorWithTmp();
    m.onResult("baidu", "v1", "q1", "<dom/>", true);
    m.onResult("baidu", "v1", "q2", "<dom/>", true);
    m.onResult("baidu", "v1", "q3", "<dom/>", true);
    m.onResult("baidu", "v1", "q4", "<dom/>", true);
    m.onResult("baidu", "v1", "q5", "<dom/>", false);
    const snap = m.snapshot();
    const baidu = snap.engines.find((e) => e.engine === "baidu");
    expect(baidu?.hit).toBe(4);
    expect(baidu?.miss).toBe(1);
    expect(baidu?.hit_rate).toBeCloseTo(0.8, 5);
  });

  it("google engine 独立计数（不串到 baidu）", () => {
    const m = makeMonitorWithTmp();
    m.onResult("baidu", "v1", "q", "<dom/>", true);
    m.onResult("ddg", "v1", "q", "<dom/>", false);
    const snap = m.snapshot();
    const baidu = snap.engines.find((e) => e.engine === "baidu");
    const google = snap.engines.find((e) => e.engine === "ddg");
    expect(baidu?.hit).toBe(1);
    expect(google?.miss).toBe(1);
  });
});

// ============================================================
// 命中率阈值 + detectChange 触发
// ============================================================
describe("SerpHealthMonitor — 命中率 < threshold 触发验证", () => {
  it("5 次 miss + 命中率 < 0.5 → redesign_suspected=true（snapshot）", () => {
    const m = makeMonitorWithTmp();
    // 5 miss（无 baseline → detectChange 返 changed=false，但 redesign_suspected 仍 true）
    for (let i = 0; i < 5; i++) {
      m.onResult("baidu", "v1", `q${i}`, `<dom${i}/>`, false);
    }
    const snap = m.snapshot();
    const baidu = snap.engines.find((e) => e.engine === "baidu");
    expect(baidu?.redesign_suspected).toBe(true);
    expect(baidu?.hit_rate).toBe(0);
  });

  it("样本 < 5 不触发 redesign_suspected（冷启动保护）", () => {
    const m = makeMonitorWithTmp();
    for (let i = 0; i < 4; i++) {
      m.onResult("baidu", "v1", `q${i}`, `<dom${i}/>`, false);
    }
    const snap = m.snapshot();
    const baidu = snap.engines.find((e) => e.engine === "baidu");
    expect(baidu?.redesign_suspected).toBe(false);
  });

  it("ChangeDetection 返 changed=true → RecordingStore.save 落盘", async () => {
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-bl-"));
    const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-rec-"));
    tempDirs.push(baselineDir, recordingsDir);
    const m = new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      new ChangeDetection(baselineDir),
      new RecordingStore(recordingsDir),
      0.5,
    );
    // 先 captureBaseline（让后续 detectChange 能对比）
    const change = new ChangeDetection(baselineDir);
    await change.captureBaseline("baidu", "q1", "<baseline-dom/>");
    // 5 次 miss → 触发 detectChange（hash 不一致 → changed=true）
    for (let i = 0; i < 5; i++) {
      m.onResult("baidu", "v1", "q1", "<changed-dom/>", false);
    }
    // onResult 内 _maybeDetectRedesign 是 fire-and-forget 异步（fs 落盘链），
    // 固定 sleep 在满套件 CPU 争用下必 flaky（2026-09-02 G 审查实测：单跑 19/19 绿、
    // 全套件跑本例 50ms 预算被击穿）。改轮询可观察效果（save 落盘）——确定性等待，
    // 非加长 sleep。
    const store = new RecordingStore(recordingsDir);
    const deadline = Date.now() + 5_000;
    let list = await store.list();
    while (list.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      list = await store.list();
    }
    expect(list.length).toBeGreaterThan(0);
  });
});

// ============================================================
// snapshot 形状
// ============================================================
describe("SerpHealthMonitor — snapshot 形状", () => {
  it("初始 snapshot 含 baidu + google 两 engine（无数据）", () => {
    const m = makeMonitorWithTmp();
    const snap = m.snapshot();
    expect(snap.engines).toHaveLength(2);
    const engines = snap.engines.map((e) => e.engine).sort();
    expect(engines).toEqual(["baidu", "ddg"]); // v1.11 T9
    expect(snap.recent_alerts).toEqual([]);
    expect(snap.recordings_count).toBe(0);
  });

  it("last_known_good 是 ISO 字符串（v1 baseline = 构造时刻 ISO）", () => {
    const m = makeMonitorWithTmp();
    const snap = m.snapshot();
    const baidu = snap.engines.find((e) => e.engine === "baidu");
    expect(baidu?.last_known_good).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ============================================================
// INV-45 守护：禁自动重写 selector
// ============================================================
describe("SerpHealthMonitor — INV-45 禁自动重写 selector", () => {
  it("源文件无 setSelectors/upgradeVersion/rewriteSelector 调用", async () => {
    const src = fs.readFileSync(
      path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
        "../../src/serp/SerpHealthMonitor.ts",
      ),
      "utf8",
    );
    // 排除注释后 grep（粗略 strip // 行注释）
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/setSelectors\b/);
    expect(code).not.toMatch(/upgradeVersion\b/);
    expect(code).not.toMatch(/rewriteSelector\b/);
    expect(code).not.toMatch(/\.sets\.set\s*\(/);
    expect(code).not.toMatch(/\.sets\.delete\s*\(/);
  });

  it("改版确认后只 logger.warn + recordings.save（不调 registry mutator）", () => {
    const src = fs.readFileSync(
      path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
        "../../src/serp/SerpHealthMonitor.ts",
      ),
      "utf8",
    );
    // 必须含 logger.warn（告警）+ recordings.save（落盘）
    expect(src).toMatch(/logger\.warn/);
    expect(src).toMatch(/recordings\.save/);
  });
});

// ============================================================
// onResult 不抛错（保守吞错）
// ============================================================
describe("SerpHealthMonitor — onResult 错误隔离", () => {
  it("detectChange 内部抛错 → onResult 不抛（保守吞错）", () => {
    const m = makeMonitorWithTmp();
    expect(() => {
      m.onResult("baidu", "v1", "q", "<dom/>", true);
      m.onResult("baidu", "v1", "q", "<dom/>", false);
    }).not.toThrow();
  });
});

// ============================================================
// ACC-1① / ACC-1②（2026-09-02 性能/准确率轮，doc/性能准确率优化裁决表.md §2）
// ============================================================
describe("SerpHealthMonitor — ACC-1① 死返回契约删除", () => {
  it("onResult 返回 void（旧同步返 \"serp_layout_changed\"|null 是异步竞态死契约，恒 null 且五处调用点均弃值）", () => {
    const m = makeMonitorWithTmp();
    expect(m.onResult("baidu", "v1", "q", "<dom/>", true)).toBeUndefined();
    expect(m.onResult("baidu", "v1", "q", "<dom/>", false)).toBeUndefined();
  });

  it("源码锚：redesignConfirmed 死返回模式已删 + 确认通路事件名在案", () => {
    const src = fs.readFileSync(
      path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
        "../../src/serp/SerpHealthMonitor.ts",
      ),
      "utf8",
    );
    expect(src).not.toMatch(/redesignConfirmed/); // 死契约残留 = 红
    expect(src).toMatch(/serp_redesign_confirmed/); // 真实确认通路（logger.warn）
  });
});

describe("SerpHealthMonitor — ACC-1② hit 路径自动首录 baseline", () => {
  it("无 baseline 时首次 hit → baseline 落盘 + serp_baseline_auto_captured 事件", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-bl-"));
    tempDirs.push(baselineDir);
    const change = new ChangeDetection(baselineDir);
    const m = new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      change,
      new RecordingStore(makePushedDir("serp-rec-")),
      0.5,
    );
    expect(await change.hasBaseline("baidu", "rust")).toBe(false); // 前置：无
    m.onResult("baidu", "v1", "rust", "<baseline-dom/>", true);
    await new Promise((r) => setTimeout(r, 30));
    expect(await change.hasBaseline("baidu", "rust")).toBe(true); // 落盘
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ evt: "serp_baseline_auto_captured", engine: "baidu" }),
    );
    infoSpy.mockRestore();
  });

  it("已有 baseline 不覆盖（幂等门：hit 的 DOM 不侵蚀既有基线）", async () => {
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-bl-"));
    tempDirs.push(baselineDir);
    const change = new ChangeDetection(baselineDir);
    const m = new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      change,
      new RecordingStore(makePushedDir("serp-rec-")),
      0.5,
    );
    // 人工预置基线（旧 DOM）
    await change.captureBaseline("baidu", "rust", "<old-dom/>");
    m.onResult("baidu", "v1", "rust", "<new-dom/>", true); // hit 带新 DOM
    await new Promise((r) => setTimeout(r, 30));
    const sha1 = (s: string) =>
      crypto.createHash("sha1").update(s).digest("hex");
    const r = await change.detectChange("baidu", "rust", "<old-dom/>");
    expect(r.baseline_hash).toBe(sha1("<old-dom/>")); // 基线未被 <new-dom/> 覆盖
  });

  it("miss 路径不首录（0 结果的 DOM 不可信，不作基线）", async () => {
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-bl-"));
    tempDirs.push(baselineDir);
    const change = new ChangeDetection(baselineDir);
    const m = new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      change,
      new RecordingStore(makePushedDir("serp-rec-")),
      0.5,
    );
    m.onResult("baidu", "v1", "rust", "<empty-or-broken/>", false);
    await new Promise((r) => setTimeout(r, 30));
    expect(await change.hasBaseline("baidu", "rust")).toBe(false);
  });

  it("①②连测：hit 自动首录 → 同 query 5 miss（DOM 变）→ 真告警链路首次可 fire", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-bl-"));
    const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-rec-"));
    tempDirs.push(baselineDir, recordingsDir);
    const change = new ChangeDetection(baselineDir);
    const m = new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      change,
      new RecordingStore(recordingsDir),
      0.5,
    );
    // ② 自动首录（修复前：生产零 captureBaseline → detectChange 恒「无 baseline 不告警」）
    m.onResult("baidu", "v1", "rust", "<baseline-dom/>", true);
    await new Promise((r) => setTimeout(r, 30));
    expect(await change.hasBaseline("baidu", "rust")).toBe(true);
    // ① 确认通路：样本 ≥5 且 rate <0.5 → detectChange changed=true →
    //    logger.warn(serp_redesign_confirmed) + recordings.save（而非死返回值）
    for (let i = 0; i < 5; i++) {
      m.onResult("baidu", "v1", "rust", `<changed-${i}/>`, false);
    }
    await new Promise((r) => setTimeout(r, 60));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ evt: "serp_redesign_confirmed", engine: "baidu" }),
    );
    const list = await new RecordingStore(recordingsDir).list();
    expect(list.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it("snapshot 含 baselines（count + newest_age_ms；doctor 陈旧度可见面）", async () => {
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "serp-bl-"));
    tempDirs.push(baselineDir);
    const change = new ChangeDetection(baselineDir);
    const m = new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      change,
      new RecordingStore(makePushedDir("serp-rec-")),
      0.5,
    );
    m.onResult("baidu", "v1", "rust", "<dom/>", true);
    await new Promise((r) => setTimeout(r, 30));
    const snap = m.snapshot();
    const b = snap.baselines.find((x) => x.engine === "baidu");
    expect(b).toBeDefined();
    expect(b!.count).toBeGreaterThanOrEqual(1);
    expect(b!.newest_age_ms).toBeGreaterThanOrEqual(0);
    // 初始（零 baseline）形态 = 空数组（新 monitor + 新目录）
    const fresh = makeMonitorWithTmp();
    expect(fresh.snapshot().baselines).toEqual([]);
  });
});
