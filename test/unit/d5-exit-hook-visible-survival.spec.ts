/**
 * D-5（v1.18，doc/governance/09-静默守则审计 verify §6）回归测试：
 * server exit 钩子（process.on("exit") → stopLaunchedChromesSync）无条件
 * SIGKILL 台账在案 Chrome——P1 v1.17.3 的 visible 豁免只修了优雅 shutdown
 * 路径，exit 钩子把用户 visible 登录窗口照杀（三次独立复现 + 服务端日志
 * name:"chrome-stop-exit" 归属实锤）。
 *
 * 修复：stopLaunchedChromesSync 增加 modes 过滤（与 async 版同款），
 * index.ts exit 钩子传 modes:["hidden"]——visible 档豁免，台账条目保留
 * （进程还活着，不能清账孤儿化）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordLaunch } from "../../src/launcher/chrome-ledger.js";
import type { LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";
import { stopLaunchedChromesSync } from "../../src/launcher/chrome-stop.js";

let tmpDir: string;

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 111,
    profileDir: "/tmp/lasso-chrome-profile-d5",
    launchedAt: Date.now(),
    status: "ready",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-d5-exit-hook-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "launched-chromes.json");
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("D-5 · exit 钩子 visible Chrome 生存（stopLaunchedChromesSync modes 过滤）", () => {
  it("1. modes:['hidden']：visible 记录不被杀、台账条目保留；hidden 记录照杀照清", async () => {
    await recordLaunch(makeRec({ port: 9222, pid: 111, launchMode: "visible" }));
    await recordLaunch(makeRec({ port: 9333, pid: 222, launchMode: "hidden" }));
    const killed: number[] = [];
    const psOf = (pid: number) =>
      `/Applications/Google Chrome --user-data-dir=/tmp/lasso-chrome-profile-d5 --remote-debugging-port=${pid === 111 ? 9222 : 9333}\n`;
    const r = stopLaunchedChromesSync({
      modes: ["hidden"],
      aliveFn: () => true,
      psFn: psOf,
      killTreeFn: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([222]); // 只杀 hidden
    expect(r.stopped.map((s) => s.port)).toEqual([9333]);
    // visible 条目保留在台账（进程活着；清账 = 孤儿化 chrome-stop 出口）
    const { readLedgerSync } = await import("../../src/launcher/chrome-ledger.js");
    expect(readLedgerSync().map((x) => x.port)).toEqual([9222]);
  });

  it("2. 缺省 modes 不过滤（CLI 显式操作 = 用户最高权限，语义不变）", async () => {
    await recordLaunch(makeRec({ port: 9222, pid: 111, launchMode: "visible" }));
    const killed: number[] = [];
    const r = stopLaunchedChromesSync({
      aliveFn: () => true,
      psFn: () => "/Applications/Google Chrome --user-data-dir=/tmp/lasso-chrome-profile-d5\n",
      killTreeFn: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([111]);
    expect(r.stopped[0]!.action).toBe("killed");
  });

  it("3. 缺省 launchMode 按 hidden 计（v1.9 老台账条目仍被 exit 收尾）", async () => {
    await recordLaunch(makeRec({ port: 9222, pid: 111 })); // 无 launchMode
    const killed: number[] = [];
    stopLaunchedChromesSync({
      modes: ["hidden"],
      aliveFn: () => true,
      psFn: () => "/Applications/Google Chrome --user-data-dir=/tmp/lasso-chrome-profile-d5\n",
      killTreeFn: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([111]);
  });

  it("4. 红线不变：pid 复用（cmdline 无归属标记）在 modes 命中时也绝不 kill", async () => {
    await recordLaunch(makeRec({ port: 9222, pid: 111, launchMode: "hidden" }));
    const killed: number[] = [];
    const r = stopLaunchedChromesSync({
      modes: ["hidden"],
      aliveFn: () => true,
      psFn: () => "/usr/sbin/some_unrelated_daemon --pid-file=/var/run/x.pid\n",
      killTreeFn: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([]);
    expect(r.stopped[0]!.action).toBe("pid_reused_skipped");
  });

  it("5. 源码锚点：index.ts exit 钩子传 modes:['hidden']（装配防回潮）", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toMatch(/stopLaunchedChromesSync\(\{ modes: \["hidden"\]/);
  });

  it("6. 源码锚点：同步版过滤与 async 版同款（launchMode ?? \"hidden\"）", () => {
    const src = readFileSync("src/launcher/chrome-stop.ts", "utf8");
    const syncBody = src.match(
      /export function stopLaunchedChromesSync[\s\S]*?\n\}/,
    );
    expect(syncBody).not.toBeNull();
    expect(syncBody![0]).toMatch(/opts\.modes[\s\S]{0,200}launchMode \?\? "hidden"/);
    // exit 钩子零 await 纪律不破（W1-DEF-6）
    expect(syncBody![0]).not.toMatch(/\bawait\b/);
  });
});
