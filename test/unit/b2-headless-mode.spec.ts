/**
 * b2-headless-mode.spec.ts（BUG-03 决议 B2，doc/bugs/03 §4 B2）
 *
 * headless 可选档（`launch-chrome --mode headless`）：零窗口/零 AX 面的纯抓取
 * 形态。**对抗复审 r1（2026-09-08）真机证伪订正**：B2 原始声明「headless 不注册
 * Foreground LS session、结构性不占 Dock 槽位」在 macOS 真机不成立——仅有
 * headless 实例在世时 `open -a "Google Chrome"` 不另起新实例，激活被同 bundle id
 * 单实例槽位吸收且零可见反馈（症状②的无窗变体）；有人用的机器仍应 hidden
 * （+B1 让位门）。代价 = 无法 chrome-show（登录交互流破碎），故不切默认。
 *
 * 覆盖：
 *  1. parseLaunchChromeArgs 接受 --mode headless（CLI 显式可选）
 *  2. flags 含 --headless=new（render 档冻结快照经验，不 import render 守 INV-64）
 *  3. 无隐藏保险丝 / 无粘滞账 / 无执守拉起（无窗口形态零 AX 面）
 *  4. 台账 launchMode "headless" 写读往返 + readLedgerSync 守卫
 *  5. chrome-stop --modes headless 可单收；--modes hidden 精确匹配不动 headless
 *  6. config 层不扩（LASSO_LAUNCH_MODE 仍 hidden|visible——防误配切默认）
 *  7. mac 平台 headless 拉起打 headless_dock_slot_caveat 观测点（r1 订正锚）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchChrome, parseLaunchChromeArgs } from "../../src/launcher/launch-chrome.js";
import { recordLaunch, readLedgerSync } from "../../src/launcher/chrome-ledger.js";
import { stopLaunchedChromes, parseChromeStopArgs } from "../../src/launcher/chrome-stop.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-b2-headless-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "launched-chromes.json");
  process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(tmpDir, "desired-hidden.json");
  process.env.LASSO_CHROME_TOUCH_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_DESIRED_HIDDEN_PATH;
  delete process.env.LASSO_CHROME_TOUCH_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("B2 · launch-chrome headless 可选档", () => {
  it("1. --mode headless 解析（CLI 显式可选；非法值仍忽略）", () => {
    expect(parseLaunchChromeArgs(["--mode", "headless"]).launchMode).toBe("headless");
    expect(parseLaunchChromeArgs(["--mode", "hidden"]).launchMode).toBe("hidden");
    expect(parseLaunchChromeArgs(["--mode", "bogus"]).launchMode).toBeUndefined();
  });
});

// ============================================================
// 独立用例（探活序列注入形态）
// ============================================================
describe("B2 · headless 行为面（探活序列注入）", () => {
  function okAfterPre() {
    let n = 0;
    return async () => ({ ok: ++n >= 2 });
  }

  it("2b. flags 含 --headless=new 且不含 --no-startup-window（headless≠hidden）", async () => {
    const spawned: string[][] = [];
    const r = await launchChrome({
      platform: "mac",
      launchMode: "headless",
      probeExists: async () => true,
      spawnFn: ((_cmd: string, args: string[]) => {
        spawned.push(args);
        return { unref() {}, on() {}, pid: 77112 } as never;
      }) as never,
      fetchFn: okAfterPre(),
      probeIntervalMs: 1,
      probeAttempts: 2,
      defaultProfileDir: "/tmp/b2-profile",
      hideFn: () => ({ ok: true }),
      ensureEnforcerFn: async () => {},
    });
    expect(r.ok).toBe(true);
    expect(spawned[0]).toContain("--headless=new");
    expect(spawned[0]).not.toContain("--no-startup-window");
    expect(spawned[0]).toContain("--mute-audio"); // 恒加三件套+静音不变
  });

  it("2c. 零 AX 面：hideFn / ensureEnforcerFn 零调用；粘滞账零写", async () => {
    let hideCalls = 0;
    let enforcerCalls = 0;
    const r = await launchChrome({
      platform: "mac",
      launchMode: "headless",
      probeExists: async () => true,
      spawnFn: (() => ({ unref() {}, on() {}, pid: 77113 })) as never,
      fetchFn: okAfterPre(),
      probeIntervalMs: 1,
      probeAttempts: 2,
      defaultProfileDir: "/tmp/b2-profile",
      hideFn: () => {
        hideCalls++;
        return { ok: true };
      },
      ensureEnforcerFn: async () => {
        enforcerCalls++;
      },
    });
    expect(r.ok).toBe(true);
    expect(hideCalls).toBe(0); // 无窗口 → 无隐藏保险丝
    expect(enforcerCalls).toBe(0); // 无粘滞账 → 无执守
    // 粘滞账零写：文件从未写入（readFileSync ENOENT 抛在 lambda 内）
    expect(() =>
      readFileSync(process.env.LASSO_DESIRED_HIDDEN_PATH!, "utf8"),
    ).toThrow();
    // 台账记 headless
    const ledger = readLedgerSync();
    expect(ledger.find((x) => x.port === 9222)?.launchMode).toBe("headless");
  });

  it("2d. mac 平台 headless 拉起打 headless_dock_slot_caveat（r1 真机证伪订正锚）；hidden 档不打", async () => {
    const events: Array<Record<string, unknown>> = [];
    const logFn = (p: Record<string, unknown>) => events.push(p);
    const mkBase = (pid: number) => ({
      platform: "mac" as const,
      probeExists: async () => true,
      spawnFn: (() => ({ unref() {}, on() {}, pid })) as never,
      // 每次拉起独立 fetchFn 序列（首探不 ok → spawn 后 ok；复用会把第二次
      // 预探判成 port_in_use）
      fetchFn: (() => {
        let n = 0;
        return async () => ({ ok: ++n >= 2 });
      })(),
      probeIntervalMs: 1,
      probeAttempts: 2,
      defaultProfileDir: "/tmp/b2-profile",
      hideFn: () => ({ ok: true }),
      ensureEnforcerFn: async () => {},
      logFn,
    });
    const rHeadless = await launchChrome({ ...mkBase(77114), launchMode: "headless" });
    expect(rHeadless.ok).toBe(true);
    expect(events.some((e) => e.evt === "headless_dock_slot_caveat")).toBe(true);
    events.length = 0;
    const rHidden = await launchChrome({ ...mkBase(77115), launchMode: "hidden" });
    expect(rHidden.ok).toBe(true);
    expect(events.some((e) => e.evt === "headless_dock_slot_caveat")).toBe(false);
  });
});

// ============================================================
// 台账/停机面
// ============================================================
describe("B2 · headless 台账与 chrome-stop", () => {
  it("3. launchMode 'headless' 写读往返（readLedgerSync 守卫第四值）", async () => {
    await recordLaunch({
      port: 9222,
      pid: 77201,
      profileDir: "/tmp/b2-ledger",
      launchedAt: 1,
      status: "ready",
      launchMode: "headless",
    });
    expect(readLedgerSync()[0]!.launchMode).toBe("headless");
  });

  it("4. chrome-stop --modes headless 单收；--modes hidden 精确匹配不动 headless", async () => {
    await recordLaunch({
      port: 9222,
      pid: 77202,
      profileDir: "/tmp/b2-ledger",
      launchedAt: 1,
      status: "ready",
      launchMode: "hidden",
    });
    await recordLaunch({
      port: 9223,
      pid: 77203,
      profileDir: "/tmp/b2-ledger2",
      launchedAt: 1,
      status: "ready",
      launchMode: "headless",
    });
    const psOf = (pid: number) =>
      `/Applications/Google Chrome --user-data-dir=/tmp/b2-ledger${pid === 77203 ? "2" : ""} --remote-debugging-port=${pid === 77202 ? 9222 : 9223}\n`;
    // --modes hidden 不动 headless（精确匹配语义，与 render 同款）
    const r1 = await stopLaunchedChromes({
      modes: ["hidden"],
      aliveFn: () => true,
      psFn: psOf,
      killTreeFn: () => {},
      sleepFn: async () => {},
    });
    expect(r1.stopped.map((s) => s.port)).toEqual([9222]);
    // --modes headless 单收
    const r2 = await stopLaunchedChromes({
      modes: ["headless"],
      aliveFn: () => true,
      psFn: psOf,
      killTreeFn: () => {},
      sleepFn: async () => {},
    });
    expect(r2.stopped.map((s) => s.port)).toEqual([9223]);
  });

  it("5. parseChromeStopArgs 接受 headless（CLI 值域）", () => {
    expect(parseChromeStopArgs(["--modes", "headless"]).modes).toEqual(["headless"]);
    expect(() => parseChromeStopArgs(["--modes", "bogus"])).toThrow();
  });

  it("6. config 层不扩：parseLaunchMode 值域仍 hidden|visible（防误配把登录工作流切无头）", () => {
    const src = readFileSync("src/config/config.ts", "utf8");
    const m = src.match(/function parseLaunchMode[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/headless/);
    expect(m![0]).toMatch(/hidden/);
  });
});

