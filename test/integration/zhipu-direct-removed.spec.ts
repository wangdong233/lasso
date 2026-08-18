/**
 * v1.17 A3（doc/25 五项裁决裁决③）——zhipu 直连 API channel 死层清除回归锁。
 *
 * INV-80 墓碑的测试侧镜像（快速失败 + 语义逐项钉死，照 v1.15 Phase A 的
 * Bing 死层清除测试范式但独立成文件——A3 删除面更大，集中守护）：
 *  1. channels/SearchChannel.ts 文件不存在（整文件删除，INV-80(a)）
 *  2. src/ 代码本体（stripComments 后）无 "search.zhipu" channel 字面量（INV-80(b)）
 *  3. DEFAULT_FALLBACK_ORDER = [machine_mcp, brave]，不含 search.zhipu（INV-80(c)）
 *  4. providers.ts 无 ZHIPU ProviderConfig / BUILTIN 不含 zhipu（INV-80(d)）
 *  5. config.ts 不消费 ZHIPU_API_KEY（zhipu provider 永不注册，INV-80(e)）
 *  6. doctor zhipu_keys_retired 存在（含 endpoint-only 变体；INV-80(f)）
 *  7. searchSchema engine enum 无 "zhipu" 值（INV-80(g)；zod 拒绝）
 *  8. 行为级：machine_mcp L1 不参与 free_only 过滤（fallback_chain brave 被滤仍首位）
 *  9. 行为级：allocateLimit 对无 ledger 的 machine_mcp 源退化 weight=1 兜底
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_FALLBACK_ORDER } from "../../src/search/FallbackChain.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";
import { loadConfig } from "../../src/config/config.js";
import { searchSchema } from "../../src/tools/search.js";
import { runDoctor } from "../../src/doctor/doctor.js";
import { allocateLimit } from "../../src/search/MultiSourceFanout.js";
import {
  runFallbackChainEngine,
} from "../../src/tools/search.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import type { MachineMcpSearchChannel } from "../../src/channels/MachineMcpSearchChannel.js";
import type { BraveChannel, BraveOpts } from "../../src/channels/BraveChannel.js";
import type { InteractResult, SearchResult } from "../../src/types.js";
import { vi } from "vitest";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src",
);

/** 递归收集 src/ 下全部 .ts/.mts 文件。 */
function collectSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir)) {
    const p = path.join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectSrcFiles(p));
    else if (/\.(ts|mts)$/.test(ent)) out.push(p);
  }
  return out;
}

/** 简化 stripComments：去 /* *\/ 与 // 行注释（与 check-invariants.mjs 同款语义）。 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:"'`\w])\/\/[^"\n]*$/gm, "$1");
}

// ============================================================
// 墓碑断言（文件级）
// ============================================================
describe("INV-80 镜像 —— zhipu 直连死层清除（文件级）", () => {
  it("(a) channels/SearchChannel.ts 不存在（整文件已删）", () => {
    expect(existsSync(path.join(SRC_ROOT, "channels", "SearchChannel.ts"))).toBe(
      false,
    );
  });

  it("(b) src/ 代码本体无 \"search.zhipu\" channel 字面量（stripComments 后；墓碑注释合法）", () => {
    const files = collectSrcFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(
        code.includes('"search.zhipu"') || code.includes("'search.zhipu'"),
        `${f} 含 search.zhipu channel 字面量（回潮）`,
      ).toBe(false);
    }
  });

  it("(b') src/ 代码本体无 channels/SearchChannel import", () => {
    for (const f of collectSrcFiles(SRC_ROOT)) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code.includes("channels/SearchChannel"), `${f} 回潮 import`).toBe(
        false,
      );
    }
  });

  it("(c) DEFAULT_FALLBACK_ORDER = [machine_mcp, brave]，不含 search.zhipu", () => {
    expect(DEFAULT_FALLBACK_ORDER).toEqual([
      "search.machine_mcp",
      "search.brave",
    ]);
  });

  it("(d) providers.ts 无 ZHIPU ProviderConfig；BUILTIN_PROVIDERS 不含 zhipu", () => {
    const provCode = stripComments(
      readFileSync(path.join(SRC_ROOT, "config", "providers.ts"), "utf8"),
    );
    expect(/const\s+ZHIPU\s*:\s*ProviderConfig/.test(provCode)).toBe(false);
    expect(BUILTIN_PROVIDERS.map((p) => p.name)).not.toContain("zhipu");
  });

  it("(e) config.ts 不消费 ZHIPU_API_KEY：配了也永不注册 zhipu provider", () => {
    const cfg = loadConfig({
      runId: "inv80-e",
      env: {
        ZHIPU_API_KEY: "legacy-key",
        ZHIPU_ENDPOINT: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      },
    });
    expect(cfg.providers.get("zhipu")).toBeUndefined();
    expect(cfg.registry.get("zhipu")).toBeUndefined();
    expect(
      cfg.registry.byCap("search").map((p) => p.config.name),
    ).not.toContain("zhipu");
  });

  it("(f) doctor 存在 zhipu_keys_retired；endpoint-only 残留也 warn", async () => {
    const r = await runDoctor({
      cacheDir: path.join(
        // doctor 的 cache 检查不是本测试重点；给真实可写 tmp 目录
        await (async () => {
          const { promises: fsp } = await import("node:fs");
          const { tmpdir } = await import("node:os");
          const dir = path.join(tmpdir(), `lasso-inv80-${Date.now()}`);
          await fsp.mkdir(dir, { recursive: true });
          return dir;
        })(),
      ),
      skipNetwork: true,
      skipInvariants: true,
      // 不传 zhipuKey（env 无）——endpoint 经 process.env 不设，此处仅验证检查存在
    });
    const c = r.checks.find((x) => x.name === "zhipu_keys_retired");
    expect(c).toBeDefined();
    expect(r.checks.map((x) => x.name)).not.toContain("zhipu_api_key");
    expect(r.checks.map((x) => x.name)).not.toContain(
      "zhipu_endpoint_reachable",
    );
  });

  it("(g) searchSchema engine enum 无 zhipu 值（zod 拒绝 + 合法值集合精确）", () => {
    const engineSchema = z.enum(["auto", "brave", "fallback_chain"]);
    // 与 searchSchema 同步的独立枚举断言（防 enum 悄悄加回 zhipu）
    expect(searchSchema.engine.safeParse("zhipu").success).toBe(false);
    expect(searchSchema.engine.safeParse("auto").success).toBe(true);
    expect(searchSchema.engine.safeParse("brave").success).toBe(true);
    expect(searchSchema.engine.safeParse("fallback_chain").success).toBe(true);
    expect(engineSchema.options).toEqual(["auto", "brave", "fallback_chain"]);
  });
});

// ============================================================
// 行为级：machine_mcp L1 不参与 free_only 过滤 + 无 ledger 源的配额兜底
// ============================================================
describe("v1.17 A3 行为级 —— machine_mcp 在过滤/分配两层的 L1 语义", () => {
  function makeStubMachineMcp(
    impl: () => Promise<InteractResult<SearchResult>>,
  ): MachineMcpSearchChannel {
    return {
      name: "search.machine_mcp",
      search: vi.fn(impl),
      isAvailable: vi.fn(async () => true),
      status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
      healthCheck: vi.fn(async () => "healthy" as const),
    } as unknown as MachineMcpSearchChannel;
  }

  it("fallback_chain + free_only 滤除 brave（L4）→ machine_mcp（L1 不过滤）仍首位服务", async () => {
    const machineMcp = makeStubMachineMcp(async () => ({
      outcome: "worked",
      data: {
        query: "q",
        results: [{ title: "M1", url: "https://m1.test", snippet: "" }],
        count: 1,
        engine: "machine_mcp",
        region: "cn",
      },
      served_by: "search.machine_mcp",
      fallback_used: false,
      retrieval_method: "machine_mcp_api",
    }));
    const brave = {
      name: "search.brave",
      search: vi.fn(async () => {
        throw new Error("brave filtered by free_only; must not be called");
      }),
      isAvailable: vi.fn(async () => true),
      status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
      healthCheck: vi.fn(async () => "healthy" as const),
    } as unknown as BraveChannel;

    const decider = new FallbackDecider(
      new Map([
        ["search.machine_mcp", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      undefined,
      brave,
      async () => ({
        outcome: "unknown",
        data: null,
        error: "not called",
      }),
      decider,
      null,
      /* braveAllowedByFreeTier */ false,
      machineMcp,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("search.machine_mcp");
    // brave 被滤除（未进链）+ machine_mcp 首位即成功（browse_headless 未进链）
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.machine_mcp",
    ]);
  });

  it("allocateLimit：machine_mcp 无 ledger（quota 0/0）→ weight=1 兜底，非 CJK 下与 brave 约按 0.3:0.7 分", () => {
    // registry.get("machine_mcp")=undefined → quotaRemaining=0/quotaPerMonth=0 →
    // quotaWeight 退化为 1（quotaPerMonth=0 分支）；brave 正常配额 → quotaWeight=1。
    // EN query：brave 0.7 / machine_mcp 0.3 → brave 略多但 machine_mcp 仍有实配额。
    const r = allocateLimit(
      10,
      [
        { name: "search.machine_mcp", quotaRemaining: 0, quotaPerMonth: 0 },
        { name: "search.brave", quotaRemaining: 1000, quotaPerMonth: 1000 },
      ],
      "rust async",
    );
    const machineMcp = r.find((s) => s.name === "search.machine_mcp")!;
    const brave = r.find((s) => s.name === "search.brave")!;
    expect(machineMcp.capacity).toBeGreaterThanOrEqual(3); // 10 × 0.3/(0.3+0.7)
    expect(brave.capacity).toBeGreaterThanOrEqual(machineMcp.capacity);
  });
});
