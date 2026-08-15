/**
 * subprocess-idle-watchdog.spec.ts（v1.9 parse17 §7.1 机制一，例 1-10）
 *
 * 守护 headless idle watchdog 契约：
 *  1. cleanupZombies(300000)：lastUsedAt 6min 前 → _kill + 树杀发出（killTreeSync mock 断言 pid）
 *  2. lastUsedAt 1min 前 → 不杀
 *  3. touch() 后阈值重算（touch 重置 lastUsedAt → 不杀）
 *  4. _kill：client.close() reject 仍树杀（close 失败不阻断 SIGKILL）
 *  5. _kill 幂等：二次调用 no-op（killTreeSync 只发一次）
 *  6. reap hook：回收前被调 + 3s 超时上界生效（hook 挂起 → reaper 不死等）
 *  7. reap hook 抛错 → warn 不阻断 _kill
 *  8. setReapHook(null) 恢复零行为
 *  9. LASSO_HEADLESS_IDLE_MS 解析（0 / 负数 / NaN / 默认 / env 与 config 文件两来源）
 * 10. rustProcs 不受 cleanupZombies 影响（既有行为回归锚）
 *
 * 测试策略：vi.mock util/kill-tree.js（树杀原语 mock；不真 spawn pgrep——本 spec 断言
 * 的是 SubprocessManager 的调度/接线契约，树杀原语本身由 subprocess-lifecycle.spec.ts
 * 真实进程验证）。procs 私有 map 直接注入伪 ManagedProc（client 只需 pid + close）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/util/kill-tree.js", () => ({
  killTreeSync: vi.fn(),
}));

import { killTreeSync } from "../../src/util/kill-tree.js";
import { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import {
  loadConfig,
  DEFAULT_HEADLESS_IDLE_MS,
} from "../../src/config/config.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const killTreeMock = vi.mocked(killTreeSync);

/** 直接往私有 procs map 注入伪 ManagedProc（spec 内白盒；不真 spawn MCP）。 */
function injectProc(
  mgr: SubprocessManager,
  name: string,
  pid: number,
  lastUsedAtOffsetMs: number,
  closeImpl?: () => Promise<void>,
): void {
  (mgr as unknown as {
    procs: Map<
      string,
      {
        client: { pid: number | null; close: () => Promise<void> };
        spawnedAt: number;
        lastUsedAt: number;
        restartCount: number;
        closed: boolean;
      }
    >;
  }).procs.set(name, {
    client: {
      pid,
      close: closeImpl ?? (async () => {}),
    },
    spawnedAt: Date.now() - lastUsedAtOffsetMs,
    lastUsedAt: Date.now() - lastUsedAtOffsetMs,
    restartCount: 0,
    closed: false,
  });
}

/** 读私有 procs map（断言存活用）。 */
function procNames(mgr: SubprocessManager): string[] {
  return Array.from(
    (mgr as unknown as { procs: Map<string, unknown> }).procs.keys(),
  );
}

describe("SubprocessManager — v1.9 idle watchdog（parse17 机制一）", () => {
  beforeEach(() => {
    killTreeMock.mockClear();
  });

  it("cleanupZombies(300000)：lastUsedAt 6min 前 → _kill + killTreeSync(pid) 发出", async () => {
    const mgr = new SubprocessManager();
    injectProc(mgr, "headless", 4242, 6 * 60_000);
    await mgr.cleanupZombies(300_000);
    expect(procNames(mgr)).not.toContain("headless");
    expect(killTreeMock).toHaveBeenCalledWith(4242, "headless");
  });

  it("lastUsedAt 1min 前 → 不杀（procs 保留 + killTreeSync 未被调）", async () => {
    const mgr = new SubprocessManager();
    injectProc(mgr, "headless", 4343, 60_000);
    await mgr.cleanupZombies(300_000);
    expect(procNames(mgr)).toContain("headless");
    expect(killTreeMock).not.toHaveBeenCalled();
  });

  it("touch() 后阈值重算：旧 lastUsedAt 被 touch 刷新 → 不杀", async () => {
    const mgr = new SubprocessManager();
    injectProc(mgr, "headless", 4444, 10 * 60_000); // 早已超阈值
    mgr.touch("headless"); // 长调用保活（BrowseChannel 每 action dispatch 调）
    await mgr.cleanupZombies(300_000);
    expect(procNames(mgr)).toContain("headless");
    expect(killTreeMock).not.toHaveBeenCalled();
    // touch 未知 spec / 已 closed → no-op 不抛
    expect(() => mgr.touch("nonexistent")).not.toThrow();
  });

  it("_kill 树杀路径：client.close() reject 仍树杀（close 失败不阻断 SIGKILL）", async () => {
    const mgr = new SubprocessManager();
    injectProc(
      mgr,
      "headless",
      4545,
      6 * 60_000,
      async () => {
        throw new Error("close_hang");
      },
    );
    await expect(mgr.cleanupZombies(300_000)).resolves.not.toThrow();
    expect(killTreeMock).toHaveBeenCalledWith(4545, "headless");
    expect(procNames(mgr)).not.toContain("headless");
  });

  it("_kill 幂等：closed 标记后二次调用 no-op（killTreeSync 只发一次）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headless", {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@0.3.0"],
      mcpClientName: "lasso-browse-headless",
    });
    injectProc(mgr, "headless", 4646, 6 * 60_000);
    await mgr.shutdownOne("headless");
    await mgr.shutdownOne("headless"); // 二次（procs 已删 → no-op）
    expect(killTreeMock).toHaveBeenCalledTimes(1);
    expect(killTreeMock).toHaveBeenCalledWith(4646, "headless");
  });

  it("reap hook：回收前被调（3s 内返回）+ 超时上界生效（挂起 hook → reaper 不死等）", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new SubprocessManager();
      const seen: string[] = [];
      mgr.setReapHook(async (name) => {
        seen.push(name);
      });
      injectProc(mgr, "logged_in:default", 4747, 6 * 60_000);
      const p = mgr.cleanupZombies(300_000);
      await vi.advanceTimersByTimeAsync(0);
      // 快速返回的 hook：kill 已发生
      await p;
      expect(seen).toEqual(["logged_in:default"]);
      expect(killTreeMock).toHaveBeenCalledWith(4747, "logged_in:default");

      // 挂起 hook：3s race 上界放行（reaper 不死等）
      killTreeMock.mockClear();
      mgr.setReapHook(() => new Promise<void>(() => {})); // 永不 resolve
      injectProc(mgr, "headless", 4848, 6 * 60_000);
      const p2 = mgr.cleanupZombies(300_000);
      await vi.advanceTimersByTimeAsync(3_100);
      await p2;
      expect(killTreeMock).toHaveBeenCalledWith(4848, "headless");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reap hook 抛错 → warn 不阻断 _kill", async () => {
    const mgr = new SubprocessManager();
    mgr.setReapHook(async () => {
      throw new Error("tab_restore_failed");
    });
    injectProc(mgr, "logged_in:default", 4949, 6 * 60_000);
    await expect(mgr.cleanupZombies(300_000)).resolves.not.toThrow();
    expect(killTreeMock).toHaveBeenCalledWith(4949, "logged_in:default");
  });

  it("setReapHook(null) 恢复零行为（不调 hook 直接 kill）", async () => {
    const mgr = new SubprocessManager();
    const hook = vi.fn(async () => {});
    mgr.setReapHook(hook);
    mgr.setReapHook(null);
    injectProc(mgr, "headless", 5050, 6 * 60_000);
    await mgr.cleanupZombies(300_000);
    expect(hook).not.toHaveBeenCalled();
    expect(killTreeMock).toHaveBeenCalledWith(5050, "headless");
  });

  it("startZombieReaper timer unref（不阻止进程退出）+ 重复调用覆盖旧 timer", () => {
    const mgr = new SubprocessManager();
    mgr.startZombieReaper(60_000, 300_000);
    const t1 = (mgr as unknown as { zombieTimer: NodeJS.Timeout }).zombieTimer;
    expect(t1).not.toBeNull();
    expect(t1!.hasRef()).toBe(false);
    mgr.startZombieReaper(60_000, 60_000); // 覆盖
    const t2 = (mgr as unknown as { zombieTimer: NodeJS.Timeout }).zombieTimer;
    expect(t2).not.toBe(t1);
    mgr.shutdown(); // 清 timer（防 spec 间泄漏）
  });

  it("rustProcs 不受 cleanupZombies 影响（MCP-only 回收；既有行为回归锚）", async () => {
    const mgr = new SubprocessManager();
    (mgr as unknown as {
      rustProcs: Map<string, unknown>;
    }).rustProcs.set("rust-helper", {
      proc: { pid: 99999 },
      spawnedAt: Date.now() - 10 * 60_000,
      lastUsedAt: Date.now() - 10 * 60_000,
      restartCount: 0,
      closed: false,
    });
    await mgr.cleanupZombies(300_000);
    expect(
      (mgr as unknown as { rustProcs: Map<string, unknown> }).rustProcs.has(
        "rust-helper",
      ),
    ).toBe(true);
    expect(killTreeMock).not.toHaveBeenCalled();
  });
});

describe("LASSO_HEADLESS_IDLE_MS 解析（parse17 §2.2 (a)）", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-idle-cfg-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("未设 → 默认 300_000（5min）", () => {
    const c = loadConfig({ runId: "t", env: { LASSO_CONFIG_PATH: path.join(tmpDir, "none.json") } });
    expect(c.headlessIdleMs).toBe(DEFAULT_HEADLESS_IDLE_MS);
    expect(DEFAULT_HEADLESS_IDLE_MS).toBe(300_000);
  });

  it("env LASSO_HEADLESS_IDLE_MS=0 → 0（禁用语义）", () => {
    const c = loadConfig({
      runId: "t",
      env: {
        LASSO_CONFIG_PATH: path.join(tmpDir, "none.json"),
        LASSO_HEADLESS_IDLE_MS: "0",
      },
    });
    expect(c.headlessIdleMs).toBe(0);
  });

  it("负数 / NaN → 回退默认", () => {
    for (const bad of ["-1000", "abc"]) {
      const c = loadConfig({
        runId: "t",
        env: {
          LASSO_CONFIG_PATH: path.join(tmpDir, "none.json"),
          LASSO_HEADLESS_IDLE_MS: bad,
        },
      });
      expect(c.headlessIdleMs).toBe(300_000);
    }
  });

  it("config 文件来源也生效（file base → env 覆盖）+ 显式 3600000 透传", async () => {
    const cfgPath = path.join(tmpDir, "config.json");
    await fs.writeFile(cfgPath, JSON.stringify({ LASSO_HEADLESS_IDLE_MS: 7_200_000 }), "utf8");
    // file 只（env 未设）
    const c1 = loadConfig({ runId: "t", env: { LASSO_CONFIG_PATH: cfgPath } });
    expect(c1.headlessIdleMs).toBe(7_200_000);
    // env 覆盖 file
    const c2 = loadConfig({
      runId: "t",
      env: { LASSO_CONFIG_PATH: cfgPath, LASSO_HEADLESS_IDLE_MS: "1" },
    });
    expect(c2.headlessIdleMs).toBe(1);
  });
});
