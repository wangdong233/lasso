/**
 * chrome-ledger.spec.ts（v1.9 parse17 §7.1 机制二，例 11-18）
 *
 * 守护磁盘台账 + chrome-stop 收尾契约：
 *  11. recordLaunch 原子写 + 同 port 覆盖
 *  12. readLedgerSync 文件损坏 → [] 不 throw
 *  13. stopLaunchedChromes：pid 死 → already_dead + 删条目
 *  14. cmdline 不含 --user-data-dir=<profileDir> → pid_reused_skipped + killTreeFn 未被调（红线断言）
 *  15. cmdline 验证通过 + SIGTERM 后死 → killed + 删条目
 *  16. SIGTERM 2s 不死 → killTreeSync fallback 被调
 *  17. --port N 只动一条；无 flag = 全部
 *  18. exit 同步路径 stopLaunchedChromesSync 零 await（源码 grep 断言）
 *
 * 测试策略：LASSO_LAUNCHED_CHROMES_PATH 指 tmp 隔离台账；aliveFn / psFn /
 * killTreeFn / sleepFn 全注入 mock（不真 kill 进程；真实树杀由
 * subprocess-lifecycle.spec.ts 真实进程验证）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readFileSync } from "node:fs";
import {
  recordLaunch,
  readLedgerSync,
  removeLedgerEntries,
  launchedChromesPath,
  type LaunchedChromeRecord,
} from "../../src/launcher/chrome-ledger.js";
import {
  stopLaunchedChromes,
  stopLaunchedChromesSync,
  parseChromeStopArgs,
  verifyOwnership,
} from "../../src/launcher/chrome-stop.js";

let tmpDir: string;
let ledgerPath: string;

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9227,
    pid: 74620,
    profileDir: "/tmp/lasso-chrome-profile-default",
    launchedAt: Date.now(),
    status: "ready",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-chrome-ledger-"));
  ledgerPath = path.join(tmpDir, "launched-chromes.json");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("chrome-ledger —— 磁盘台账（parse17 §3.2）", () => {
  it("launchedChromesPath 受 LASSO_LAUNCHED_CHROMES_PATH 覆盖（测试隔离钩子）", () => {
    expect(launchedChromesPath()).toBe(ledgerPath);
  });

  it("recordLaunch 落盘 + 同 port 覆盖（第二次 launch 同 port → 单条记录）", async () => {
    await recordLaunch(makeRec({ pid: 111 }));
    await recordLaunch(makeRec({ pid: 222, status: "cdp_not_ready" }));
    const ledger = readLedgerSync();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ port: 9227, pid: 222, status: "cdp_not_ready" });
    // 不同 port 追加
    await recordLaunch(makeRec({ port: 9228, pid: 333 }));
    expect(readLedgerSync()).toHaveLength(2);
  });

  it("recordLaunch 写失败 best-effort 不抛（不可写目录）", async () => {
    process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "no-such-dir-x", "sub", "l.json");
    // mkdir recursive 会建目录……指一个被文件占住的路径逼失败：
    const blocker = path.join(tmpDir, "blocker");
    await fs.writeFile(blocker, "x", "utf8");
    process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(blocker, "launched-chromes.json");
    await expect(recordLaunch(makeRec())).resolves.not.toThrow();
  });

  it("readLedgerSync：文件不存在 / JSON 损坏 / 顶层非数组 → [] 不 throw", async () => {
    expect(readLedgerSync()).toEqual([]); // 不存在
    await fs.writeFile(ledgerPath, "{broken json", "utf8");
    expect(readLedgerSync()).toEqual([]);
    await fs.writeFile(ledgerPath, '{"a":1}', "utf8");
    expect(readLedgerSync()).toEqual([]);
  });

  it("removeLedgerEntries 按 port 删（保留其余）", async () => {
    await recordLaunch(makeRec({ port: 9227 }));
    await recordLaunch(makeRec({ port: 9228 }));
    await removeLedgerEntries([9227]);
    const ledger = readLedgerSync();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.port).toBe(9228);
  });
});

describe("chrome-stop —— 台账收尾（parse17 §3.4）", () => {
  it("pid 已死（aliveFn=false）→ already_dead + 删条目 + killTreeFn 未被调", async () => {
    await recordLaunch(makeRec({ pid: 9991 }));
    const k = recorder();
    const r = await stopLaunchedChromes({
      aliveFn: () => false,
      killTreeFn: k.fn,
    });
    expect(r.stopped).toEqual([{ port: 9227, pid: 9991, action: "already_dead" }]);
    expect(k.calls).toHaveLength(0);
    expect(readLedgerSync()).toEqual([]);
  });

  it("cmdline 不含 --user-data-dir=<profileDir> → pid_reused_skipped + killTreeFn 未被调（红线）", async () => {
    await recordLaunch(makeRec({ pid: 9992 }));
    const k = recorder();
    const r = await stopLaunchedChromes({
      aliveFn: () => true,
      // pid 被无关进程复用：cmdline 是别的进程
      psFn: () => "/Applications/Safari.app/Contents/MacOS/Safari --some-flag",
      killTreeFn: k.fn,
    });
    expect(r.stopped).toEqual([
      { port: 9227, pid: 9992, action: "pid_reused_skipped" },
    ]);
    // 红线断言：绝不 kill 未验证归属的 pid
    expect(k.calls).toHaveLength(0);
    // 陈旧条目仍被清（台账不再指向死记录）
    expect(readLedgerSync()).toEqual([]);
  });

  it("verifyOwnership 精确子串匹配（含 marker 通过；前缀近似不通过）", () => {
    const psFnOk = () =>
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9227 --user-data-dir=/tmp/lasso-chrome-profile-default`;
    expect(verifyOwnership(1, "/tmp/lasso-chrome-profile-default", psFnOk)).toBe(true);
    // 前缀近似（profileDir 不同）必须不通过
    const psFnPrefix = () => `... --user-data-dir=/tmp/lasso-chrome-profile-default-evil`;
    expect(verifyOwnership(1, "/tmp/lasso-chrome-profile-default", psFnPrefix)).toBe(false);
  });

  // v1.9 真机验证 V2 发现的 P0 回归守护：真机 `ps -p <pid> -o command=` 行尾恒带 "\n"，
  // 而 Chrome 的 --user-data-dir 是最后一参 → marker 后字符是 "\n" 不是 undefined。
  // 修复前该形状被误判 pid_reused_skipped → 只清台账不杀 → 孤儿 Chrome（wave2 残留复现源）。
  it("verifyOwnership 真机形状：marker 在 ps 输出行尾（带换行）必须通过", () => {
    const psFnReal = () =>
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9225 --no-first-run --no-default-browser-check --user-data-dir=/tmp/lasso-chrome-profile-default\n`;
    expect(verifyOwnership(1, "/tmp/lasso-chrome-profile-default", psFnReal)).toBe(true);
    // 换行后还有内容 = 真前缀拼接种，仍必须不通过
    const psFnRealPrefix = () =>
      `chrome --user-data-dir=/tmp/lasso-chrome-profile-default\n--evil-extra\n`;
    expect(verifyOwnership(1, "/tmp/lasso-chrome-profile-default", psFnRealPrefix)).toBe(false);
  });

  it("cmdline 验证通过 + SIGTERM 后死 → killed + 删条目 + 不走树杀", async () => {
    await recordLaunch(makeRec({ pid: 9993 }));
    let alive = true;
    const k = recorder();
    const r = await stopLaunchedChromes({
      aliveFn: () => alive,
      psFn: () => `chrome --user-data-dir=/tmp/lasso-chrome-profile-default`,
      killTreeFn: k.fn,
      sleepFn: async () => {
        alive = false; // SIGTERM 后第一个轮询窗内死
      },
    });
    expect(r.stopped).toEqual([{ port: 9227, pid: 9993, action: "killed" }]);
    expect(k.calls).toHaveLength(0); // 优雅路径足够，不树杀
    expect(readLedgerSync()).toEqual([]);
  });

  it("SIGTERM 2s 不死 → killTreeSync fallback 被调", async () => {
    await recordLaunch(makeRec({ pid: 9994 }));
    const k = recorder();
    const sleeps: number[] = [];
    const r = await stopLaunchedChromes({
      aliveFn: () => true, // 永不死
      psFn: () => `chrome --user-data-dir=/tmp/lasso-chrome-profile-default`,
      killTreeFn: k.fn,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r.stopped[0]!.action).toBe("killed");
    expect(k.calls).toEqual([9994]); // 树杀 fallback
    // 优雅窗口耗尽：200ms × ≥10 次（2s 上界）
    expect(sleeps.length).toBeGreaterThanOrEqual(10);
  });

  it("--port N 只动一条；无 flag = 全部（台账已 scoped，全清是安全默认）", async () => {
    await recordLaunch(makeRec({ port: 9227, pid: 7001 }));
    await recordLaunch(makeRec({ port: 9228, pid: 7002 }));
    const k = recorder();
    const r1 = await stopLaunchedChromes({
      port: 9227,
      aliveFn: () => false,
      killTreeFn: k.fn,
    });
    expect(r1.stopped).toHaveLength(1);
    expect(r1.stopped[0]!.port).toBe(9227);
    expect(readLedgerSync().map((x) => x.port)).toEqual([9228]);

    // --all（无 port flag）
    const r2 = await stopLaunchedChromes({ aliveFn: () => false, killTreeFn: k.fn });
    expect(r2.stopped).toHaveLength(1);
    expect(r2.stopped[0]!.port).toBe(9228);
    expect(readLedgerSync()).toEqual([]);
  });

  it("空台账 → 空 stopped + exit-0 语义（幂等）", async () => {
    // 无 port = --all（P2 处置轮删除死 all 字段后，--all 语义由「无 port」承载）
    const r = await stopLaunchedChromes({});
    expect(r.stopped).toEqual([]);
  });

  it("parseChromeStopArgs：--port N / --all / 无 flag / 未知忽略", () => {
    expect(parseChromeStopArgs(["--port", "9227"])).toEqual({ port: 9227 });
    // --all 接受但不写字段（无 port = --all）
    expect(parseChromeStopArgs(["--all"])).toEqual({});
    expect(parseChromeStopArgs([])).toEqual({});
    expect(parseChromeStopArgs(["--port", "abc", "--bogus"])).toEqual({});
  });

  // v1.19（渲染档设计决议 3.5）：--modes CSV 解析
  it("parseChromeStopArgs：--modes CSV 解析（render / 多值 / 非法值抛错）", () => {
    expect(parseChromeStopArgs(["--modes", "render"])).toEqual({ modes: ["render"] });
    expect(parseChromeStopArgs(["--modes", "hidden,render"])).toEqual({
      modes: ["hidden", "render"],
    });
    expect(parseChromeStopArgs(["--modes", " render , visible "])).toEqual({
      modes: ["render", "visible"],
    });
    // 空值 = 未提供（--all 语义不受影响）
    expect(parseChromeStopArgs(["--modes", ""])).toEqual({});
    expect(() => parseChromeStopArgs(["--modes", "render,evil"])).toThrow(/invalid --modes/);
    expect(() => parseChromeStopArgs(["--modes", "daily"])).toThrow(/hidden\|visible\|render/);
  });

  it("stopLaunchedChromesSync：同步路径同红线（pid 复用不 kill）+ 清台账", async () => {
    await recordLaunch(makeRec({ pid: 9995 }));
    // 同步版不可注入 —— pid 9995 不存在 → already_dead 分支
    const r = stopLaunchedChromesSync();
    expect(r.stopped).toEqual([{ port: 9227, pid: 9995, action: "already_dead" }]);
    expect(readLedgerSync()).toEqual([]);
  });

  it("stopLaunchedChromesSync 源码零 await（exit 钩子纪律，W1-DEF-6 模式）", () => {
    const src = readFileSync(
      new URL("../../src/launcher/chrome-stop.ts", import.meta.url),
      "utf8",
    );
    // 圈定同步函数体（export function stopLaunchedChromesSync 到下一个 export）
    const m = src.match(
      /export function stopLaunchedChromesSync[\s\S]*?\nexport/s,
    );
    expect(m).not.toBeNull();
    const body = m![0]!;
    expect(body).not.toMatch(/\bawait\b/); // 零 await
    // 红线控制流：verifyOwnership 早于 killTreeSync（return 拦截在前）
    const guardIdx = body.indexOf("if (!verifyOwnership(");
    const killIdx = body.indexOf("killTreeSync(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(killIdx);
  });
});

/** 极简 call-recorder（killTreeFn 注入用）。 */
function recorder(): { fn: (pid: number) => void; calls: number[] } {
  const calls: number[] = [];
  return { fn: (pid: number) => void calls.push(pid), calls };
}

// ============================================================
// v1.19（渲染档设计决议 3.1 落点 1 / 3.4 / 3.5）：launchMode 第三值 "render"
// ——台账写读往返（守 readLedgerSync 解析守卫漏改）+ chrome-stop render 收割
// 连带 profile 清理 + modes 过滤三值
// ============================================================
describe("render 台账三值（渲染档设计决议 3.1）", () => {
  it("render 写读往返：recordLaunch launchMode=render → readLedgerSync 读回 render（守守卫漏改负例）", async () => {
    await recordLaunch(makeRec({ launchMode: "render", idleMs: 600_000 }));
    const ledger = readLedgerSync();
    expect(ledger).toHaveLength(1);
    // 🔴 守卫（:107-110 一带）漏改时 launchMode 被静默读成 undefined = 按 hidden 处理
    expect(ledger[0]!.launchMode).toBe("render");
    expect(ledger[0]!.idleMs).toBe(600_000);
  });

  it("非法 launchMode 值仍降级 undefined（前向兼容不变）", async () => {
    await fs.writeFile(
      ledgerPath,
      JSON.stringify([{ port: 9227, pid: 1, profileDir: "/x", launchedAt: 1, status: "ready", launchMode: "daily" }]),
      "utf8",
    );
    expect(readLedgerSync()[0]!.launchMode).toBeUndefined();
  });
});

describe("chrome-stop render 收割（渲染档设计决议 3.4/3.5）", () => {
  /** 建 render 记录 + 真实临时 profile 目录（rmSync 真实断言用）。 */
  async function makeRenderRec(overrides: Partial<LaunchedChromeRecord> = {}): Promise<string> {
    const profileDir = path.join(
      tmpDir,
      `render-chrome-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.mkdir(path.join(profileDir, "Default"), { recursive: true });
    await fs.writeFile(path.join(profileDir, "Default", "Preferences"), "{}");
    await recordLaunch(makeRec({ launchMode: "render", profileDir, ...overrides }));
    return profileDir;
  }

  it("killed（归属验证通过）→ render profile 连带 rmSync；台账清空", async () => {
    const profileDir = await makeRenderRec({ pid: 8101 });
    let alive = true;
    const r = await stopLaunchedChromes({
      aliveFn: () => alive,
      psFn: () => `chrome --user-data-dir=${profileDir}`,
      killTreeFn: () => {},
      sleepFn: async () => {
        alive = false;
      },
    });
    expect(r.stopped[0]!.action).toBe("killed");
    await expect(fs.stat(profileDir)).rejects.toThrow();
    expect(readLedgerSync()).toEqual([]);
  });

  it("already_dead → render profile 连带 rmSync（收尸路径；设计决议 3.6）", async () => {
    const profileDir = await makeRenderRec({ pid: 8102 });
    const r = await stopLaunchedChromes({ aliveFn: () => false, killTreeFn: () => {} });
    expect(r.stopped[0]!.action).toBe("already_dead");
    await expect(fs.stat(profileDir)).rejects.toThrow();
    expect(readLedgerSync()).toEqual([]);
  });

  it("pid_reused_skipped → 只清账不删 profile（无法确认无主；doctor 24h 扫描兜底）", async () => {
    const profileDir = await makeRenderRec({ pid: 8103 });
    const k = recorder();
    const r = await stopLaunchedChromes({
      aliveFn: () => true,
      psFn: () => "/Applications/Safari.app/Contents/MacOS/Safari",
      killTreeFn: k.fn,
    });
    expect(r.stopped[0]!.action).toBe("pid_reused_skipped");
    expect(k.calls).toHaveLength(0);
    expect(readLedgerSync()).toEqual([]);
    await expect(fs.stat(profileDir)).resolves.toBeTruthy(); // profile 保留
  });

  it("日常档（hidden/visible）killed → profile 不删（持久 profile 是设计）", async () => {
    const profileDir = path.join(tmpDir, "chrome-profile-daily");
    await fs.mkdir(profileDir, { recursive: true });
    await recordLaunch(makeRec({ pid: 8104, launchMode: "hidden", profileDir }));
    let alive = true;
    const r = await stopLaunchedChromes({
      aliveFn: () => alive,
      psFn: () => `chrome --user-data-dir=${profileDir}`,
      killTreeFn: () => {},
      sleepFn: async () => {
        alive = false;
      },
    });
    expect(r.stopped[0]!.action).toBe("killed");
    await expect(fs.stat(profileDir)).resolves.toBeTruthy();
  });

  it("basename 前缀守卫：render 记录 profileDir 无 render-chrome-profile- 前缀 → 拒删（rmSync 归属红线）", async () => {
    const profileDir = path.join(tmpDir, "some-user-dir");
    await fs.mkdir(profileDir, { recursive: true });
    await recordLaunch(makeRec({ pid: 8105, launchMode: "render", profileDir }));
    const r = await stopLaunchedChromes({ aliveFn: () => false, killTreeFn: () => {} });
    expect(r.stopped[0]!.action).toBe("already_dead");
    await expect(fs.stat(profileDir)).resolves.toBeTruthy(); // 拒删
    expect(readLedgerSync()).toEqual([]);
  });

  it("stopLaunchedChromesSync：already_dead render → profile 同步连带清理（sync 路径）", async () => {
    const profileDir = await makeRenderRec({ pid: 8106 });
    const r = stopLaunchedChromesSync();
    expect(r.stopped[0]!.action).toBe("already_dead");
    await expect(fs.stat(profileDir)).rejects.toThrow();
    expect(readLedgerSync()).toEqual([]);
  });

  it("modes 过滤三值：--modes render 只收 render；--modes hidden 不动 render", async () => {
    const renderProfile = await makeRenderRec({ port: 9224, pid: 8201 });
    const hiddenProfile = path.join(tmpDir, "chrome-profile-hidden");
    await fs.mkdir(hiddenProfile, { recursive: true });
    await recordLaunch(makeRec({ port: 9225, pid: 8202, launchMode: "hidden", profileDir: hiddenProfile }));

    // --modes hidden：render 记录不动（精确匹配不命中）
    const rHidden = await stopLaunchedChromes({
      modes: ["hidden"],
      aliveFn: () => false,
      killTreeFn: () => {},
    });
    expect(rHidden.stopped.map((s) => s.port)).toEqual([9225]);
    await expect(fs.stat(renderProfile)).resolves.toBeTruthy();
    expect(readLedgerSync().map((x) => x.port)).toEqual([9224]);

    // --modes render：收 render + 连带 profile
    const rRender = await stopLaunchedChromes({
      modes: ["render"],
      aliveFn: () => false,
      killTreeFn: () => {},
    });
    expect(rRender.stopped.map((s) => s.port)).toEqual([9224]);
    await expect(fs.stat(renderProfile)).rejects.toThrow();
    expect(readLedgerSync()).toEqual([]);
  });

  it("chrome-stop.ts 的 render 前缀镜像与 src/render/render-flags.ts 真源一致（tripwire）", () => {
    const stopSrc = readFileSync(
      new URL("../../src/launcher/chrome-stop.ts", import.meta.url),
      "utf8",
    );
    expect(stopSrc).toContain('const RENDER_PROFILE_BASENAME_PREFIX = "render-chrome-profile-";');
  });
});
