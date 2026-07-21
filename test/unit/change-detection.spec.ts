/**
 * ChangeDetection 单元测（parse2 §5.1 / §3.5.2）。
 *
 * 覆盖：
 *  - baseline 写入：captureBaseline 返回 snapshot + 落盘 + 文件路径分片
 *  - detectChange：无 baseline → changed=false（不告警）
 *  - detectChange：与 baseline 一致 → changed=false
 *  - detectChange：与 baseline 不一致 → changed=true + 两个 hash
 *  - captureBaseline 二次写 → 覆盖（v0.2 简化）
 *  - 损坏 JSON → changed=false（不抛错）
 *  - sha1 hash 稳定（相同 dom 出相同 hash）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ChangeDetection } from "../../src/serp/ChangeDetection.js";

// ============================================================
// fixture
// ============================================================
const DOM_A = `<html><body><div class="c-container">a</div></body></html>`;
const DOM_B = `<html><body><div class="c-container">b</div></body></html>`;

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// ============================================================
// setup
// ============================================================
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lasso-changedet-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// ============================================================
// cases
// ============================================================
describe("ChangeDetection — captureBaseline", () => {
  it("captureBaseline 返回 snapshot 含 dom_hash + epoch ms", async () => {
    const cd = new ChangeDetection(dir);
    const snap = await cd.captureBaseline("baidu", "rust", DOM_A);
    expect(snap.engine).toBe("baidu");
    expect(snap.query).toBe("rust");
    expect(snap.dom_hash).toBe(sha1(DOM_A));
    expect(typeof snap.captured_at).toBe("number");
    expect(snap.captured_at).toBeLessThanOrEqual(Date.now());
  });

  it("captureBaseline 落盘到分片目录 <sha1[0:2]>/<full>.json", async () => {
    const cd = new ChangeDetection(dir);
    const snap = await cd.captureBaseline("baidu", "rust", DOM_A);
    const expectedHash = sha1("baidu|rust");
    const expectedPath = path.join(dir, expectedHash.slice(0, 2), `${expectedHash}.json`);
    const raw = await fs.readFile(expectedPath, "utf8");
    expect(JSON.parse(raw).dom_hash).toBe(snap.dom_hash);
  });

  it("baselinePath 暴露落盘路径（测试用）", () => {
    const cd = new ChangeDetection(dir);
    const p = cd.baselinePath("baidu", "rust");
    const expectedHash = sha1("baidu|rust");
    expect(p).toBe(path.join(dir, expectedHash.slice(0, 2), `${expectedHash}.json`));
  });
});

describe("ChangeDetection — detectChange", () => {
  it("无 baseline（首次）→ changed=false + 无 baseline_hash + 含 current_hash", async () => {
    const cd = new ChangeDetection(dir);
    const r = await cd.detectChange("baidu", "rust", DOM_A);
    expect(r.changed).toBe(false);
    expect(r.baseline_hash).toBeUndefined();
    expect(r.current_hash).toBe(sha1(DOM_A));
  });

  it("与 baseline 一致 → changed=false + 同时报 baseline_hash + current_hash", async () => {
    const cd = new ChangeDetection(dir);
    await cd.captureBaseline("baidu", "rust", DOM_A);
    const r = await cd.detectChange("baidu", "rust", DOM_A);
    expect(r.changed).toBe(false);
    expect(r.baseline_hash).toBe(sha1(DOM_A));
    expect(r.current_hash).toBe(sha1(DOM_A));
  });

  it("与 baseline 不一致 → changed=true + baseline_hash ≠ current_hash", async () => {
    const cd = new ChangeDetection(dir);
    await cd.captureBaseline("baidu", "rust", DOM_A);
    const r = await cd.detectChange("baidu", "rust", DOM_B);
    expect(r.changed).toBe(true);
    expect(r.baseline_hash).toBe(sha1(DOM_A));
    expect(r.current_hash).toBe(sha1(DOM_B));
  });

  it("engine 维度独立：baidu 与 google baseline 互不干扰", async () => {
    const cd = new ChangeDetection(dir);
    await cd.captureBaseline("baidu", "rust", DOM_A);
    // google 同 query 不应命中 baidu 的 baseline
    const r = await cd.detectChange("google", "rust", DOM_A);
    expect(r.changed).toBe(false); // 无 baseline，不告警
    expect(r.baseline_hash).toBeUndefined();
  });

  it("captureBaseline 二次写 = 覆盖（新 dom_hash 生效）", async () => {
    const cd = new ChangeDetection(dir);
    await cd.captureBaseline("baidu", "rust", DOM_A);
    await cd.captureBaseline("baidu", "rust", DOM_B);
    // 用 DOM_A 比对应该 changed=true（baseline 已是 DOM_B）
    const r = await cd.detectChange("baidu", "rust", DOM_A);
    expect(r.changed).toBe(true);
    expect(r.baseline_hash).toBe(sha1(DOM_B));
  });
});

describe("ChangeDetection — 健壮性", () => {
  it("baseline 文件存在但 JSON 损坏 → changed=false（不抛错）", async () => {
    const cd = new ChangeDetection(dir);
    const corruptFile = cd.baselinePath("baidu", "rust");
    await fs.mkdir(path.dirname(corruptFile), { recursive: true });
    writeFileSync(corruptFile, "not-json-{{{");
    const r = await cd.detectChange("baidu", "rust", DOM_A);
    expect(r.changed).toBe(false);
    expect(r.current_hash).toBe(sha1(DOM_A));
  });

  it("baselineDir 不存在时 captureBaseline 自动 mkdir（recursive）", async () => {
    const nested = path.join(dir, "a", "b", "c");
    const cd = new ChangeDetection(nested);
    const snap = await cd.captureBaseline("baidu", "rust", DOM_A);
    expect(snap.dom_hash).toBe(sha1(DOM_A));
    // 文件真实存在
    await fs.stat(cd.baselinePath("baidu", "rust"));
  });
});
