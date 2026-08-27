/**
 * P1（v1.17.3，得到实战根因）回归测试：
 * visible 档 Chrome 是用户拥有的窗口——停机收尾（modes 过滤）与 idle reaper
 * 都无权关闭它；关闭出口只有显式 chrome-stop。
 *
 * 根因现场：用户在 visible Chrome 里完成得到登录 → 后续短命 server 进程
 * （工作流 agent 的 MCP 脚本）退出时停机钩子 stopLaunchedChromes({all:true})
 * 把台账 Chrome 全关——用户登录窗口被砸（台账清空 + 进程归零实证）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 台账隔离（review-03 F-1 修复）：P3 的 launchChrome 注入测试会经 recordLaunch
// 写磁盘台账——此前无 LASSO_LAUNCHED_CHROMES_PATH 覆盖，全量套跑一次就往真实
// ~/.cache/lasso/launched-chromes.json 落一条陈旧 entry（实测 pid 42 污染）。
// bug02（v1.18.5）同款横扫：ok 路径还会自 touch chrome-touch-<port>（真实
// ~/.cache/lasso/chrome-touch-9222 污染——曾反噬 chrome-autohide spec 的无注入
// reaper，flaky）+ hidden fuse 写 desired-hidden 粘滞账——三 env 一并隔离。
let __tmpDir: string;

beforeEach(async () => {
  __tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lasso-p1-lifecycle-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(__tmpDir, "launched-chromes.json");
  process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(__tmpDir, "desired-hidden.json");
  process.env.LASSO_CHROME_TOUCH_DIR = __tmpDir;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_DESIRED_HIDDEN_PATH;
  delete process.env.LASSO_CHROME_TOUCH_DIR;
  await fs.promises.rm(__tmpDir, { recursive: true, force: true });
});

describe("P1 visible Chrome 生命周期保护", () => {
  it("chrome-stop：modes:['hidden'] 过滤后 visible 记录不被选中（白盒：过滤逻辑存在且按 launchMode）", async () => {
    const src = readFileSync("src/launcher/chrome-stop.ts", "utf8");
    // 过滤实现存在：targets 按 opts.modes 与 launchMode（缺省按 hidden）过滤
    expect(src).toMatch(/opts\.modes[\s\S]{0,200}launchMode \?\? "hidden"/);
    // 接口暴露 modes 选项
    expect(src).toMatch(/modes\?: Array<"hidden" \| "visible">/);
  });

  it("index.ts 停机收尾只关 hidden（P1 修复锚点）", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toMatch(/stopLaunchedChromes\(\{ all: true, modes: \["hidden"\]/);
  });

  it("idle reaper：visible 记录直接 continue（永不 idle 收割；C2 autoHide 分支也在 continue 之前，不进 kill 路径）", () => {
    const src = readFileSync("src/launcher/chrome-idle-reaper.ts", "utf8");
    // v1.18 C2 后形态：visible 分支是块体（autoHide 可选步 + continue），
    // continue 仍先于任何 stopFn 调用（kill 豁免语义不变）
    const m = src.match(/launchMode === "visible"\) \{[\s\S]{0,400}?continue;/);
    expect(m).not.toBeNull();
  });

  it("行为验证：modes 过滤路径可安全执行（空台账 no-op 不炸）", async () => {
    const { stopLaunchedChromes } = await import("../../src/launcher/chrome-stop.js");
    const r = await stopLaunchedChromes({
      all: true,
      modes: ["hidden"],
      aliveFn: () => true,
      psFn: () => "/Applications/Google Chrome --user-data-dir=/x --remote-debugging-port=9222",
      killTreeFn: () => {},
      sleepFn: async () => {},
    });
    expect(Array.isArray(r.stopped)).toBe(true);
  });
});

describe("P3 端口被非 CDP 进程占用（tcpProbeFn）", () => {
  it("预检非 ok + TCP 可连 → port_in_use_non_cdp 拒绝（不 spawn）", async () => {
    const { launchChrome } = await import("../../src/launcher/launch-chrome.js");
    let spawnCalled = false;
    const r = await launchChrome({
      platform: "mac",
      probeExists: async () => true,
      spawnFn: (() => { spawnCalled = true; return { unref(){}, on(){}, pid: 1 } as never; }) as never,
      fetchFn: async () => ({ ok: false }),
      tcpProbeFn: async () => true,
      probeIntervalMs: 1,
      defaultProfileDir: "/tmp/x",
      fuseDelayMs: 1,
      hideFn: () => ({ ok: true }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/port_in_use_non_cdp/);
    expect(spawnCalled).toBe(false);
  });

  it("TCP 不可连（真空闲）→ 照常 spawn（缺省不探测路径兼容）", async () => {
    const { launchChrome } = await import("../../src/launcher/launch-chrome.js");
    let spawnCalled = false;
    let call = 0;
    const r = await launchChrome({
      platform: "mac",
      probeExists: async () => true,
      spawnFn: (() => { spawnCalled = true; return { unref(){}, on(){}, pid: 42 } as never; }) as never,
      // 第 1 次（预检）非 ok；后续（探活）ok——与 makeMockFetch 同语义
      fetchFn: async () => ({ ok: ++call > 1 }),
      tcpProbeFn: async () => false,
      probeIntervalMs: 1,
      defaultProfileDir: "/tmp/x",
      fuseDelayMs: 1,
      hideFn: () => ({ ok: true }),
    });
    expect(spawnCalled).toBe(true);
    expect(r.ok).toBe(true);
  });
});
