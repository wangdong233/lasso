/**
 * chrome-touch.spec.ts（bug02 闭环 v1.18.5 —— 外部 CDP 消费者 touch 活动信号）
 *
 * 守护 chrome-touch.ts 三出口：
 *  1. chromeTouchPath：默认 ~/.cache/lasso/chrome-touch-<port>（档案 §6 建议 3
 *     逐字约定——外部消费者 shell `touch` 的跨仓库契约，改名即破坏）+ env 覆盖
 *  2. touchChromePort：创建 + mtime 刷新（第二次 touch 后 mtime 前移）
 *  3. chromeTouchMtimeSync：读 mtime；文件不存在 → undefined（= 无外部信号）
 *
 * env 隔离（LASSO_CHROME_TOUCH_DIR → tmp）——零 ~/.cache/lasso/ 污染。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import {
  chromeTouchPath,
  touchChromePort,
  chromeTouchMtimeSync,
} from "../../src/launcher/chrome-touch.js";

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "lasso-chrome-touch-"));
  process.env.LASSO_CHROME_TOUCH_DIR = tmpDir;
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LASSO_CHROME_TOUCH_DIR;
});

describe("chrome-touch —— 外部活动信号文件（bug02 结构级修复）", () => {
  it("1. chromeTouchPath：env 隔离目录内 chrome-touch-<port>（文件名约定 = 档案 §6 逐字）", () => {
    expect(chromeTouchPath(9223)).toBe(path.join(tmpDir, "chrome-touch-9223"));
  });

  it("2. touchChromePort 创建文件 → chromeTouchMtimeSync 可读；再 touch 后 mtime 前移", async () => {
    await touchChromePort(9771);
    const p = path.join(tmpDir, "chrome-touch-9771");
    expect(existsSync(p)).toBe(true);
    const m1 = chromeTouchMtimeSync(9771);
    expect(m1).toBeGreaterThan(0);
    // mtime 分辨率兜底：等 20ms 保证可观测前移
    await new Promise((r) => setTimeout(r, 20));
    await touchChromePort(9771);
    expect(chromeTouchMtimeSync(9771)).toBeGreaterThan(m1!);
  });

  it("3. chromeTouchMtimeSync：文件不存在 → undefined（无信号 = 不影响 reaper lastUse）", () => {
    expect(chromeTouchMtimeSync(65530)).toBeUndefined();
  });

  it("4. touchChromePort best-effort：坏目录不抛（logFn 记 warn）", async () => {
    const logs: Array<Record<string, unknown>> = [];
    // /dev/null 是文件不是目录 → mkdir 失败 → warn 不抛
    const prev = process.env.LASSO_CHROME_TOUCH_DIR;
    process.env.LASSO_CHROME_TOUCH_DIR = "/dev/null/nope";
    try {
      await touchChromePort(65531, (p) => logs.push(p));
      expect(logs.some((p) => p.evt === "chrome_touch_error")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LASSO_CHROME_TOUCH_DIR;
      else process.env.LASSO_CHROME_TOUCH_DIR = prev;
    }
  });
});
