/**
 * rust-bridge.spec.ts（parse4 §5.2 + §3.5.3）
 *
 * 守护 RustBridge 的协议帧解析（INV-7：本类负责，不下沉 SubprocessManager）：
 *  1. line buffer 半行累积：多次 data 事件拼成一行也能 dispatch
 *  2. id 关联：每个 Response 按其 id resolve 对应 Promise
 *  3. 默认 30s 超时：超时 reject "rust_call_timeout:<method>"
 *  4. crash 检测：proc.on("exit") 全部 pending reject "rust_helper_crashed"
 *  5. 协议错（非 JSON / 无 id）静默丢弃，不 reject 别的 pending
 *
 * 测试策略：用 node:stream PassThrough mock stdin/stdout，
 * 不拉真 Rust helper 进程。从 stdin 写入中提取 request id，
 * 回送匹配 id 的 Response（与真实协议同 shape）。
 */
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { RustBridge } from "../../src/subprocess/RustBridge.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { ChildProcess } from "node:child_process";

// ============================================================
// helpers
// ============================================================
/**
 * 造一个 mock ChildProcess：stdout / stdin 是 PassThrough，
 * 可主动 emit 'data' / 'exit' 事件。
 *
 * stdinWrites 收集所有写入（含半行 chunk），用于提取 request id
 * 做匹配回送（与真实协议 server 解析 request 同 shape）。
 */
function makeMockProc(): {
  proc: ChildProcess;
  stdout: PassThrough;
  stdin: PassThrough;
  stdinWrites: string[];
  emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stdinWrites: string[] = [];
  // 捕获所有 stdin 写入（整行 / 半行都收）
  stdin.on("data", (d: Buffer) => stdinWrites.push(d.toString()));
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const proc = {
    stdout,
    stdin,
    on: (event: string, fn: (...args: unknown[]) => void) => {
      if (event === "exit") {
        exitHandlers.push(fn as (code: number | null, signal: NodeJS.Signals | null) => void);
      }
    },
    pid: 12345,
  } as unknown as ChildProcess;
  return {
    proc,
    stdout,
    stdin,
    stdinWrites,
    emitExit: (code, signal = null) => {
      for (const h of exitHandlers) h(code, signal);
    },
  };
}

/** 造一个 mock SubprocessManager，ensureRustRunning 返回我们提供的 proc。 */
function makeMockSubproc(proc: ChildProcess): SubprocessManager {
  return {
    ensureRustRunning: vi.fn().mockResolvedValue(proc),
  } as unknown as SubprocessManager;
}

/**
 * 等到 ensureStarted 完成 + stdin 接收到 request（含 id）。
 * 返回 request 行的 id（与协议 server 同语义解析）。
 */
async function waitForRequest(stdinWrites: string[]): Promise<string> {
  // ensureStarted 异步：等几个 tick 让 spawn 完成 + call 写入 stdin
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
    if (stdinWrites.length > 0) {
      const blob = stdinWrites.join("");
      const lines = blob.split("\n").filter(Boolean);
      if (lines.length > 0) {
        try {
          const req = JSON.parse(lines[0]);
          if (typeof req.id === "string") return req.id;
        } catch {
          /* keep waiting */
        }
      }
    }
  }
  throw new Error("no request received on stdin within 10 ticks");
}

/** 一次性 emit 一行 Response 到 stdout，匹配 id。 */
function respond(stdout: PassThrough, id: string, payload: unknown): void {
  stdout.emit("data", Buffer.from(JSON.stringify({ id, ...payload }) + "\n"));
}

// ============================================================
// tests
// ============================================================
describe("RustBridge — 协议帧解析（INV-7 在本类）", () => {
  it("单行完整 chunk：正确 dispatch + resolve", async () => {
    const { proc, stdout, stdinWrites } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");

    const p = bridge.call("ping", {});
    const id = await waitForRequest(stdinWrites);
    respond(stdout, id, { ok: true, result: { pong: true } });

    const resp = await p;
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ pong: true });
  });

  it("半行累积：chunk1 半行 + chunk2 补齐 → 仍 dispatch", async () => {
    const { proc, stdout, stdinWrites } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");

    const p = bridge.call("ping", {});
    const id = await waitForRequest(stdinWrites);

    // 构造完整行，切成两半：chunk1 半行 + chunk2 补齐含 \n
    const fullLine = JSON.stringify({ id, ok: true, result: { pong: true } }) + "\n";
    const half = Math.floor(fullLine.length / 2);
    stdout.emit("data", Buffer.from(fullLine.slice(0, half)));
    stdout.emit("data", Buffer.from(fullLine.slice(half)));

    const resp = await p;
    expect(resp.ok).toBe(true);
  });

  it("多行单 chunk：一次 data 多个 Response 都 dispatch", async () => {
    const { proc, stdout, stdinWrites } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");

    const p1 = bridge.call("ping", {});
    const id1 = await waitForRequest(stdinWrites);
    // 第二个 request 可能在 p1 之后写入；多等一轮
    const p2 = bridge.call("tcc_status", {});
    // 等到 stdinWrites 有 2 条 request
    for (let i = 0; i < 10 && stdinWrites.join("").split("\n").filter(Boolean).length < 2; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const blob = stdinWrites.join("");
    const lines = blob.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const id2 = JSON.parse(lines[1]).id;

    // 两条 Response 一次发出
    const data = [
      JSON.stringify({ id: id1, ok: true, result: { pong: true } }),
      JSON.stringify({ id: id2, ok: true, result: { accessibility: true } }),
    ].join("\n") + "\n";
    stdout.emit("data", Buffer.from(data));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.result).toEqual({ accessibility: true });
  });

  it("Result 透传：result 字段原样到 resp.result", async () => {
    const { proc, stdout, stdinWrites } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");
    const payload = { a: 1, nested: { b: [true, "x"] } };
    const p = bridge.call("ax_snapshot", { app: "Finder" });
    const id = await waitForRequest(stdinWrites);
    respond(stdout, id, { ok: true, result: payload });
    const resp = await p;
    expect(resp.result).toEqual(payload);
  });
});

describe("RustBridge — 错误路径", () => {
  it("超时：超过 timeoutMs reject 'rust_call_timeout:<method>'", async () => {
    const { proc } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");
    const p = bridge.call("ping", {}, 50); // 50ms 超时
    await expect(p).rejects.toThrow(/rust_call_timeout:ping/);
    // 超时后 pending 清空
    expect(bridge.pendingCount()).toBe(0);
  });

  it("crash：proc exit 触发所有 pending reject 'rust_helper_crashed'", async () => {
    const { proc, stdinWrites, emitExit } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");
    const p1 = bridge.call("ping", {});
    const p2 = bridge.call("ax_snapshot", { app: "Finder" });
    // 等 call 都注册为 pending（不必等 stdin 实际写入；只要 pending 表有 2 条）
    for (let i = 0; i < 10 && bridge.pendingCount() < 2; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(bridge.pendingCount()).toBeGreaterThanOrEqual(2);
    // 触发 crash
    emitExit(1, "SIGTERM");
    await expect(p1).rejects.toThrow(/rust_helper_crashed/);
    await expect(p2).rejects.toThrow(/rust_helper_crashed/);
    expect(bridge.pendingCount()).toBe(0);
    void stdinWrites;
  });

  it("协议错（非 JSON 行）：静默丢弃，不 reject 别的 pending", async () => {
    const { proc, stdout, stdinWrites } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");
    const p = bridge.call("ping", {}, 2000);
    const id = await waitForRequest(stdinWrites);
    // 先发一行坏 JSON，再发好行
    stdout.emit("data", Buffer.from("not-a-json-line\n"));
    respond(stdout, id, { ok: true, result: { pong: true } });
    const resp = await p;
    expect(resp.ok).toBe(true);
  });

  it("Response 无 id 字段：丢弃，不抛（pending 仍等下一个）", async () => {
    const { proc, stdout, stdinWrites } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");
    const p = bridge.call("ping", {}, 2000);
    const id = await waitForRequest(stdinWrites);
    // 先发一个无 id 的 Response（应丢弃）
    stdout.emit("data", Buffer.from(JSON.stringify({ ok: true }) + "\n"));
    // 再发匹配 id 的 Response
    respond(stdout, id, { ok: true, result: { pong: true } });
    const resp = await p;
    expect(resp.ok).toBe(true);
  });
});

describe("RustBridge — 协议镜像（rust-helper/src/protocol.rs）", () => {
  it("Request shape = { id, method, params }（与 protocol.rs::Request 一致）", async () => {
    const { proc, stdinWrites } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");
    const p = bridge.call("ping", { foo: 1 });
    await waitForRequest(stdinWrites);

    const blob = stdinWrites.join("");
    const lines = blob.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const req = JSON.parse(lines[0]);
    expect(req).toHaveProperty("id");
    expect(typeof req.id).toBe("string");
    expect(req.id.length).toBeGreaterThan(0);
    expect(req.method).toBe("ping");
    expect(req.params).toEqual({ foo: 1 });
    // 不让 p 卡测试退出
    p.catch(() => undefined);
  });

  it("默认超时可 override：传短 timeoutMs 会触发", async () => {
    const { proc } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");
    // 不发响应，30ms 超时应触发
    const p = bridge.call("ping", {}, 30);
    await expect(p).rejects.toThrow(/rust_call_timeout:ping/);
  });

  it("未注册 method：response ok=false 时透传到 resp.ok", async () => {
    const { proc, stdout, stdinWrites } = makeMockProc();
    const bridge = new RustBridge(makeMockSubproc(proc), "rust-helper");
    const p = bridge.call("unknown_method", {});
    const id = await waitForRequest(stdinWrites);
    respond(stdout, id, {
      ok: false,
      error: "unknown_method",
      error_kind: "unknown_method",
    });
    const resp = await p;
    expect(resp.ok).toBe(false);
    expect(resp.error_kind).toBe("unknown_method");
  });
});
