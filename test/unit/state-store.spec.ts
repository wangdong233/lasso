/**
 * StateStore v0.3 单测（parse3 §5.1 + §3.3 + 09 §2.3 验收 5）
 *
 * 覆盖：
 *  - LRU 淘汰（129 插入 → 最老被踢）
 *  - MRU 提升（get 后再插 128 不踢它）
 *  - ALS 隔离 2 并发（withOperation 上下文独立）
 *  - StaleStateError cleanly fail
 *  - writeState 旧签名（v0.2 兼容）：磁盘双写 + 内存 LRU 同时命中
 *  - epoch 字段从 ALS 派生
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  StateStore,
  StaleStateError,
  withOperation,
  currentOperation,
  writeState,
  readState,
  setStateStoreContext,
  _resetStoreForTests,
  type StoredState,
} from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetStoreForTests();
  _resetRunIdForTests();
  setStateStoreContext({
    runId: newRunId(),
    cacheDir: (tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-ss-"))),
  });
});

afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ============================================================
// LRU
// ============================================================
describe("StateStore — LRU(128)", () => {
  it("写入 ≤ 128 条全部保留", () => {
    const ss = new StateStore();
    for (let i = 0; i < 128; i++) {
      ss.set(`id-${i}`, { n: i }, "browse_headless");
    }
    expect(ss.size()).toBe(128);
    expect(ss.get("id-0")).toBeDefined();
    expect(ss.get("id-127")).toBeDefined();
  });

  it("写入 129 条 → 最老的 id-0 被踢（LRU）", () => {
    const ss = new StateStore();
    for (let i = 0; i < 129; i++) {
      ss.set(`id-${i}`, { n: i }, "browse_headless");
    }
    expect(ss.size()).toBe(128);
    // id-0 是最老的，应该被踢
    expect(ss.get("id-0")).toBeUndefined();
    // id-1 还在
    expect(ss.get("id-1")).toBeDefined();
    // id-128 最新，也在
    expect(ss.get("id-128")).toBeDefined();
  });

  it("get 提升到 MRU：访问 id-0 后再插 128 条，id-0 仍存活", () => {
    const ss = new StateStore();
    // 插 128 条，id-0 是最老
    for (let i = 0; i < 128; i++) {
      ss.set(`id-${i}`, { n: i }, "browse_headless");
    }
    // 访问 id-0 → 提升到 MRU
    ss.get("id-0");
    // 再插 1 条新记录（id-128），应淘汰当前 LRU 首位（id-1，因为 id-0 已被提升）
    ss.set("id-128", { n: 128 }, "browse_headless");
    expect(ss.get("id-0")).toBeDefined(); // 被提升后未被踢
    expect(ss.get("id-1")).toBeUndefined(); // 真正的 LRU 被踢
  });

  it("同 stateId 再 set = 覆盖（不扩容）", () => {
    const ss = new StateStore();
    ss.set("id-X", { v: 1 }, "browse_headless");
    ss.set("id-X", { v: 2 }, "browse_headless");
    expect(ss.size()).toBe(1);
    const rec = ss.get("id-X") as StoredState<{ v: number }>;
    expect(rec.value.v).toBe(2);
  });

  it("resourceKey 正确写入", () => {
    const ss = new StateStore();
    ss.set("id-1", { x: 1 }, "browse_logged_in:9222:tabA");
    const rec = ss.get("id-1") as StoredState;
    expect(rec.resourceKey).toBe("browse_logged_in:9222:tabA");
  });
});

// ============================================================
// StaleStateError
// ============================================================
describe("StateStore — getOrThrow / StaleStateError", () => {
  it("过期 / 未知 stateId → throw StaleStateError（cleanly fail）", () => {
    const ss = new StateStore();
    expect(() => ss.getOrThrow("never-existed")).toThrow(StaleStateError);
  });

  it("StaleStateError 带正确的 name 标识", () => {
    const ss = new StateStore();
    try {
      ss.getOrThrow("unknown");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StaleStateError);
      expect((e as Error).name).toBe("StaleStateError");
      expect((e as Error).message).toContain("unknown");
    }
  });

  it("已知 stateId → getOrThrow 返回记录", () => {
    const ss = new StateStore();
    ss.set("id-ok", { v: 42 }, "browse_headless");
    const rec = ss.getOrThrow("id-ok") as StoredState<{ v: number }>;
    expect(rec.value.v).toBe(42);
  });
});

// ============================================================
// AsyncLocalStorage（ALS）
// ============================================================
describe("StateStore — AsyncLocalStorage 隔离", () => {
  it("withOperation 内部 currentOperation() 返回上下文", async () => {
    await withOperation("browse_headless:sess1", 5, async () => {
      const op = currentOperation();
      expect(op).toBeDefined();
      expect(op!.resourceId).toBe("browse_headless:sess1");
      expect(op!.epoch).toBe(5);
    });
  });

  it("withOperation 外部 currentOperation() === undefined", () => {
    expect(currentOperation()).toBeUndefined();
  });

  it("2 个并发 withOperation 互不串扰（隔离率 100%）", async () => {
    const observed: string[] = [];
    await Promise.all([
      withOperation("session-A", 1, async () => {
        // 让另一个 context 先跑一段
        await new Promise((r) => setTimeout(r, 5));
        observed.push(`A:${currentOperation()!.resourceId}`);
      }),
      withOperation("session-B", 2, async () => {
        await new Promise((r) => setTimeout(r, 15));
        observed.push(`B:${currentOperation()!.resourceId}`);
      }),
    ]);
    expect(observed).toEqual(
      expect.arrayContaining(["A:session-A", "B:session-B"]),
    );
    expect(observed).toHaveLength(2);
  });

  it("set 在 ALS 内时 epoch 从 OperationState.epoch+1 派生", async () => {
    await withOperation("browse_headless:sess1", 10, async () => {
      const ss = new StateStore();
      const rec = ss.set("id-1", { v: 1 }, "browse_headless:sess1");
      // ALS epoch=10 → StoredState.epoch = 11
      expect(rec.epoch).toBe(11);
    });
  });

  it("set 在 ALS 外时 epoch=1（fallback；ALS.epoch 默认 0）", () => {
    const ss = new StateStore();
    const rec = ss.set("id-1", { v: 1 }, "browse_headless");
    expect(rec.epoch).toBe(1);
  });

  it("set 后 ALS 上下文 stateId 被回写（便于复用检测）", async () => {
    await withOperation("browse_headless:sess1", 1, async () => {
      const ss = new StateStore();
      ss.set("reuse-me", { v: 1 }, "browse_headless:sess1");
      expect(currentOperation()!.stateId).toBe("reuse-me");
    });
  });

  it("嵌套 withOperation：内层覆盖外层", async () => {
    await withOperation("outer", 1, async () => {
      expect(currentOperation()!.resourceId).toBe("outer");
      await withOperation("inner", 2, async () => {
        expect(currentOperation()!.resourceId).toBe("inner");
        expect(currentOperation()!.epoch).toBe(2);
      });
      // 退出内层后恢复 outer
      expect(currentOperation()!.resourceId).toBe("outer");
    });
  });
});

// ============================================================
// v0.1/v0.2 兼容：writeState / readState
// ============================================================
describe("writeState / readState — v0.2 兼容 + 双写", () => {
  it("writeState 返回的路径文件真实存在 + JSON 含 channel/state_id", async () => {
    const p = await writeState("browse_headless", "abc-123", {
      url: "https://example.com/",
      preview: "hi",
    });
    const stat = await fs.stat(p);
    expect(stat.isFile()).toBe(true);
    const parsed = JSON.parse(await fs.readFile(p, "utf8"));
    expect(parsed.channel).toBe("browse_headless");
    expect(parsed.state_id).toBe("abc-123");
    expect(parsed.url).toBe("https://example.com/");
  });

  it("writeState 同时写入内存 LRU（StateStore.get 命中）", async () => {
    await writeState("browse_headless", "mem-1", { preview: "in-mem" });
    const ss = new StateStore();
    const rec = ss.get("mem-1") as StoredState<{ preview: string }> | undefined;
    expect(rec).toBeDefined();
    expect(rec!.value.preview).toBe("in-mem");
    // spillPath 指向磁盘文件
    expect(rec!.spillPath).toBeTruthy();
  });

  it("readState 读回 writeState 写入的内容", async () => {
    const p = await writeState("browse_headless", "rd-1", { x: 42 });
    const back = (await readState(p)) as { x: number; channel: string };
    expect(back.x).toBe(42);
    expect(back.channel).toBe("browse_headless");
  });

  it("writeState 资源键 = channel（便于后续 StateStore 反查）", async () => {
    await writeState("browse_logged_in", "rk-1", { x: 1 });
    const ss = new StateStore();
    const rec = ss.get("rk-1") as StoredState;
    expect(rec.resourceKey).toBe("browse_logged_in");
  });
});

// ============================================================
// StateStore — 类型安全（generic）
// ============================================================
describe("StateStore<T> — generic value", () => {
  it("typed value 正确保留", () => {
    interface MyData {
      url: string;
      title: string;
    }
    const ss = new StateStore<MyData>();
    ss.set("t-1", { url: "https://x.com/", title: "X" }, "browse_headless");
    const rec = ss.getOrThrow("t-1");
    expect(rec.value.url).toBe("https://x.com/");
    expect(rec.value.title).toBe("X");
  });
});
