/**
 * subprocess-lifecycle.spec.ts（v1.8 Phase B：W1-DEF-6 + W1-DEF-9）
 *
 * 守护 SubprocessManager / RustBridge 的停机与 spawn 失败接线：
 *  1. W1-DEF-6：spawn 后 shutdown() → 子进程真实退出（无孤儿，wave1 T-BROWSE-24）
 *  2. W1-DEF-6：killAllSync()（process.on("exit") 兜底钩子用）→ 同步 SIGKILL 残留 pid
 *  3. W1-DEF-9：spawn 不存在路径（ENOENT）→ RustBridge.call 快速 reject
 *     且归因 rust_helper_crashed:subproc_spawn_failed（不再烧满 3s 超时）
 *  4. W1-DEF-9：manager 侧 proc.on("error") 标 closed（下次 ensureRustRunning 重 spawn）
 *
 * 测试策略：真实 child_process.spawn（/bin/sleep 与 /nonexistent 路径），
 * 不 mock SubprocessManager——W1-DEF-6 断言的是真实进程退出，mock 无意义。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import { RustBridge } from "../../src/subprocess/RustBridge.js";

/** 判定 pid 是否仍存活（signal 0 探测）。 */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询等 pid 退出（最多 waitMs；SIGTERM 异步生效需要一点时间）。 */
async function waitExited(pid: number | undefined, waitMs = 3000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

describe("SubprocessManager — W1-DEF-6 孤儿清理", () => {
  it("spawn 后 shutdown() → Rust 子进程真实退出（kill 链路通，不抛）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerRustSpec("lifecycle-test-helper", {
      command: "/bin/sleep",
      args: ["30"],
    });
    const proc = await mgr.ensureRustRunning("lifecycle-test-helper");
    expect(isAlive(proc.pid)).toBe(true);

    await expect(mgr.shutdown()).resolves.not.toThrow();
    const exited = await waitExited(proc.pid);
    expect(exited).toBe(true); // 无孤儿
  });

  it("spawn 后 killAllSync() → 同步 SIGKILL，子进程立即死（exit 钩子路径）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerRustSpec("lifecycle-test-helper-2", {
      command: "/bin/sleep",
      args: ["30"],
    });
    const proc = await mgr.ensureRustRunning("lifecycle-test-helper-2");
    expect(isAlive(proc.pid)).toBe(true);

    expect(() => mgr.killAllSync()).not.toThrow(); // exit 钩子必须同步零异常
    // SIGKILL 同步生效；给调度器一小窗（防极端慢机 flaky）
    const exited = await waitExited(proc.pid, 1000);
    expect(exited).toBe(true);
  });

  it("killAllSync 幂等：空 manager / 重复调用零异常", () => {
    const mgr = new SubprocessManager();
    expect(() => mgr.killAllSync()).not.toThrow();
    expect(() => mgr.killAllSync()).not.toThrow();
  });

  it("killAllSync 后 listManagedPids 不再列已 kill 的 pid", async () => {
    const mgr = new SubprocessManager();
    mgr.registerRustSpec("lifecycle-test-helper-3", {
      command: "/bin/sleep",
      args: ["30"],
    });
    await mgr.ensureRustRunning("lifecycle-test-helper-3");
    expect(mgr.listManagedPids().length).toBe(1);
    mgr.killAllSync();
    expect(mgr.listManagedPids().length).toBe(0);
    await mgr.shutdown();
  });
});

describe("RustBridge / SubprocessManager — W1-DEF-9 spawn error 接线", () => {
  it("spawn ENOENT：call 快速 reject 且归因 rust_helper_crashed:subproc_spawn_failed（不烧超时）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerRustSpec("enoent-helper", {
      command: "/nonexistent/lasso-rust-helper-path",
    });
    const bridge = new RustBridge(mgr, "enoent-helper");

    const started = Date.now();
    await expect(bridge.call("ping", {}, 3000)).rejects.toThrow(
      /rust_helper_crashed:subproc_spawn_failed/,
    );
    const elapsed = Date.now() - started;
    // 归因正确 + 显著快于 3s 超时（wave1 实锤是烧满 rust_call_timeout）
    expect(elapsed).toBeLessThan(1500);
    expect(bridge.pendingCount()).toBe(0);
    await mgr.shutdown();
  }, 10_000);

  it("spawn ENOENT：manager 侧标 closed → 再次 call 仍走 spawn 路径（不卡死）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerRustSpec("enoent-helper-2", {
      command: "/nonexistent/lasso-rust-helper-path",
    });
    const bridge = new RustBridge(mgr, "enoent-helper-2");
    await expect(bridge.call("ping", {}, 3000)).rejects.toThrow(
      /rust_helper_crashed/,
    );
    // 第二次调用：proc=null → ensureStarted 重 spawn → 同样快速失败（不死循环 / 不挂起）
    await expect(bridge.call("ping", {}, 3000)).rejects.toThrow(
      /rust_helper_crashed/,
    );
    await mgr.shutdown();
  }, 10_000);
});

describe("index.ts 停机接线（源码级断言；W1-DEF-6 + D5）", () => {
  const indexSrc = readFileSync(
    fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    "utf8",
  );

  it("W1-DEF-6：SIGTERM/SIGINT 优雅路径后挂 process.on(\"exit\") → subproc.killAllSync() 兜底", () => {
    expect(indexSrc).toMatch(/process\.on\("exit"/);
    expect(indexSrc).toMatch(/subproc\.killAllSync\(\)/);
    // 优雅路径仍在（SIGTERM/SIGINT → subproc.shutdown()）
    expect(indexSrc).toMatch(/await subproc\.shutdown\(\)/);
  });

  it("D5：停机路径调 steelChannel.releaseSession()（best-effort，失败仅 warn 不阻断退出）", () => {
    expect(indexSrc).toMatch(/if \(steelChannel\) \{/);
    expect(indexSrc).toMatch(/await steelChannel\.releaseSession\(\)/);
    // best-effort：releaseSession 外层 try/catch（吞错不阻断 process.exit）
    expect(indexSrc).toMatch(/steel_release_on_shutdown_failed/);
  });
});
