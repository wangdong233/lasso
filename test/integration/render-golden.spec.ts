/**
 * render-golden.spec.ts（v1.19 渲染档设计决议 §8.2 步 5 / R6 —— golden 确定性回归）
 *
 * 需求 §三.2 不可让步项的 lasso 侧自测：**同一 SVG 经渲染档 attach 渲染两次 →
 * PNG byte-identical**。实施路径照对接说明 §一.5 attach 契约：
 *  `launchRenderChrome`（真实 spawn：冻结旗标快照 + 临时 profile + 测试端口）
 *  → `puppeteer.connect({ browserWSEndpoint })`（🔴 browserWSEndpoint——CDP 字段名
 *    webSocketDebuggerUrl 不是 connect 选项名，2026-09-02 勘误）
 *  → 每渲染会话独立 page + setViewport（多会话互不污染）→ screenshot PNG
 *  → 归还 = `browser.disconnect()`，严禁 close()（close 会向共享档下发 Browser.close
 *    直接杀掉渲染档——对接说明 §一.5 close 陷阱；本测试 disconnect 后断言渲染档
 *    仍健康 = 从 lasso 侧钉死该契约）。
 *
 * puppeteer-core 为 **devDependency（25.3.0 与消费方同版）**：只在测试面出现，
 * src/render 零 npm dep（INV-64 裁决二「冻结快照非运行时依赖」不受影响——
 * INV-64 只扫 src/launcher|render 两目录）。
 *
 * 门控（设计 §8.2：lasso CI 不赌 Chrome）：chrome-paths 候选表探测失败（CI
 * ubuntu runner 无 Chrome）→ 整组 skip；本地 / mac 有 Chrome 真跑。台账/touch/
 * profile/lock 全 tmp 隔离（env + opts 注入），端口取临时监听探测的空闲口——
 * 不碰默认 9224 与真实 ~/.cache/lasso（真机 9224 全链验收 = 验收脚本
 * test/render-tier-acceptance.mjs，设计 §8.2 映射表）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, rmSync, mkdtempSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as Net from "node:net";
import process from "node:process";
import { chromeCandidatesForPlatform } from "../../src/launcher/chrome-paths.js";
import { readLedgerSync } from "../../src/launcher/chrome-ledger.js";
import { stopLaunchedChromes } from "../../src/launcher/chrome-stop.js";
import { launchRenderChrome, probeRenderHealth } from "../../src/render/render-launcher.js";
import { RENDER_PROFILE_PREFIX } from "../../src/render/render-flags.js";

// ============================================================
// 门控：Chrome 二进制存在（chrome-paths 单一真源；CI ubuntu 无 Chrome → skip）
// ============================================================
function findChromeBinary(): string | null {
  for (const c of chromeCandidatesForPlatform()) {
    try {
      accessSync(c.path, fsConstants.X_OK);
      return c.path;
    } catch {
      /* 下一候选 */
    }
  }
  return null;
}
const CHROME_BIN = findChromeBinary();

/** 临时监听探测一个空闲 TCP 口（不占用默认 9224 与真实消费端口）。 */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = Net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// ============================================================
// 测试用 SVG（确定性面：形状 + 渐变 + 文本——文本让 --font-render-hinting /
// --force-color-profile / --disable-gpu 等确定性旗标真实参与渲染，变异即红）
// ============================================================
const SVG_W = 256;
const SVG_H = 128;
const svgPage = (label: string, hue: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="hsl(${hue},80%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,35%)"/>` +
  `</linearGradient></defs>` +
  `<rect width="${SVG_W}" height="${SVG_H}" fill="url(#g)"/>` +
  `<circle cx="${SVG_W / 2}" cy="${SVG_H / 2}" r="34" fill="none" stroke="#ffffff" stroke-width="5"/>` +
  `<text x="12" y="24" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#ffffff">${label}</text>` +
  `<text x="12" y="${SVG_H - 12}" font-family="Menlo, monospace" font-size="12" fill="#eaffea">golden ${hue}</text>` +
  `</svg>`;

const htmlDoc = (svg: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body>${svg}</body></html>`;

// ============================================================
// 门控后的主体
// ============================================================
const describeOrSkip = CHROME_BIN ? describe : describe.skip;

describeOrSkip("R6 golden —— 渲染档 attach 双渲 byte-identical（真 Chrome）", () => {
  let tmpDir: string;
  let port = 0;
  let profileDir: string | undefined;
  let puppeteer: typeof import("puppeteer-core");
  let browser: import("puppeteer-core").Browser;

  beforeAll(
    async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "lasso-render-golden-"));
      process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "launched-chromes.json");
      process.env.LASSO_CHROME_TOUCH_DIR = path.join(tmpDir, "touch");
      delete process.env.LASSO_RENDER_PORT;
      delete process.env.LASSO_RENDER_IDLE_MS;
      port = await pickFreePort();

      // ensure 引擎（真实 spawn / 真实 CDP 探活；guardian 注入 no-op——本测试不验收割，
      // 收割链由 render-guardian-process.spec 与验收脚本钉死）
      const r = await launchRenderChrome({
        port,
        profileBaseDir: path.join(tmpDir, "profiles"),
        lockDir: path.join(tmpDir, "locks"),
        ensureGuardianFn: async () => {},
        launchTimeoutMs: 30_000,
        logFn: () => {},
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(`ensure 失败 exit=${r.exitCode} ${r.error}`);
      expect(r.reused).toBe(false);
      profileDir = r.profileDir;

      // 消费方 attach 契约（§一.5）：browserWSEndpoint + defaultViewport:null
      puppeteer = await import("puppeteer-core");
      browser = await puppeteer.connect({
        browserWSEndpoint: r.wsEndpoint,
        defaultViewport: null,
      });
    },
    60_000,
  );

  /** 单次渲染会话：独立 page + setViewport + setContent + fonts.ready → PNG bytes。 */
  async function renderOnce(svg: string): Promise<Buffer> {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: SVG_W, height: SVG_H, deviceScaleFactor: 1 });
      await page.setContent(htmlDoc(svg), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      return Buffer.from(await page.screenshot({ type: "png" }));
    } finally {
      await page.close();
    }
  }

  it(
    "同一 SVG 两次渲染（独立 page）→ PNG byte-identical",
    async () => {
      const a = await renderOnce(svgPage("R6 golden A", 210));
      const b = await renderOnce(svgPage("R6 golden A", 210));
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBe(a.length);
      expect(Buffer.compare(a, b)).toBe(0);
    },
    30_000,
  );

  it(
    "内容敏感性守卫：不同 SVG → 字节不同（防「恒同像素」假通过）",
    async () => {
      const a = await renderOnce(svgPage("R6 golden A", 210));
      const c = await renderOnce(svgPage("R6 golden B", 40));
      expect(Buffer.compare(a, c)).not.toBe(0);
    },
    30_000,
  );

  it(
    "归还 = disconnect（非 close）：断开后共享渲染档仍健康（§一.5 close 陷阱锚）",
    async () => {
      await browser.disconnect();
      // 事件传播 + CDP 服务恢复的短暂窗口
      await new Promise((r) => setTimeout(r, 300));
      const health = await probeRenderHealth(port);
      expect(health.ok).toBe(true);
      expect(health.wsEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    },
    15_000,
  );

  afterAll(
    async () => {
      try {
        if (browser?.connected) await browser.disconnect();
      } catch {
        /* best-effort */
      }
      try {
        // 收割走 chrome-stop 验证路径（归属验证 + 树杀 + 删账 + render profile 连带清理）
        if (port > 0) {
          const stopped = await stopLaunchedChromes({
            port,
            modes: ["render"],
            logFn: () => {},
          });
          // killed（正常收割）或 already_dead（异常提前退）都算清场完成
          expect(stopped.stopped.length).toBe(1);
          expect(readLedgerSync().filter((r) => r.port === port)).toHaveLength(0);
        }
        // profile 连带清理（设计 3.4）：收割后目录已删
        if (profileDir) {
          expect(path.basename(profileDir).startsWith(RENDER_PROFILE_PREFIX)).toBe(true);
          let exists = true;
          try {
            accessSync(profileDir);
          } catch {
            exists = false;
          }
          expect(exists).toBe(false);
        }
        // 真机实验的 Chrome 用后清理：本实例指纹归零（主进程 + helper 都带
        // --user-data-dir=<tmpDir> argv——按 tmp 前缀圈定，免受并行会话误伤）
        const ps = spawnSync("ps", ["-Axo", "command="], { encoding: "utf8" });
        const fp = (ps.stdout ?? "")
          .split("\n")
          .filter((l) => l.includes("--run-all-compositor-stages-before-draw") && l.includes(tmpDir));
        expect(fp.length).toBe(0);
      } finally {
        delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
        delete process.env.LASSO_CHROME_TOUCH_DIR;
        if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
