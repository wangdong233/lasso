/**
 * launch-chrome.spec.ts（parse11 §3.3 + §7.2 Phase D v1.0 跨平台 launcher）
 *
 * 守护 launchChrome + chrome-paths 的：
 *  1. chromeCandidatesForPlatform() 三平台返候选列表（mac/linux/win 各自路径表）
 *  2. launchChrome() 顺序 probe → 找到 → spawn（mock probeExists + spawnFn）
 *  3. launchChrome() 全候选不存在 → ok=false + error="chrome_not_found"
 *  4. launchChrome() unsupported platform → ok=false + error="unsupported_platform"
 *  5. launchChrome() spawn 抛错 → ok=false + error=String(e)
 *  6. parseLaunchChromeArgs() --port / --profile / --incognito / --extra-args 解析
 *  7. INV-64 衍生：launcher/*.ts 不引新 npm dep（grep 由 INV-64 守；本 spec 验
 *     chrome-paths + launch-chrome 互引合规 + 阈值常量稳定）
 *  8. #5（v1.18.7 审查 P2）：runLaunchChromeCli --help/-h 短路——不 spawn +
 *     打印注入的 usage + exit 0（DI 注入 spawnFn 零真实启动）
 *
 * macOS-only 现实红线（parse11 §1.3）：本 spec 用 mock probeExists + spawnFn；
 * 不真 spawn Chrome；Win/Linux 路径仅静态验 shape，真机 spawn 手测 #W7/#L7 pending。
 *
 * 测试策略（守 R-CI-02）：
 *  - probeExists 注入：mock fs.access → false/true 控制路径探测结果
 *  - spawnFn 注入：mock child_process.spawn → 返伪 ChildProcess（不真启子进程）
 *  - 不引入 puppeteer / open / chrome-launcher 等社区包（INV-64 守）
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import {
  launchChrome,
  parseLaunchChromeArgs,
  mergeLaunchDefaults,
  runLaunchChromeCli,
  fileUrlToPathSafe,
} from "../../src/launcher/launch-chrome.js";
import {
  chromeCandidatesForPlatform,
  MACOS_CHROME_CANDIDATES,
  LINUX_CHROME_CANDIDATES,
  windowsChromeCandidates,
} from "../../src/launcher/chrome-paths.js";
import type { ChildProcess } from "node:child_process";

// ============================================================
// helper：mock probeExists / spawnFn / fetchFn
// ============================================================
/**
 * 创建 mock spawnFn：返伪 ChildProcess，记录调用 args 便于断言。
 * W1-DEF-7 后 launchChrome 会调 child.on("exit") + child.unref()，
 * 伪 ChildProcess 需带 on（可注入立即触发 exit 模拟子进程早退）。
 */
function makeMockSpawn(
  pid: number = 12345,
  exitMode: "alive" | "immediate-exit" = "alive",
): {
  spawnFn: (
    cmd: string,
    args: string[],
    opts: { detached: boolean; stdio: "ignore" | "pipe" },
  ) => ChildProcess;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn = (
    cmd: string,
    args: string[],
  ): ChildProcess => {
    calls.push({ cmd, args });
    // 返最小伪 ChildProcess（launchChrome 用 .pid + .on("exit") + .unref()）
    const fake = {
      pid,
      exitCode: null as number | null,
      unref: () => {},
      on: (event: string, fn: () => void) => {
        if (event === "exit" && exitMode === "immediate-exit") {
          // 模拟 spawn 后立即退出（默认 profile 单例转发场景）
          setImmediate(fn);
        }
      },
    };
    return fake as unknown as ChildProcess;
  };
  return { spawnFn, calls };
}

/** 创建 mock probeExists：按给定路径集合判定 true/false。 */
function makeMockProbe(existingPaths: Set<string>) {
  return async (p: string): Promise<boolean> => existingPaths.has(p);
}

/**
 * 创建 mock 探活 fetch（W1-DEF-7 契约）：
 *  - 第 1 次调用 = 端口占用预检（spawn 前）→ preCheckOk
 *  - 后续调用 = spawn 后探活轮询 → probeOk
 * 记录全部 URL 供断言。
 */
function makeMockFetch(
  behavior: { preCheckOk?: boolean; probeOk?: boolean } = {},
): {
  fetchFn: (url: string) => Promise<{ ok: boolean }>;
  urls: string[];
} {
  const urls: string[] = [];
  let callCount = 0;
  const fetchFn = async (url: string): Promise<{ ok: boolean }> => {
    callCount++;
    urls.push(url);
    const isFirst = callCount === 1;
    const ok = isFirst ? (behavior.preCheckOk ?? false) : (behavior.probeOk ?? true);
    return { ok };
  };
  return { fetchFn, urls };
}

/** 成功路径通用注入（W1-DEF-7 后探活必须 mock；预检空闲 + 首轮探活通过）。 */
const FAST_PROBE = {
  probeIntervalMs: 1,
  defaultProfileDir: "/tmp/lasso-chrome-profile-default-test",
  // bug02（v1.18.5）：隐藏全生命周期测试注入——fuse 成功后不真 spawn 独立执守进程
  //（粘滞账写盘走 env LASSO_DESIRED_HIDDEN_PATH 隔离，见 beforeAll）
  ensureEnforcerFn: async () => {},
} as const;

/** makeMockFetch 的 spread 包装（只透出 fetchFn，不带 urls 数组）。 */
function makeMockFetchSafe(): { fetchFn: (url: string) => Promise<{ ok: boolean }> } {
  const { fetchFn } = makeMockFetch();
  return { fetchFn };
}

// ============================================================
// v1.9 台账隔离：launchChrome spawn 成功/慢启动会写 launched-chromes.json 台账。
// 本 spec 的 mock spawn 返伪 pid —— 必须把台账指到 tmp（不污染 ~/.cache/lasso/）。
// bug02（v1.18.5）：hidden 档出生写 desired-hidden 粘滞账 + chrome-touch 信号文件
// ——同款 env 隔离（LASSO_DESIRED_HIDDEN_PATH / LASSO_CHROME_TOUCH_DIR）。
// ============================================================
let ledgerTmpDir: string;
let desiredTmpDir: string;
let touchTmpDir: string;
beforeAll(() => {
  ledgerTmpDir = mkdtempSync(path.join(os.tmpdir(), "lasso-launch-chrome-ledger-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(ledgerTmpDir, "launched-chromes.json");
  desiredTmpDir = mkdtempSync(path.join(os.tmpdir(), "lasso-launch-chrome-desired-"));
  process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(desiredTmpDir, "desired-hidden.json");
  touchTmpDir = mkdtempSync(path.join(os.tmpdir(), "lasso-launch-chrome-touch-"));
  process.env.LASSO_CHROME_TOUCH_DIR = touchTmpDir;
});
afterAll(() => {
  rmSync(ledgerTmpDir, { recursive: true, force: true });
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  rmSync(desiredTmpDir, { recursive: true, force: true });
  delete process.env.LASSO_DESIRED_HIDDEN_PATH;
  rmSync(touchTmpDir, { recursive: true, force: true });
  delete process.env.LASSO_CHROME_TOUCH_DIR;
});

// ============================================================
// chromeCandidatesForPlatform —— 三平台候选路径表
// ============================================================
describe("chromeCandidatesForPlatform —— 三平台候选路径表", () => {
  it("mac → MACOS_CHROME_CANDIDATES（默认装位优先）", () => {
    const cs = chromeCandidatesForPlatform({ platform: "mac" });
    expect(cs.length).toBeGreaterThanOrEqual(1);
    // 第一条必须是默认 /Applications/Google Chrome.app
    expect(cs[0].source).toBe("default");
    expect(cs[0].path).toContain("Google Chrome.app");
    expect(cs[0].path).toContain("/Applications/");
  });

  it("linux → LINUX_CHROME_CANDIDATES（/usr/bin/google-chrome 优先）", () => {
    const cs = chromeCandidatesForPlatform({ platform: "linux" });
    expect(cs.length).toBeGreaterThanOrEqual(2);
    expect(cs[0].source).toBe("default");
    expect(cs[0].path).toBe("/usr/bin/google-chrome");
  });

  it("win → windowsChromeCandidates（Program Files\\Google\\Chrome 优先）", () => {
    const cs = chromeCandidatesForPlatform({
      platform: "win",
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
      localAppData: "C:\\Users\\Test\\AppData\\Local",
    });
    expect(cs.length).toBeGreaterThanOrEqual(3);
    expect(cs[0].source).toBe("default");
    // 注：path.join 在 macOS/Linux 用 / 分隔；在 Windows 用 \。
    // 本 spec 在 macOS 跑，所以断言用 path.join 计算期望值（平台无关）。
    expect(cs[0].path).toBe(
      path.join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    );
    expect(cs[1].path).toContain("Program Files (x86)");
    expect(cs[2].source).toBe("user-install");
    expect(cs[2].path).toContain("AppData");
  });

  it("unknown → 空数组（无候选）", () => {
    const cs = chromeCandidatesForPlatform({ platform: "unknown" });
    expect(cs).toEqual([]);
  });

  it("MACOS_CHROME_CANDIDATES 是 readonly（const 断言；保稳定）", () => {
    // 验证至少 3 条候选（Chrome / Chromium / Canary）
    expect(MACOS_CHROME_CANDIDATES.length).toBeGreaterThanOrEqual(3);
    const sources = MACOS_CHROME_CANDIDATES.map((c) => c.source);
    expect(sources).toContain("default");
    expect(sources).toContain("chromium-fork");
    expect(sources).toContain("canary");
  });

  it("LINUX_CHROME_CANDIDATES 至少 4 条（google-chrome / stable / chromium / chromium-browser）", () => {
    expect(LINUX_CHROME_CANDIDATES.length).toBeGreaterThanOrEqual(4);
    const paths = LINUX_CHROME_CANDIDATES.map((c) => c.path);
    expect(paths).toContain("/usr/bin/google-chrome");
    expect(paths).toContain("/usr/bin/google-chrome-stable");
    expect(paths).toContain("/usr/bin/chromium");
    expect(paths).toContain("/usr/bin/chromium-browser");
  });

  it("windowsChromeCandidates 直调（programFiles 注入）", () => {
    const cs = windowsChromeCandidates({
      programFiles: "X:\\PF",
      programFilesX86: "X:\\PFx86",
      localAppData: "X:\\LA",
    });
    // path.join 平台无关期望（macOS 跑用 /；Windows 跑用 \）
    expect(cs[0].path).toBe(
      path.join("X:\\PF", "Google", "Chrome", "Application", "chrome.exe"),
    );
    expect(cs[1].path).toBe(
      path.join("X:\\PFx86", "Google", "Chrome", "Application", "chrome.exe"),
    );
    expect(cs[2].path).toBe(
      path.join("X:\\LA", "Google", "Chrome", "Application", "chrome.exe"),
    );
  });
});

// ============================================================
// launchChrome —— 顺序 probe → 找到 → spawn
// ============================================================
describe("launchChrome —— 顺序 probe → 找到 → spawn → CDP 探活（W1-DEF-7 契约）", () => {
  it("macOS：第一候选存在 → 探活通过 → ok=true + binaryPath=第一候选 + spawn args 含 --remote-debugging-port", async () => {
    const mockSpawn = makeMockSpawn(99999);
    const existing = new Set([MACOS_CHROME_CANDIDATES[0].path]);
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(result.ok).toBe(true);
    expect(result.binaryPath).toBe(MACOS_CHROME_CANDIDATES[0].path);
    expect(result.pid).toBe(99999);
    expect(result.port).toBe(9222); // 默认端口
    // spawn 调用：args 含 --remote-debugging-port=9222 + --no-first-run
    expect(mockSpawn.calls.length).toBe(1);
    expect(mockSpawn.calls[0].cmd).toBe(MACOS_CHROME_CANDIDATES[0].path);
    expect(
      mockSpawn.calls[0].args.includes("--remote-debugging-port=9222"),
    ).toBe(true);
    expect(mockSpawn.calls[0].args.includes("--no-first-run")).toBe(true);
    expect(mockSpawn.calls[0].args.includes("--no-default-browser-check")).toBe(true);
  });

  it("Linux：第一候选不存在，第二候选存在 → 探活通过 → ok=true + binaryPath=第二候选", async () => {
    const mockSpawn = makeMockSpawn();
    const second = LINUX_CHROME_CANDIDATES[1].path; // /usr/bin/google-chrome-stable
    const existing = new Set([second]);
    const result = await launchChrome({
      platform: "linux",
      probeExists: makeMockProbe(existing),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(result.ok).toBe(true);
    expect(result.binaryPath).toBe(second);
  });

  it("--port 改端口 → spawn args + result.port 同步 + 探活 URL 用新端口", async () => {
    const mockSpawn = makeMockSpawn();
    const existing = new Set([MACOS_CHROME_CANDIDATES[0].path]);
    const fetch = makeMockFetch();
    const result = await launchChrome({
      platform: "mac",
      port: 9333,
      probeExists: makeMockProbe(existing),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
    });
    expect(result.port).toBe(9333);
    expect(
      mockSpawn.calls[0].args.includes("--remote-debugging-port=9333"),
    ).toBe(true);
    expect(fetch.urls[0]).toBe("http://127.0.0.1:9333/json/version");
  });

  it("--profileDir → spawn args 含 --user-data-dir=（显式优先于默认）", async () => {
    const mockSpawn = makeMockSpawn();
    const existing = new Set([MACOS_CHROME_CANDIDATES[0].path]);
    const result = await launchChrome({
      platform: "mac",
      profileDir: "/tmp/lasso-profile-test",
      probeExists: makeMockProbe(existing),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(
      mockSpawn.calls[0].args.includes(
        "--user-data-dir=/tmp/lasso-profile-test",
      ),
    ).toBe(true);
    expect(result.profileDir).toBe("/tmp/lasso-profile-test");
  });

  it("W1-DEF-7：无 profileDir → 默认注入隔离 --user-data-dir（defaultChromeProfileDir）", async () => {
    const mockSpawn = makeMockSpawn();
    const existing = new Set([MACOS_CHROME_CANDIDATES[0].path]);
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(
      mockSpawn.calls[0].args.includes(
        "--user-data-dir=/tmp/lasso-chrome-profile-default-test",
      ),
    ).toBe(true);
    expect(result.profileDir).toBe("/tmp/lasso-chrome-profile-default-test");
  });

  it("--extraArgs → spawn args 附加用户参数", async () => {
    const mockSpawn = makeMockSpawn();
    const existing = new Set([MACOS_CHROME_CANDIDATES[0].path]);
    await launchChrome({
      platform: "mac",
      extraArgs: ["--incognito", "--start-maximized"],
      probeExists: makeMockProbe(existing),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(mockSpawn.calls[0].args.includes("--incognito")).toBe(true);
    expect(mockSpawn.calls[0].args.includes("--start-maximized")).toBe(true);
  });

  it("Windows：Program Files 默认候选存在 → 探活通过 → ok=true + path 含 Program Files", async () => {
    const mockSpawn = makeMockSpawn();
    const cs = chromeCandidatesForPlatform({
      platform: "win",
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
      localAppData: "C:\\Users\\Test\\AppData\\Local",
    });
    const existing = new Set([cs[0].path]);
    const result = await launchChrome({
      platform: "win",
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
      localAppData: "C:\\Users\\Test\\AppData\\Local",
      probeExists: makeMockProbe(existing),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(result.ok).toBe(true);
    expect(result.binaryPath).toContain("Program Files");
  });
});

// ============================================================
// launchChrome —— 失败路径（tri-state 诚实）
// ============================================================
describe("launchChrome —— 失败路径（tri-state 诚实）", () => {
  it("全候选不存在 → ok=false + error=chrome_not_found + candidateSources 报全部候选", async () => {
    const mockSpawn = makeMockSpawn();
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(new Set()), // 全空
      spawnFn: mockSpawn.spawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("chrome_not_found");
    expect(result.candidateSources?.length).toBe(MACOS_CHROME_CANDIDATES.length);
    expect(mockSpawn.calls.length).toBe(0); // 没找到 → 不 spawn
  });

  it("unsupported platform → ok=false + error 含 unsupported_platform", async () => {
    const result = await launchChrome({
      platform: "unknown",
      probeExists: makeMockProbe(new Set()),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unsupported_platform");
  });

  it("spawn 抛错 → ok=false + error=String(e) + binaryPath 仍记录", async () => {
    const existing = new Set([MACOS_CHROME_CANDIDATES[0].path]);
    const throwingSpawn = (): ChildProcess => {
      throw new Error("ENOENT: spawn ENOENT");
    };
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing),
      spawnFn: throwingSpawn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT");
    expect(result.binaryPath).toBe(MACOS_CHROME_CANDIDATES[0].path);
  });
});

// ============================================================
// launchChrome —— W1-DEF-7（v1.8 Phase B）：CDP 探活三分支
// ============================================================
describe("launchChrome —— W1-DEF-7 CDP 探活（探活成功 / 失败 / 端口占用 / 子进程早退）", () => {
  const existing = () => new Set([MACOS_CHROME_CANDIDATES[0].path]);

  it("探活成功：预检空闲 + 第 2 次探活通过 → ok=true", async () => {
    const mockSpawn = makeMockSpawn(4321);
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: true });
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
    });
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(4321);
    expect(fetch.urls.length).toBe(2); // 1 次预检 + 1 次探活即通
  });

  it("探活失败（模块默认 visible 档）：40 次全不通且子进程未退 → ok=false + cdp_not_ready + mayStillBeStarting", async () => {
    const mockSpawn = makeMockSpawn();
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: false });
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cdp_not_ready");
    // P8（v1.18.1）：visible 档窗口 10→40 次（冷启动实测可超 3s，主循环亲历
    // cdp_not_ready 误报而 Chrome 实起）+ mayStillBeStarting 诚实标注
    expect((result as { mayStillBeStarting?: boolean }).mayStillBeStarting).toBe(true);
    // 1 次预检 + 40 次探活（CDP_PROBE_ATTEMPTS_VISIBLE）
    expect(fetch.urls.length).toBe(41);
  });

  it("P8：hidden 档维持 10 次探活窗口（无窗口创建，1.7s 实测即通）", async () => {
    const mockSpawn = makeMockSpawn();
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: false });
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
      launchMode: "hidden",
    });
    expect(result.error).toBe("cdp_not_ready");
    expect(fetch.urls.length).toBe(11); // 1 预检 + 10（CDP_PROBE_ATTEMPTS）
  });

  it("P8：probeAttempts 显式覆盖分档默认（注入 3 次）", async () => {
    const mockSpawn = makeMockSpawn();
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: false });
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
      probeAttempts: 3,
    });
    expect(result.error).toBe("cdp_not_ready");
    expect(fetch.urls.length).toBe(4); // 1 预检 + 3
  });

  it("P8：chrome_exited 不带 mayStillBeStarting（真失败与慢启动可区分）", async () => {
    const mockSpawn = makeMockSpawn(5678, "immediate-exit");
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: false });
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
    });
    expect(result.error).toBe("chrome_exited");
    expect((result as { mayStillBeStarting?: boolean }).mayStillBeStarting).toBeUndefined();
  });

  it("端口占用：预检即有响应 → ok=false + error=port_in_use 且不 spawn", async () => {
    const mockSpawn = makeMockSpawn();
    const fetch = makeMockFetch({ preCheckOk: true });
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("port_in_use");
    expect(mockSpawn.calls.length).toBe(0); // 占口即拒，不 spawn 第二个 Chrome
    expect(fetch.urls.length).toBe(1); // 只发预检
  });

  it("子进程早退：spawn 后立即 exit → ok=false + error=chrome_exited", async () => {
    const mockSpawn = makeMockSpawn(5678, "immediate-exit");
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: false });
    const result = await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("chrome_exited");
    expect(mockSpawn.calls.length).toBe(1); // 确实尝试 spawn 了
  });

  it("探活 URL 只绑 127.0.0.1（不误触代理 / IPv6）", async () => {
    const mockSpawn = makeMockSpawn();
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: true });
    await launchChrome({
      platform: "mac",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
    });
    for (const u of fetch.urls) {
      expect(u).toContain("http://127.0.0.1:9222/json/version");
    }
  });
});

// ============================================================
// v1.10（parse18 §3.2 机制二）：launchMode 分档 + 反节流三件套 + fallback 链
// ============================================================
describe("launchChrome —— launchMode 分档（parse18 §3 机制二）", () => {
  const existing = () => new Set([MACOS_CHROME_CANDIDATES[0].path]);

  it("10. hidden + mac：args 含 --no-startup-window + 三件套 + --mute-audio", async () => {
    const mockSpawn = makeMockSpawn(777);
    const result = await launchChrome({
      platform: "mac",
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(result.ok).toBe(true);
    const args = mockSpawn.calls[0].args;
    expect(args).toContain("--no-startup-window");
    expect(args).toContain("--disable-backgrounding-occluded-windows");
    expect(args).toContain("--disable-background-timer-throttling");
    expect(args).toContain("--disable-renderer-backgrounding");
    expect(args).toContain("--mute-audio");
  });

  it("11. visible：args 不含 --no-startup-window（v1.9 形态）但含三件套 + mute（恒加）", async () => {
    const mockSpawn = makeMockSpawn();
    await launchChrome({
      platform: "mac",
      launchMode: "visible",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    const args = mockSpawn.calls[0].args;
    expect(args).not.toContain("--no-startup-window");
    expect(args).not.toContain("--start-minimized");
    expect(args).toContain("--disable-backgrounding-occluded-windows");
    expect(args).toContain("--disable-background-timer-throttling");
    expect(args).toContain("--disable-renderer-backgrounding");
    expect(args).toContain("--mute-audio");
  });

  it("12. hidden + win：args 含 --start-minimized 且含 --no-startup-window（双发兜底）", async () => {
    const mockSpawn = makeMockSpawn();
    const cs = chromeCandidatesForPlatform({
      platform: "win",
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
      localAppData: "C:\\Users\\Test\\AppData\\Local",
    });
    await launchChrome({
      platform: "win",
      launchMode: "hidden",
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
      localAppData: "C:\\Users\\Test\\AppData\\Local",
      probeExists: makeMockProbe(new Set([cs[0].path])),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    const args = mockSpawn.calls[0].args;
    expect(args).toContain("--start-minimized");
    expect(args).toContain("--no-startup-window");
  });

  it("13. extraArgs 与默认 flag 重复 → 去重（同 flag 不双发）", async () => {
    const mockSpawn = makeMockSpawn();
    await launchChrome({
      platform: "mac",
      launchMode: "hidden",
      extraArgs: ["--mute-audio", "--no-startup-window", "--incognito"],
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    const args = mockSpawn.calls[0].args;
    expect(args.filter((a) => a === "--mute-audio")).toHaveLength(1);
    expect(args.filter((a) => a === "--no-startup-window")).toHaveLength(1);
    expect(args).toContain("--incognito");
  });

  it("14. fallback 链：hidden spawn 即退 → 第二次 spawn args 含 --window-position=-32000,-32000 且无 --no-startup-window", async () => {
    const mockSpawn = makeMockSpawn(8888, "immediate-exit");
    // 探活只在 fallback（第 2 次 spawn）后放行——primary 必须先走完「即退」路径
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: false });
    const origFn = fetch.fetchFn;
    const fetchFn = async (url: string): Promise<{ ok: boolean }> => {
      if (mockSpawn.calls.length >= 2) return { ok: true };
      return origFn(url);
    };
    const result = await launchChrome({
      platform: "mac",
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn,
    });
    // 第一次 immediate-exit；fallback 第二次 alive + 探活通过 → ok
    expect(mockSpawn.calls.length).toBe(2);
    expect(mockSpawn.calls[1].args).toContain("--window-position=-32000,-32000");
    expect(mockSpawn.calls[1].args).not.toContain("--no-startup-window");
    expect(result.ok).toBe(true);
  });

  it("15. fallback 也 exited → 返 chrome_exited（不第三次重试）", async () => {
    const mockSpawn = makeMockSpawn(8888, "immediate-exit");
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: false });
    const result = await launchChrome({
      platform: "mac",
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      fetchFn: fetch.fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("chrome_exited");
    expect(mockSpawn.calls.length).toBe(2); // 恰好两次（primary + fallback）
  });

  it("16. recordLaunch 落账含 launchMode/idleMs（透传 opts；读台账验证）", async () => {
    const mockSpawn = makeMockSpawn(13579);
    await launchChrome({
      platform: "mac",
      port: 9555,
      launchMode: "hidden",
      idleMs: 3_600_000,
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    const { readLedgerSync } = await import("../../src/launcher/chrome-ledger.js");
    const rec = readLedgerSync().find((r) => r.port === 9555);
    expect(rec).toBeDefined();
    expect(rec!.launchMode).toBe("hidden");
    expect(rec!.idleMs).toBe(3_600_000);
  });

  it("17. parseLaunchChromeArgs：--mode hidden / --idle-ms 5000 解析进 opts", () => {
    const opts = parseLaunchChromeArgs(["--mode", "hidden", "--idle-ms", "5000"]);
    expect(opts.launchMode).toBe("hidden");
    expect(opts.idleMs).toBe(5000);
    // 非法值忽略（走 config / 内置默认）
    const bad = parseLaunchChromeArgs(["--mode", "minimized", "--idle-ms", "-5"]);
    expect(bad.launchMode).toBeUndefined();
    expect(bad.idleMs).toBeUndefined();
    expect(parseLaunchChromeArgs(["--mode", "visible"]).launchMode).toBe("visible");
  });

  it("v1.10：hidden 档成功路径触发隐藏保险丝（F1 起立即执行；非 mac hideFn no-op 由 chrome-hide.spec 覆盖）", async () => {
    const mockSpawn = makeMockSpawn(24680);
    const hideCalls: Array<number | undefined> = [];
    await launchChrome({
      platform: "mac",
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      hideFn: (pid) => {
        hideCalls.push(pid);
        return { ok: true };
      },
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(hideCalls).toEqual([24680]);
  });

  it("v1.10：visible 档不触发保险丝（零调用）", async () => {
    const mockSpawn = makeMockSpawn();
    const hideCalls: Array<number | undefined> = [];
    await launchChrome({
      platform: "mac",
      launchMode: "visible",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      hideFn: (pid) => {
        hideCalls.push(pid);
        return { ok: true };
      },
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(hideCalls).toEqual([]);
  });
});

/**
 * P31（v1.18.3 同类横扫 S4）：隐藏保险丝异步化。
 *
 * 背景：launchChrome 经 MCP chrome-launch 工具进 server 进程，fuse 此前默认
 * hideChromeByPid（spawnSync osascript 2s 上限）在请求路径上同步阻塞事件循环
 * （与 P27 已修的 watchdog 同机制同阻塞面）。P31 起默认 hideChromeByPidAsync
 * （execFile）且 **await 在 launchChrome 返回前完成**——fire-and-forget 会被
 * CLI 路径的 process.exit 击败（F1 v1.10 事故形态在异步版重演），await 形态
 * 保 F1 修复。
 */
describe("P31 · 隐藏保险丝异步化（server 请求路径零阻塞 + F1 保持）", () => {
  const existing = () => new Set([MACOS_CHROME_CANDIDATES[0].path]);

  it("P31-1. 异步 hideFn（Promise）被 await：launchChrome 返回时 fuse 已完成（无需额外等待）", async () => {
    const mockSpawn = makeMockSpawn(24681);
    const logs: Array<Record<string, unknown>> = [];
    const r = await launchChrome({
      platform: "mac",
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      hideFn: (pid) =>
        new Promise((resolve) => {
          // 异步原语形态：下一宏任务才 resolve（execFile 回调的近似）
          setTimeout(() => resolve({ ok: true }), 5);
        }),
      logFn: (p) => logs.push(p),
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    expect(r.ok).toBe(true);
    // await 在返回前完成：零额外等待即已落 fuse 日志（F1 异步版）
    expect(logs.some((p) => p.evt === "chrome_hide_fuse_ok")).toBe(true);
  });

  it("P31-2. 微任务序：hide Promise resolve 之前 fuse 日志不落（真 await，非 fire-and-forget）", async () => {
    const mockSpawn = makeMockSpawn(24682);
    const logs: Array<Record<string, unknown>> = [];
    let releaseHide: (() => void) | null = null;
    const launchP = launchChrome({
      platform: "mac",
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      hideFn: () =>
        new Promise((resolve) => {
          releaseHide = () => resolve({ ok: true });
        }),
      logFn: (p) => logs.push(p),
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    // spawn + 探活 + 台账已过（FAST_PROBE 毫秒级），fuse 挂起在未 resolve 的 hide 上
    await new Promise((r) => setTimeout(r, 15));
    expect(logs.some((p) => p.evt === "chrome_hide_fuse_ok")).toBe(false);
    expect(logs.some((p) => p.evt === "chrome_hide_fuse_denied")).toBe(false);
    releaseHide!(); // osascript 完成
    const r = await launchP;
    expect(r.ok).toBe(true);
    expect(logs.some((p) => p.evt === "chrome_hide_fuse_ok")).toBe(true);
  });

  it("P31-3. 白盒：默认 hideFn = hideChromeByPidAsync + 两成功路径 await scheduleHideFuse + 零同步原语回流", () => {
    const src = readFileSync("src/launcher/launch-chrome.ts", "utf8");
    expect(src).toMatch(
      /const hideFn = opts\.hideFn \?\? \(\(pid: number \| undefined\) => hideChromeByPidAsync\(pid\)\)/,
    );
    expect(src).toMatch(/await scheduleHideFuse\(primary\.pid\)/); // primary 成功路径
    expect(src).toMatch(/await scheduleHideFuse\(second\.pid\)/); // 离屏 fallback 成功路径
    // 同步原语（\b 排除 Async 后缀）不得回流本文件——server 请求路径 spawnSync 阻塞面拆除
    expect(src).not.toMatch(/hideChromeByPid\b(?!Async)/);
  });
});

// ============================================================
// bug02 隐藏全生命周期 + 外部 touch 信号（v1.18.5，doc/bugs/02）
// ============================================================
describe("bug02 · hidden 档出生写粘滞账 + 自 touch + 执守启动（v1.18.5）", () => {
  const existing = () => new Set([MACOS_CHROME_CANDIDATES[0].path]);

  it("B1. hidden + fuse ok → desired-hidden 落账（pid/port/profileDir）+ ensureEnforcerFn 被调", async () => {
    const mockSpawn = makeMockSpawn(31531);
    const enforcerCalls: number[] = [];
    await launchChrome({
      platform: "mac",
      port: 9661,
      profileDir: "/tmp/lasso-b02-profile",
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      hideFn: () => ({ ok: true }),
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
      // 注意顺序：ensureEnforcerFn 必须在 ...FAST_PROBE 之后（FAST_PROBE 内含
      // no-op ensureEnforcerFn，先写会被覆盖——B1 初版即栽在此）
      ensureEnforcerFn: async () => {
        enforcerCalls.push(1);
      },
    });
    const { readDesiredHiddenSync } = await import("../../src/launcher/desired-hide-state.js");
    const rec = readDesiredHiddenSync().find((r) => r.pid === 31531);
    expect(rec).toBeDefined();
    expect(rec!.port).toBe(9661);
    expect(rec!.profileDir).toBe("/tmp/lasso-b02-profile");
    expect(typeof rec!.hiddenAt).toBe("number");
    expect(enforcerCalls).toHaveLength(1); // 记账后确保独立执守（server 不在时兜压回）
  });

  it("B2. visible 档 ok → 不落粘滞账 + 不启动执守（用户可见窗口不是执守对象）", async () => {
    const mockSpawn = makeMockSpawn(31532);
    const enforcerCalls: number[] = [];
    await launchChrome({
      platform: "mac",
      port: 9662,
      launchMode: "visible",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      hideFn: () => ({ ok: true }),
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
      // 同 B1：置于 ...FAST_PROBE 之后防覆盖
      ensureEnforcerFn: async () => {
        enforcerCalls.push(1);
      },
    });
    const { readDesiredHiddenSync } = await import("../../src/launcher/desired-hide-state.js");
    expect(readDesiredHiddenSync().find((r) => r.pid === 31532)).toBeUndefined();
    expect(enforcerCalls).toHaveLength(0);
  });

  it("B3. hidden + fuse denied（TCC 缺失 / 非 mac）→ 不落粘滞账（与 chrome-hide CLI 降级形态一致）", async () => {
    const mockSpawn = makeMockSpawn(31533);
    await launchChrome({
      platform: "mac",
      port: 9663,
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      hideFn: () => ({ ok: false, reason: "osascript_exit_1743" }),
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    const { readDesiredHiddenSync } = await import("../../src/launcher/desired-hide-state.js");
    expect(readDesiredHiddenSync().find((r) => r.pid === 31533)).toBeUndefined();
  });

  it("B4. fallback（离屏档）ok → 同样落粘滞账（两条 ok 路径无漏网）", async () => {
    // 第一次 spawn 即退 → fallback 第二次 alive + 探活通过
    const mockSpawn = makeMockSpawn(31534, "immediate-exit");
    const fetch = makeMockFetch({ preCheckOk: false, probeOk: false });
    const origFn = fetch.fetchFn;
    const fetchFn = async (url: string): Promise<{ ok: boolean }> => {
      if (mockSpawn.calls.length >= 2) return { ok: true };
      return origFn(url);
    };
    // fallback pid 用第二次 spawn 的 pid（makeMockSpawn 恒返同 pid，直接断言它）
    await launchChrome({
      platform: "mac",
      port: 9664,
      launchMode: "hidden",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      hideFn: () => ({ ok: true }),
      ...FAST_PROBE,
      fetchFn,
    });
    expect(mockSpawn.calls.length).toBe(2);
    const { readDesiredHiddenSync } = await import("../../src/launcher/desired-hide-state.js");
    expect(readDesiredHiddenSync().find((r) => r.pid === 31534)).toBeDefined();
  });

  it("B5. ok 路径自 touch：chrome-touch-<port> 文件在 env 隔离目录内诞生（bug02 外部信号约定确立）", async () => {
    const mockSpawn = makeMockSpawn(31535);
    await launchChrome({
      platform: "mac",
      port: 9665,
      launchMode: "visible",
      probeExists: makeMockProbe(existing()),
      spawnFn: mockSpawn.spawnFn,
      ...FAST_PROBE,
      ...makeMockFetchSafe(),
    });
    const { chromeTouchMtimeSync } = await import("../../src/launcher/chrome-touch.js");
    expect(chromeTouchMtimeSync(9665)).toBeGreaterThan(0);
    expect(chromeTouchMtimeSync(9666)).toBeUndefined(); // 其他 port 无信号
  });

  it("B6. 白盒：scheduleHideFuse 含 addDesiredHidden + ensureEnforcerFn（出生保护不漂移）", () => {
    const src = readFileSync("src/launcher/launch-chrome.ts", "utf8");
    expect(src).toMatch(/await addDesiredHidden\(/);
    expect(src).toMatch(/if \(r\.ok && pid !== undefined\)/);
    expect(src).toMatch(/await ensureEnforcerFn\(\)/);
    // 自 touch 与台账同点（三处 recordLaunch 后）
    expect(src.match(/await touchChromePort\(port, log\);/g)?.length).toBe(3);
  });

  it("B7. 白盒：index.ts CLI 显式拉起默认 idleMs=0（无显式配置时不进 reaper 管辖）", () => {
    const src = readFileSync("src/index.ts", "utf8");
    // mergedEnv 读原始 key：显式配置（env/config.json）存在才透传 cliCfg.launchIdleMs
    expect(src).toMatch(/const rawIdle = mergedEnv\(\)\.LASSO_LAUNCH_IDLE_MS;/);
    expect(src).toMatch(/\? cliCfg\.launchIdleMs\n\s*: 0;/);
  });
});

// ============================================================
// parseLaunchChromeArgs —— argv 解析
// ============================================================
describe("parseLaunchChromeArgs —— argv 解析", () => {
  it("空 argv → 默认 opts（无 port / profileDir / extraArgs）", () => {
    const opts = parseLaunchChromeArgs([]);
    expect(opts.port).toBeUndefined();
    expect(opts.profileDir).toBeUndefined();
    expect(opts.extraArgs).toBeUndefined();
  });

  it("--port N → opts.port=N", () => {
    const opts = parseLaunchChromeArgs(["--port", "9333"]);
    expect(opts.port).toBe(9333);
  });

  it("--port 非数字 → 忽略（不抛错）", () => {
    const opts = parseLaunchChromeArgs(["--port", "not-a-number"]);
    expect(opts.port).toBeUndefined();
  });

  it("--profile <dir> → opts.profileDir=dir", () => {
    const opts = parseLaunchChromeArgs(["--profile", "/tmp/test-profile"]);
    expect(opts.profileDir).toBe("/tmp/test-profile");
  });

  it("--incognito → opts.extraArgs 含 --incognito", () => {
    const opts = parseLaunchChromeArgs(["--incognito"]);
    expect(opts.extraArgs).toContain("--incognito");
  });

  it("--extra-args 逗号分隔 → 拆分追加", () => {
    const opts = parseLaunchChromeArgs([
      "--extra-args",
      "--incognito,--start-maximized",
    ]);
    expect(opts.extraArgs).toContain("--incognito");
    expect(opts.extraArgs).toContain("--start-maximized");
  });

  it("--incognito + --extra-args 合并", () => {
    const opts = parseLaunchChromeArgs([
      "--incognito",
      "--extra-args",
      "--start-maximized",
    ]);
    expect(opts.extraArgs).toEqual(
      expect.arrayContaining(["--incognito", "--start-maximized"]),
    );
  });

  it("--help / -h → 解析层忽略（runLaunchChromeCli 入口短路处理，见 #5 describe）", () => {
    const opts = parseLaunchChromeArgs(["--help"]);
    expect(opts.port).toBeUndefined();
    expect(parseLaunchChromeArgs(["-h"]).port).toBeUndefined();
  });

  it("未知 flag → 忽略（forward-compat）", () => {
    const opts = parseLaunchChromeArgs(["--unknown-flag", "--port", "9222"]);
    expect(opts.port).toBe(9222);
  });
});

// ============================================================
// #5（v1.18.7 审查 P2 修复）· runLaunchChromeCli --help/-h 短路
// ============================================================
/**
 * 修复前的 bug 路径（白盒）：parseLaunchChromeArgs 吞掉 --help（注释称 "caller
 * 处理"）但 runLaunchChromeCli 从不检查 → `lasso launch-chrome --help` 直接落入
 * launchChrome 真启动 Chrome。
 *
 * 本 describe 守修复后契约：--help/-h → 打印注入的 usage（生产经 index.ts 以
 * CLI_USAGE 单一真源注入 helpText）+ process.exit(0)，**零 spawn**。
 *
 * 测试策略（守零真实启动）：
 *  - spawnFn 经 defaults 注入 makeMockSpawn（伪 ChildProcess；即使修复回归也只
 *    记 calls 不真启 Chrome）
 *  - process.exit spy（throw 哨兵阻断后续代码）+ process.stdout.write spy（捕获
 *    usage 输出）；afterEach restore
 */
describe("#5 · runLaunchChromeCli --help/-h 短路（不 spawn + usage + exit 0）", () => {
  /** process.exit 哨兵（阻断 exit 后代码；携带 exit code 供断言）。 */
  class ExitSentinel extends Error {
    constructor(public readonly code: number) {
      super(`__process_exit_${code}__`);
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("#5-1. --help：打印注入的 usage + exit 0 + 零 spawn（DI spawnFn 断言）", async () => {
    const mockSpawn = makeMockSpawn(41001);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSentinel(code ?? 0);
    }) as never);
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);

    const USAGE_SENTINEL = "lasso-mcp usage sentinel — CLI_USAGE 单一真源注入位";
    await expect(
      runLaunchChromeCli(["--help"], {
        helpText: USAGE_SENTINEL,
        spawnFn: mockSpawn.spawnFn,
      }),
    ).rejects.toThrow("__process_exit_0__");
    expect(exitSpy).toHaveBeenCalledWith(0);
    // usage 打印且只打印 usage（不落 JSON result）
    expect(chunks.join("")).toBe(USAGE_SENTINEL + "\n");
    // 零 spawn：--help 短路在 launchChrome 之前（旧 bug 形态会真启动 Chrome）
    expect(mockSpawn.calls.length).toBe(0);
  });

  it("#5-2. -h 短 flag 同款短路（usage + exit 0 + 零 spawn）", async () => {
    const mockSpawn = makeMockSpawn(41002);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSentinel(code ?? 0);
    }) as never);
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);

    await expect(
      runLaunchChromeCli(["-h"], { helpText: "usage-text", spawnFn: mockSpawn.spawnFn }),
    ).rejects.toThrow("__process_exit_0__");
    expect(chunks.join("")).toBe("usage-text\n");
    expect(mockSpawn.calls.length).toBe(0);
  });

  it("#5-3. --help 与其他 flag 混排（--port 9333 --help）：仍短路（help 存在即退出，不解析启动）", async () => {
    const mockSpawn = makeMockSpawn(41003);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSentinel(code ?? 0);
    }) as never);
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);

    await expect(
      runLaunchChromeCli(["--port", "9333", "--help"], {
        helpText: "usage-text",
        spawnFn: mockSpawn.spawnFn,
      }),
    ).rejects.toThrow("__process_exit_0__");
    expect(mockSpawn.calls.length).toBe(0);
    expect(chunks.join("")).toBe("usage-text\n");
  });

  it("#5-4. 未注入 helpText 的直调形态：--help 仍 exit 0 + 零 spawn（防旧 bug 复活；silent 退出）", async () => {
    const mockSpawn = makeMockSpawn(41004);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSentinel(code ?? 0);
    }) as never);
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);

    await expect(
      runLaunchChromeCli(["--help"], { spawnFn: mockSpawn.spawnFn }),
    ).rejects.toThrow("__process_exit_0__");
    expect(mockSpawn.calls.length).toBe(0);
    expect(chunks.join("")).toBe(""); // 无注入 → 不打印 usage（契约：恒不 spawn）
  });

  it("#5-5. mergeLaunchDefaults：defaults.spawnFn 透传进 opts（#5 DI 通道接线）", () => {
    const mockSpawn = makeMockSpawn(41005);
    const merged = mergeLaunchDefaults(parseLaunchChromeArgs([]), {
      spawnFn: mockSpawn.spawnFn,
    });
    expect(merged.spawnFn).toBe(mockSpawn.spawnFn);
    // opts 已有 spawnFn 时不覆盖（argv/直传层优先）
    const own = (): ChildProcess => ({ pid: 1 } as unknown as ChildProcess);
    expect(
      mergeLaunchDefaults({ spawnFn: own }, { spawnFn: mockSpawn.spawnFn }).spawnFn,
    ).toBe(own);
  });

  it("#5-6. 白盒：index.ts 生产接线注入 helpText=CLI_USAGE（usage 单一真源，非复制体）", () => {
    const src = readFileSync("src/index.ts", "utf8");
    // CLI_USAGE 定义 + launch-chrome dispatch 注入同一常量（同源证明）
    expect(src).toMatch(/const CLI_USAGE = \[/);
    expect(src).toMatch(/helpText: CLI_USAGE,/);
    // launcher 侧不 import index（INV-64 单向依赖；usage 只能经注入流入）
    const launcherSrc = readFileSync("src/launcher/launch-chrome.ts", "utf8");
    expect(launcherSrc).not.toMatch(/from\s+["']\.\.\/index\.js["']/);
  });
});

// ============================================================
// fileUrlToPathSafe —— 测试用导出
// ============================================================
describe("fileUrlToPathSafe —— import.meta.url → file path", () => {
  it("合法 file:// URL → 返绝对路径", () => {
    const p = fileUrlToPathSafe("file:///tmp/test.ts");
    expect(p).toBe("/tmp/test.ts");
  });

  it("非法 URL → 返原字符串（不抛错）", () => {
    const p = fileUrlToPathSafe("not-a-url");
    expect(p).toBe("not-a-url");
  });
});
