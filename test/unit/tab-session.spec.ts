/**
 * tab-session.spec.ts（v1.9 parse17 §7.1 机制三，例 19-26）
 *
 * 守护 TabSession 快照+diff 恢复契约（红线：绝不关闭用户原有的任何 tab）：
 *  19. takeSnapshotIfAbsent 只调一次 /json/list（二次 no-op）
 *  20. restore：快照 [A,B]，当前 [A,B,C,D] → 只关 C/D（断言 close 入参不含 A/B——红线核心）
 *  21. CDP 不可达 → {ok:false, reason:"cdp_unreachable"} 不 throw
 *  22. 快照 url 与当前 url 零交集（Chrome 重启形态）→ browser_restarted 守卫放弃（closeFn 零调用）
 *  23. diff > 32 → diff_too_large 放弃
 *  24. /json/close 单个失败 → fallback Target.closeTarget 被调（closeFn 主路径返 false 场景）
 *  25. restore 成功后 snapshot 置 null（再 restore → no_snapshot）
 *  26. 非 page 类型 target（background_page 等）不进快照不打 diff
 *
 * 测试策略：fetchFn / closeFn 全注入 mock（不真连 CDP；真机 acceptance 留
 * parse17-acceptance A6-A8）。
 */
import { describe, it, expect } from "vitest";
import { TabSession } from "../../src/logged-in/TabSession.js";

/** /json/list 的 target 原始形状（Chrome DevTools HTTP 端点）。 */
interface RawTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
}

/** 造 mock fetchFn：/json/list 返 targets；/json/close/<id> 按 closeOk 谓词。 */
function makeFetch(opts: {
  targets: RawTarget[];
  closeOk?: (targetId: string) => boolean;
}): {
  fetchFn: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  state: { listCalls: number; closeCalls: string[] };
} {
  const state = { listCalls: 0, closeCalls: [] as string[] };
  const fetchFn = async (url: string) => {
    if (url.endsWith("/json/list")) {
      state.listCalls++;
      return { ok: true, json: async () => opts.targets };
    }
    const m = url.match(/\/json\/close\/(.+)$/);
    if (m) {
      state.closeCalls.push(m[1]!);
      const ok = opts.closeOk ? opts.closeOk(m[1]!) : true;
      return { ok, json: async () => ({}) };
    }
    throw new Error(`unexpected_url:${url}`);
  };
  // 返回 state 引用（非展开拷贝）——listCalls/closeCalls 是实时计数
  return { fetchFn, state };
}

/** closeFn recorder（fallback Target.closeTarget mock）。 */
function makeCloseFn(ok = true): {
  closeFn: (targetId: string) => Promise<boolean>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    closeFn: async (targetId: string) => {
      calls.push(targetId);
      return ok;
    },
    calls,
  };
}

const SNAP: RawTarget[] = [
  { id: "A", type: "page", url: "https://user-startpage.example/" },
  { id: "B", type: "page", url: "https://mail.example/" },
];

describe("TabSession —— 快照（parse17 §4.2）", () => {
  it("takeSnapshotIfAbsent 只调一次 /json/list（二次 no-op）", async () => {
    const f = makeFetch({ targets: SNAP });
    const s = new TabSession(9222, { fetchFn: f.fetchFn });
    expect(s.hasSnapshot()).toBe(false);
    await s.takeSnapshotIfAbsent();
    await s.takeSnapshotIfAbsent(); // 二次 no-op
    expect(f.state.listCalls).toBe(1);
    expect(s.hasSnapshot()).toBe(true);
  });

  it("快照失败（CDP 不可达）→ warn 放弃不 throw；下次 takeSnapshotIfAbsent 重试", async () => {
    let fail = true;
    const fetchFn = async () => {
      if (fail) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => SNAP };
    };
    const s = new TabSession(9222, { fetchFn });
    await expect(s.takeSnapshotIfAbsent()).resolves.not.toThrow();
    expect(s.hasSnapshot()).toBe(false);
    fail = false;
    await s.takeSnapshotIfAbsent();
    expect(s.hasSnapshot()).toBe(true);
  });

  it("非 page 类型 target 不进快照不打 diff（background_page / iframe / worker）", async () => {
    // 可变 targets：快照时 [A,B,W(background_page),I(iframe)]；恢复时 [A,B,D(page),W2(worker)]
    // → 只关 page diff D（W/I 不进快照不制造假 diff；W2 不进 diff）
    let currentTargets: RawTarget[] = [
      ...SNAP,
      { id: "W", type: "background_page", url: "chrome-extension://x/_generated_background_page.html" },
      { id: "I", type: "iframe", url: "https://embed.example/" },
    ];
    const closeCalls: string[] = [];
    const mainCloseCalls: string[] = [];
    const s = new TabSession(9222, {
      fetchFn: async (url) => {
        if (url.endsWith("/json/list")) {
          return { ok: true, json: async () => currentTargets };
        }
        const m = url.match(/\/json\/close\/(.+)$/);
        if (m) mainCloseCalls.push(m[1]!);
        return { ok: false, json: async () => ({}) };
      },
      closeFn: async (targetId: string) => {
        closeCalls.push(targetId);
        return true;
      },
    });
    await s.takeSnapshotIfAbsent();
    currentTargets = [
      ...SNAP,
      { id: "D", type: "page", url: "https://new.example/" },
      { id: "W2", type: "worker", url: "https://worker.example/" },
    ];
    const r = await s.restore();
    expect(r.ok).toBe(true);
    expect(r.closed).toEqual(["D"]);
    // 主路径试了 D（返 false）→ fallback 也只对 D 发起——page 类型 diff 唯一
    expect(mainCloseCalls).toEqual(["D"]);
    expect(closeCalls).toEqual(["D"]);
  });
});

describe("TabSession —— 恢复（红线：绝不关用户原有 tab）", () => {
  it("快照 [A,B] 当前 [A,B,C,D] → 只关 C/D（close 入参不含 A/B——红线核心用例）", async () => {
    const close = makeCloseFn();
    // 可变 targets mock：快照时 [A,B]，恢复时 [A,B,C,D]（主路径 /json/close 全失败
    // → fallback closeFn 可观测）
    let currentTargets: RawTarget[] = [...SNAP];
    const s = new TabSession(9222, {
      fetchFn: async (url) => {
        if (url.endsWith("/json/list")) {
          return { ok: true, json: async () => currentTargets };
        }
        return { ok: false, json: async () => ({}) }; // 主路径失败 → fallback closeFn
      },
      closeFn: close.closeFn,
    });
    await s.takeSnapshotIfAbsent(); // 快照 [A,B]
    currentTargets = [
      ...SNAP,
      { id: "C", type: "page", url: "https://lasso-opened-1.example/" },
      { id: "D", type: "page", url: "https://lasso-opened-2.example/" },
    ];
    const r = await s.restore();
    expect(r.ok).toBe(true);
    expect(r.closed.sort()).toEqual(["C", "D"]);
    // 红线断言：关闭入参绝不含快照内 target（用户原有 tab）
    expect(close.calls).not.toContain("A");
    expect(close.calls).not.toContain("B");
    expect(close.calls.sort()).toEqual(["C", "D"]);
  });

  it("CDP 不可达（list fetch 抛错/非 200）→ {ok:false, reason:'cdp_unreachable'} 不 throw + 零关闭", async () => {
    const close = makeCloseFn();
    // 先可达快照、后不可达恢复的时序（真实场景：browse 中 Chrome 被用户关闭）
    let down = false;
    const s = new TabSession(9222, {
      fetchFn: async () => {
        if (down) throw new Error("ECONNREFUSED");
        return { ok: true, json: async () => SNAP };
      },
      closeFn: close.closeFn,
    });
    await s.takeSnapshotIfAbsent();
    down = true;
    const r = await s.restore();
    expect(r).toMatchObject({ ok: false, reason: "cdp_unreachable", closed: [] });
    expect(close.calls).toHaveLength(0);
    // 不可达后快照保留（下次可重试）
    expect(s.hasSnapshot()).toBe(true);
  });

  it("快照 url 与当前 url 零交集（Chrome 重启形态）→ browser_restarted 放弃（closeFn 零调用）", async () => {
    const close = makeCloseFn();
    let currentTargets: RawTarget[] = [...SNAP];
    const s = new TabSession(9222, {
      fetchFn: async (url) => {
        if (url.endsWith("/json/list")) {
          return { ok: true, json: async () => currentTargets };
        }
        return { ok: true, json: async () => ({}) };
      },
      closeFn: close.closeFn,
    });
    await s.takeSnapshotIfAbsent();
    // Chrome 重启：全新 target id + 全新 url 集（与快照零交集）
    currentTargets = [
      { id: "X", type: "page", url: "https://fresh-1.example/" },
      { id: "Y", type: "page", url: "https://fresh-2.example/" },
    ];
    const r = await s.restore();
    expect(r).toMatchObject({ ok: false, reason: "browser_restarted", closed: [] });
    expect(close.calls).toHaveLength(0); // 宁少关不误关
  });

  it("diff > 32 → diff_too_large 放弃", async () => {
    const close = makeCloseFn();
    let currentTargets: RawTarget[] = [...SNAP];
    const s = new TabSession(9222, {
      fetchFn: async (url) => {
        if (url.endsWith("/json/list")) {
          return { ok: true, json: async () => currentTargets };
        }
        return { ok: true, json: async () => ({}) };
      },
      closeFn: close.closeFn,
    });
    await s.takeSnapshotIfAbsent();
    // 33 个新增（url 与快照有交集避免触发 browser_restarted 守卫）
    currentTargets = [
      ...SNAP,
      ...Array.from({ length: 33 }, (_, i) => ({
        id: `N${i}`,
        type: "page",
        url: i === 0 ? "https://mail.example/" : `https://new-${i}.example/`,
      })),
    ];
    const r = await s.restore();
    expect(r).toMatchObject({ ok: false, reason: "diff_too_large", closed: [] });
    expect(close.calls).toHaveLength(0);
  });

  it("/json/close 主路径失败 → fallback Target.closeTarget 被调（closeFn 返 true 计入 closed）", async () => {
    const close = makeCloseFn(true);
    let currentTargets: RawTarget[] = [...SNAP];
    const s = new TabSession(9222, {
      fetchFn: async (url) => {
        if (url.endsWith("/json/list")) {
          return { ok: true, json: async () => currentTargets };
        }
        return { ok: false, json: async () => ({}) }; // 主路径全失败
      },
      closeFn: close.closeFn,
    });
    await s.takeSnapshotIfAbsent();
    currentTargets = [
      ...SNAP,
      { id: "C", type: "page", url: "https://lasso-opened.example/" },
    ];
    const r = await s.restore();
    expect(r.ok).toBe(true);
    expect(r.closed).toEqual(["C"]);
    expect(close.calls).toEqual(["C"]);
  });

  it("restore 成功后 snapshot 置 null（再 restore → no_snapshot；下次附着重新快照）", async () => {
    let currentTargets: RawTarget[] = [...SNAP];
    const s = new TabSession(9222, {
      fetchFn: async (url) => {
        if (url.endsWith("/json/list")) {
          return { ok: true, json: async () => currentTargets };
        }
        return { ok: true, json: async () => ({}) };
      },
      closeFn: makeCloseFn().closeFn,
    });
    await s.takeSnapshotIfAbsent();
    expect(s.hasSnapshot()).toBe(true);
    const r1 = await s.restore();
    expect(r1.ok).toBe(true);
    expect(s.hasSnapshot()).toBe(false);
    const r2 = await s.restore();
    expect(r2).toMatchObject({ ok: false, reason: "no_snapshot" });
  });

  it("无快照直接 restore → no_snapshot（不触网不关 tab）", async () => {
    let listCalls = 0;
    const close = makeCloseFn();
    const s = new TabSession(9222, {
      fetchFn: async (url) => {
        if (url.endsWith("/json/list")) {
          listCalls++;
          return { ok: true, json: async () => SNAP };
        }
        return { ok: true, json: async () => ({}) };
      },
      closeFn: close.closeFn,
    });
    const r = await s.restore();
    expect(r).toMatchObject({ ok: false, reason: "no_snapshot" });
    expect(listCalls).toBe(0);
    expect(close.calls).toHaveLength(0);
  });
});
