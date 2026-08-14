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
 *
 * macOS-only 现实红线（parse11 §1.3）：本 spec 用 mock probeExists + spawnFn；
 * 不真 spawn Chrome；Win/Linux 路径仅静态验 shape，真机 spawn 手测 #W7/#L7 pending。
 *
 * 测试策略（守 R-CI-02）：
 *  - probeExists 注入：mock fs.access → false/true 控制路径探测结果
 *  - spawnFn 注入：mock child_process.spawn → 返伪 ChildProcess（不真启子进程）
 *  - 不引入 puppeteer / open / chrome-launcher 等社区包（INV-64 守）
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  launchChrome,
  parseLaunchChromeArgs,
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
} as const;

/** makeMockFetch 的 spread 包装（只透出 fetchFn，不带 urls 数组）。 */
function makeMockFetchSafe(): { fetchFn: (url: string) => Promise<{ ok: boolean }> } {
  const { fetchFn } = makeMockFetch();
  return { fetchFn };
}

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

  it("探活失败：10 次全不通且子进程未退 → ok=false + error=cdp_not_ready", async () => {
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
    // 1 次预检 + 10 次探活（CDP_PROBE_ATTEMPTS）
    expect(fetch.urls.length).toBe(11);
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

  it("--help / -h → 忽略（caller 处理）", () => {
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
