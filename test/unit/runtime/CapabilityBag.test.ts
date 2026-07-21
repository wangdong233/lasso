/**
 * CapabilityBag 单元测（parse7 §3.1 + §5.2 ~14 用例）
 *
 * 覆盖：
 *  - constructor：初始所有 entry enabled=true（零回归 INV-40）
 *  - disable：状态变化 + audit 字段（disabledAt / disabledBy / reason）+ onChange 触发
 *  - enable：状态变化 + 清空 audit 字段 + onChange 触发
 *  - INV-36：未注册名 disable/enable 返 false（不凭空造）
 *  - register：热插拔新 name + 幂等（已存在 no-op）
 *  - unregister：移除 + 不存在 no-op
 *  - onChange：多 handler 顺序 await + 抛错隔离
 *  - isEnabled：未注册名默认 true（防 fallback 链误伤）
 *  - snapshot：返回新数组（防外部 mutate）
 *  - 多次 disable 幂等（已 disabled 返 false）
 */
import { describe, it, expect, vi } from "vitest";
import { CapabilityBag } from "../../../src/runtime/CapabilityBag.js";
import type { CapabilityState } from "../../../src/runtime/runtime-types.js";

describe("CapabilityBag — 构造 + 初始态", () => {
  it("constructor 初始化所有 entry enabled=true（INV-40 零回归）", () => {
    const bag = new CapabilityBag([
      "browse_headless",
      "browse_logged_in",
      "desktop",
      "search.brave",
      "desktop.cgEvent",
    ]);
    const snap = bag.snapshot();
    expect(snap).toHaveLength(5);
    for (const s of snap) {
      expect(s.enabled).toBe(true);
      expect(s.disabledAt).toBeUndefined();
      expect(s.disabledBy).toBeUndefined();
      expect(s.reason).toBeUndefined();
    }
  });

  it("constructor 按 name 含点判别 kind（channel vs provider）", () => {
    const bag = new CapabilityBag([
      "browse_headless",
      "search.brave",
      "desktop.cgEvent",
    ]);
    const snap = new Map(bag.snapshot().map((s) => [s.name, s]));
    expect(snap.get("browse_headless")?.kind).toBe("channel");
    expect(snap.get("search.brave")?.kind).toBe("provider");
    expect(snap.get("desktop.cgEvent")?.kind).toBe("provider");
  });

  it("constructor 接受空集合（boundary case）", () => {
    const bag = new CapabilityBag([]);
    expect(bag.snapshot()).toHaveLength(0);
    expect(bag.registeredNames()).toEqual([]);
  });
});

describe("CapabilityBag.disable — 状态变化 + audit + onChange", () => {
  it("disable 已注册 enabled channel → 返 true + 状态变 disabled + audit 字段填", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const ok = await bag.disable("browse_headless", {
      callerId: "test-caller",
      reason: "unit_test",
    });
    expect(ok).toBe(true);
    expect(bag.isEnabled("browse_headless")).toBe(false);
    const snap = bag.snapshot()[0];
    expect(snap.enabled).toBe(false);
    expect(snap.disabledBy).toBe("test-caller");
    expect(snap.reason).toBe("unit_test");
    expect(snap.disabledAt).toBeTypeOf("number");
  });

  it("disable 默认 disabledBy='admin'（不传 callerId）", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    await bag.disable("browse_headless");
    expect(bag.snapshot()[0].disabledBy).toBe("admin");
  });

  it("disable 未注册名 → 返 false + 不创建 state（INV-36 不凭空造）", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const ok = await bag.disable("nonexistent");
    expect(ok).toBe(false);
    expect(bag.has("nonexistent")).toBe(false);
    expect(bag.snapshot()).toHaveLength(1);
  });

  it("disable 已 disabled → 返 false（幂等）", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    await bag.disable("browse_headless");
    const ok = await bag.disable("browse_headless");
    expect(ok).toBe(false);
  });

  it("disable 触发 onChange handler（enabled=false）", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const handler = vi.fn();
    bag.onChange(handler);
    await bag.disable("browse_headless", { callerId: "test" });
    expect(handler).toHaveBeenCalledTimes(1);
    const [name, enabled, state] = handler.mock.calls[0];
    expect(name).toBe("browse_headless");
    expect(enabled).toBe(false);
    expect(state.enabled).toBe(false);
  });
});

describe("CapabilityBag.enable — 恢复 + 清 audit", () => {
  it("enable disabled entry → 返 true + 清空 audit 字段", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    await bag.disable("browse_headless", { callerId: "x", reason: "y" });
    const ok = await bag.enable("browse_headless");
    expect(ok).toBe(true);
    expect(bag.isEnabled("browse_headless")).toBe(true);
    const snap = bag.snapshot()[0];
    expect(snap.disabledAt).toBeUndefined();
    expect(snap.disabledBy).toBeUndefined();
    expect(snap.reason).toBeUndefined();
  });

  it("enable 未注册名 → 返 false（INV-36）", async () => {
    const bag = new CapabilityBag([]);
    const ok = await bag.enable("nonexistent");
    expect(ok).toBe(false);
    expect(bag.has("nonexistent")).toBe(false);
  });

  it("enable 已 enabled → 返 false（幂等）", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const ok = await bag.enable("browse_headless");
    expect(ok).toBe(false);
  });

  it("enable 触发 onChange handler（enabled=true）", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const handler = vi.fn();
    bag.onChange(handler);
    await bag.disable("browse_headless");
    await bag.enable("browse_headless");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][1]).toBe(true);
  });
});

describe("CapabilityBag.isEnabled — 未注册名默认 true", () => {
  it("未注册名返 true（防 fallback 链误伤）", () => {
    const bag = new CapabilityBag(["browse_headless"]);
    expect(bag.isEnabled("nonexistent")).toBe(true);
    expect(bag.isEnabled("browse_headless")).toBe(true);
  });

  it("disabled name 返 false", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    await bag.disable("browse_headless");
    expect(bag.isEnabled("browse_headless")).toBe(false);
  });
});

describe("CapabilityBag.register — 热插拔新 entry", () => {
  it("register 新 name → state 增 + enabled=true（INV-40 新 entry 也必 enabled）", () => {
    const bag = new CapabilityBag(["browse_headless"]);
    bag.register("search.brave");
    expect(bag.has("search.brave")).toBe(true);
    expect(bag.isEnabled("search.brave")).toBe(true);
    expect(bag.snapshot()).toHaveLength(2);
  });

  it("register 已存在 name → 幂等 no-op（不抛错）", () => {
    const bag = new CapabilityBag(["browse_headless"]);
    bag.register("browse_headless");
    expect(bag.snapshot()).toHaveLength(1);
  });

  it("register 后可 disable/enable", async () => {
    const bag = new CapabilityBag([]);
    bag.register("new_provider");
    expect(await bag.disable("new_provider")).toBe(true);
    expect(await bag.enable("new_provider")).toBe(true);
  });
});

describe("CapabilityBag.unregister — 移除 entry", () => {
  it("unregister 已存在 → 返 true + state 删", () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const ok = bag.unregister("browse_headless");
    expect(ok).toBe(true);
    expect(bag.has("browse_headless")).toBe(false);
    expect(bag.snapshot()).toHaveLength(0);
  });

  it("unregister 不存在 → 返 false（no-op）", () => {
    const bag = new CapabilityBag([]);
    const ok = bag.unregister("nonexistent");
    expect(ok).toBe(false);
  });

  it("unregister 不触发 onChange handler", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const handler = vi.fn();
    bag.onChange(handler);
    bag.unregister("browse_headless");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("CapabilityBag.onChange — 多 handler + 抛错隔离", () => {
  it("多 handler 顺序 await（按注册顺序）", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const order: string[] = [];
    bag.onChange(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("first");
    });
    bag.onChange(() => {
      order.push("second");
    });
    await bag.disable("browse_headless");
    expect(order).toEqual(["first", "second"]);
  });

  it("handler 抛错 → log warn 不阻断后续 handler", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const second = vi.fn();
    bag.onChange(() => {
      throw new Error("synthetic handler error");
    });
    bag.onChange(second);
    const ok = await bag.disable("browse_headless");
    // disable 仍成功（handler 错误隔离）
    expect(ok).toBe(true);
    // 第二个 handler 仍被调（错误不阻断链）
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe 函数可移除 handler", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const handler = vi.fn();
    const unsubscribe = bag.onChange(handler);
    unsubscribe();
    await bag.disable("browse_headless");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("CapabilityBag.snapshot — 不可变性", () => {
  it("snapshot 返回新数组（多次调用互不影响）", () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const s1 = bag.snapshot();
    const s2 = bag.snapshot();
    expect(s1).not.toBe(s2);
    expect(s1[0]).not.toBe(s2[0]);
  });

  it("snapshot 内部对象 mutate 不影响内部 state", () => {
    const bag = new CapabilityBag(["browse_headless"]);
    const s = bag.snapshot();
    s[0].enabled = false;
    expect(bag.isEnabled("browse_headless")).toBe(true);
  });
});

describe("CapabilityBag.registeredNames — 列表", () => {
  it("registeredNames 返回所有已注册 name（含 register 后的）", () => {
    const bag = new CapabilityBag(["a", "b"]);
    bag.register("c");
    expect(bag.registeredNames().sort()).toEqual(["a", "b", "c"]);
  });
});

describe("CapabilityBag.has — 存在性", () => {
  it("has 已注册名 → true", () => {
    const bag = new CapabilityBag(["browse_headless"]);
    expect(bag.has("browse_headless")).toBe(true);
  });

  it("has 未注册名 → false", () => {
    const bag = new CapabilityBag([]);
    expect(bag.has("nonexistent")).toBe(false);
  });
});

describe("CapabilityBag — 综合 disable→enable→disable 序列", () => {
  it("disable→enable→disable 序列：每次状态变化返 true，幂等返 false", async () => {
    const bag = new CapabilityBag(["browse_headless"]);
    expect(await bag.disable("browse_headless")).toBe(true); // enabled→disabled
    expect(await bag.disable("browse_headless")).toBe(false); // 幂等
    expect(await bag.enable("browse_headless")).toBe(true); // disabled→enabled
    expect(await bag.enable("browse_headless")).toBe(false); // 幂等
    expect(await bag.disable("browse_headless")).toBe(true); // enabled→disabled
  });
});
