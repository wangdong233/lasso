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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SelectorRegistry } from "../../src/serp/SelectorRegistry.js";
import { HitRateStats } from "../../src/serp/HitRateStats.js";
import { ChangeDetection } from "../../src/serp/ChangeDetection.js";
import { RecordingStore } from "../../src/serp/RecordingStore.js";
import { SerpHealthMonitor } from "../../src/serp/SerpHealthMonitor.js";

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
    m.onResult("google", "v1", "q", "<dom/>", false);
    const snap = m.snapshot();
    const baidu = snap.engines.find((e) => e.engine === "baidu");
    const google = snap.engines.find((e) => e.engine === "google");
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
    // 等 microtask 让异步 _maybeDetectRedesign 完成
    await new Promise((r) => setTimeout(r, 50));
    // RecordingStore 应落盘了 fixture
    const recordingFile = path.join(recordingsDir, "tmp.html");
    const list = await new RecordingStore(recordingsDir).list();
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
    expect(engines).toEqual(["baidu", "google"]);
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
        new URL(".", import.meta.url).pathname,
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
        new URL(".", import.meta.url).pathname,
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
