/**
 * 错配机制级联回归测（doc/governance/10 §四「级联放大器总图」的可执行断言）
 *
 * 背景（doc/governance/10 enumerate.md）：多个「为不存在的威胁模型设计的守卫」互相惩罚，
 * 把一次环境事件放大成通道级封禁：
 *
 *   网络断 10min ──(每次 unknown)──► 长熔断×2 通道 open ──► bag.disable ──► 杀子进程
 *   spill 仓 64MiB 满 ──throw──► executor 抛错=unknown ──► 双熔断计数 ──► 喂长熔断
 *   DNS 抖动 ──► ssrf dns_failed ──► didnt 终答（不重试/不 fallback/零观测）
 *   慢站 chain ──► budget_exceeded ──► didnt ──► breaker 记「健康」（反向掩蔽）
 *
 * 本 spec 逐链构造失败风暴，断言修复后**不再级联**：
 *  - F1：SSRF DNS 瞬态 → unknown（可重试）+ 零 breaker 接触
 *  - F2a：DNS/timeout 风暴 ×20 → 长熔断不计数不开（bag 永不被 disable）
 *  - F2c：持续故障（429）开 → probe 成功 → onClose 联动恢复（恢复闭环）
 *  - F3：budget_exceeded=unknown → decider 记 FAILURE（不再假健康 recordSuccess）
 *  - F4：spill 仓打满 → LRU 淘汰不抛 → tool 不崩 → 熔断零污染
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { LongCircuitBreaker } from "../../src/fallback/LongCircuitBreaker.js";
import type { InteractResult } from "../../src/types.js";
import {
  applyOutputEnvelope,
  getTotalBytes,
  getEvictedCount,
  _resetForTests,
} from "../../src/util/output-envelope.js";
import { ssrfGuard, ssrfDenial } from "../../src/ssrf/ssrf-guard.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// ============================================================
// helpers
// ============================================================
const PLAN = {
  primary: "browse_headless",
  fallbacks: ["browse_logged_in"],
  cross_modal: false,
} as const;

function makeDecider() {
  const breakers = new Map<string, CircuitBreaker>();
  breakers.set("browse_headless", new CircuitBreaker());
  breakers.set("browse_logged_in", new CircuitBreaker());
  const onOpen = vi.fn(async () => {});
  const onClose = vi.fn(async () => {});
  const longBreakers = new Map<string, LongCircuitBreaker>();
  longBreakers.set(
    "browse_headless",
    new LongCircuitBreaker(10, 3_600_000, 3_600_000, onOpen, "browse_headless", onClose),
  );
  longBreakers.set(
    "browse_logged_in",
    new LongCircuitBreaker(10, 3_600_000, 3_600_000, onOpen, "browse_logged_in", onClose),
  );
  const decider = new FallbackDecider(breakers, null, longBreakers);
  return { decider, breakers, longBreakers, onOpen, onClose };
}

function unknownResult(error: string): InteractResult<null> {
  return {
    outcome: "unknown",
    data: null,
    served_by: "browse_headless",
    fallback_used: false,
    retrieval_method: "test",
    error,
  };
}

beforeEach(async () => {
  await _resetForTests();
});

// ============================================================
// 链 1：DNS 风暴 → 长熔断不计数不开（F2a）
// ============================================================
describe("级联链 1：TUN 断网 10 分钟的 DNS/timeout 风暴不再触发 60min disable", () => {
  it("decider 吃 12 轮 DNS-unknown（每轮两通道）→ 长熔断 closed + onOpen 零调用（bag 永不被 disable）", async () => {
    const { decider, longBreakers, onOpen } = makeDecider();
    for (let i = 0; i < 12; i++) {
      // 模拟两通道都因断网返 DNS unknown（error 含 ENOTFOUND——真实 chrome 导航错误）
      await decider.runWithFallback({ ...PLAN }, async () =>
        unknownResult("dns_or_nav_error:net::ERR_NAME_NOT_RESOLVED at https://x.test/"),
      );
    }
    // 旧实现：每轮 2 次 unknown 全计数 → 第 5 轮即 10 次 → open + bag.disable + 杀子进程
    expect(longBreakers.get("browse_headless")!.state).toBe("closed");
    expect(longBreakers.get("browse_logged_in")!.state).toBe("closed");
    expect(onOpen).not.toHaveBeenCalled();
    // 终答也诚实：fallback_exhausted（unknown 链耗尽），不是「明确否」
  });

  it("executor 抛 DNS 异常（throw 路径）同样不喂长熔断", async () => {
    const { decider, longBreakers, onOpen } = makeDecider();
    for (let i = 0; i < 12; i++) {
      await decider.runWithFallback({ ...PLAN }, async () => {
        throw new Error("getaddrinfo ENOTFOUND flaky.test");
      });
    }
    expect(longBreakers.get("browse_headless")!.state).toBe("closed");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("对照：429 风暴（真持续故障）仍会 open——长熔断语义未被拆除，只是不再误伤", async () => {
    const { decider, breakers, longBreakers, onOpen } = makeDecider();
    const ffShort = () => {
      for (const b of breakers.values()) b._forceElapsedForTests(60_001);
    };
    // 真实时序：短熔断 3 次连续失败 open 60s → 到期 half-open probe 又失败 → 循环。
    // 1h 窗内累计 10 次长熔断计数 → open。这里每轮后快进短熔断 60s 模拟该时序。
    for (let i = 0; i < 10; i++) {
      await decider.runWithFallback({ ...PLAN }, async () =>
        unknownResult("brave_status_429"),
      );
      ffShort();
    }
    expect(longBreakers.get("browse_headless")!.state).toBe("open");
    // 两通道都在 429 风暴中 → 各自 open（onOpen 每通道一次）
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith("browse_headless");
  });
});

// ============================================================
// 链 2：恢复闭环（F2c）
// ============================================================
describe("级联链 2：持续故障 open 后，probe 成功触发 onClose（恢复不再断链）", () => {
  it("429 风暴 open → 60min 后 probe 成功 → onClose 被调（装配层条件 bag.enable 的回调契约）", async () => {
    const { decider, breakers, longBreakers, onClose } = makeDecider();
    const ffShort = () => {
      for (const b of breakers.values()) b._forceElapsedForTests(60_001);
    };
    for (let i = 0; i < 10; i++) {
      await decider.runWithFallback({ ...PLAN }, async () =>
        unknownResult("brave_status_429"),
      );
      ffShort();
    }
    expect(longBreakers.get("browse_headless")!.state).toBe("open");
    // 快进 60min（测试后门）
    (
      longBreakers.get("browse_headless") as unknown as {
        _forceElapsedForTests: (ms: number) => void;
      }
    )._forceElapsedForTests(3_600_001);
    // 长 breaker half-open；短 breaker 也在 open 态（60s 窗）——快进让 probe 可达
    for (const b of breakers.values()) b._forceElapsedForTests(60_001);
    // probe 成功
    await decider.runWithFallback({ ...PLAN }, async () => ({
      outcome: "worked" as const,
      data: { ok: true },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "test",
    }));
    expect(longBreakers.get("browse_headless")!.state).toBe("closed");
    expect(onClose).toHaveBeenCalledWith("browse_headless");
  });
});

// ============================================================
// 链 3：budget_exceeded 不再喂假健康（F3）
// ============================================================
describe("级联链 3：慢站 budget_exceeded → decider 记 FAILURE（旧实现 recordSuccess 掩蔽诊断）", () => {
  it("budget_exceeded(unknown) → 两熔断都记 failure；didnt 时代会 recordSuccess 的反向掩蔽已消除", async () => {
    const { decider, breakers } = makeDecider();
    const r = await decider.runWithFallback({ ...PLAN }, async () =>
      unknownResult("budget_exceeded"), // StepEngine stop 的 chainOutcome=unknown 信号
    );
    // unknown → fallback 试下一通道 → 也 unknown → fallback_exhausted
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("fallback_exhausted");
    // 关键断言：headless 熔断记了 FAILURE（failureCount > 0），不是 SUCCESS 清零
    expect(breakers.get("browse_headless")!.failureCountReadOnly).toBeGreaterThan(0);
  });
});

// ============================================================
// 链 4：spill 仓打满不再 throw 喂熔断（F4）
// ============================================================
describe("级联链 4：长会话 spill 仓打满 → LRU 淘汰，tool 不崩、熔断零污染", () => {
  it("64MiB 打满后继续 spill ×50 → 零 throw（不再制造 executor 崩溃→unknown→双熔断计数风暴）", () => {
    const chunk = "x".repeat(2 * 1024 * 1024); // 2 MiB（>48KiB 触发 spill）
    let threw = 0;
    for (let i = 0; i < 82; i++) {
      // 82 × 2MiB = 164MiB > 64MiB cap——旧实现第 33 次起全 throw
      try {
        const env = applyOutputEnvelope(chunk);
        expect(env.truncated).toBe(true);
      } catch {
        threw++;
      }
    }
    expect(threw).toBe(0);
    expect(getTotalBytes()).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(getEvictedCount()).toBeGreaterThan(0);
  });
});

// ============================================================
// 链 5：SSRF DNS 瞬态零熔断接触 + 可重试语义（F1）
// ============================================================
describe("级联链 5：SSRF DNS 瞬态 → unknown 可重试；真策略拦截 → didnt（语义二分不漂移）", () => {
  const cfg: SsrfConfig = { allowRanges: [], denyRanges: [] };

  it("dns_failed → outcome=unknown + retrieval_method=ssrf_dns_unresolved（CC 可重试；不再「政策拦截」终答）", async () => {
    // lookup 一个肯定解析不出的域名（.invalid 是 RFC 2606 保留 TLD）
    const r = await ssrfGuard("https://definitely-not-resolvable-misfit.invalid/", cfg);
    // CI DNS 行为可能有两分支：解析失败（dns_failed）或被环境解析出 IP——只对失败分支断言语义
    if (!r.allowed && r.reason.startsWith("dns_failed")) {
      const d = ssrfDenial(r.reason);
      expect(d.outcome).toBe("unknown");
      expect(d.retrieval_method).toBe("ssrf_dns_unresolved");
    } else {
      // 环境解析成功（如 TUN fake-ip 兜底）——语义二分由 ssrf-guard.spec.ts 的
      // mock-DNS 用例权威覆盖；此处仅验证不抛错
      expect(typeof r.allowed).toBe("boolean");
    }
  });

  it("工具层二分语义纯函数：private_ip/deny_range/userinfo/protocol → didnt 不变（安全守卫本体零弱化）", () => {
    expect(ssrfDenial("private_ip:10.0.0.5").outcome).toBe("didnt");
    expect(ssrfDenial("deny_range:10.0.0.5").retrieval_method).toBe("ssrf_blocked");
    expect(ssrfDenial("userinfo_present").outcome).toBe("didnt");
    expect(ssrfDenial("protocol_not_allowed:ftp:").outcome).toBe("didnt");
  });
});
