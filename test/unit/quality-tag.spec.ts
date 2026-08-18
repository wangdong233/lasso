/**
 * QualityTag 单元测（v1.17 Phase B / A1 质量轴，doc/24 decision-A A1 + doc/25 裁决①）。
 *
 * 守护要点：
 *  1. 静态映射零启发式：served_by → api/scrape/stale 精确表 + serp_http 前缀
 *  2. fanout 聚合串：全同档才定档；混档 / 含未知段 → undefined（宁缺毋假）
 *  3. 防御值（空 / undefined / "fanout(empty)" / "none"）→ undefined
 *  4. tagQuality 纯函数：查不到档位原样返回（不新增 quality 键——JSON 快照零扰动）
 *  5. 映射表**不含已删除的 search.zhipu**（A3 执行序约束：冲突 1——INV-80 墓碑同源）
 */
import { describe, it, expect } from "vitest";
import {
  qualityForServedBy,
  tagQuality,
} from "../../src/search/QualityTag.js";
import type { InteractResult, SearchResult } from "../../src/types.js";

describe("qualityForServedBy —— 静态映射（零启发式）", () => {
  it("api 档：search.machine_mcp / search.brave", () => {
    expect(qualityForServedBy("search.machine_mcp")).toBe("api");
    expect(qualityForServedBy("search.brave")).toBe("api");
  });

  it("scrape 档：browse_headless / browse_logged_in / browse_cloud_*", () => {
    expect(qualityForServedBy("browse_headless")).toBe("scrape");
    expect(qualityForServedBy("browse_logged_in")).toBe("scrape");
    expect(qualityForServedBy("browse_cloud_browserbase")).toBe("scrape");
    expect(qualityForServedBy("browse_cloud_stagehand")).toBe("scrape");
    expect(qualityForServedBy("browse_cloud_steel")).toBe("scrape");
  });

  it("scrape 档：serp_http 带引擎后缀变体（serp_http:ddg）——声明式前缀，仍零启发式", () => {
    expect(qualityForServedBy("serp_http:ddg")).toBe("scrape");
    expect(qualityForServedBy("serp_http")).toBe("scrape");
  });

  it("stale 档：recording_replay", () => {
    expect(qualityForServedBy("recording_replay")).toBe("stale");
  });

  it("fanout 聚合串：全同档 → 该档（v1.17 A3 后唯一组合是双 api）", () => {
    expect(qualityForServedBy("search.machine_mcp,search.brave")).toBe("api");
    expect(qualityForServedBy("search.brave,search.machine_mcp")).toBe("api");
  });

  it("fanout 聚合串：混档 → undefined（宁缺毋假，不猜主导源）", () => {
    expect(qualityForServedBy("search.brave,browse_headless")).toBeUndefined();
  });

  it("fanout 聚合串：任一段未知 → undefined", () => {
    expect(qualityForServedBy("search.brave,unknown_source")).toBeUndefined();
  });

  it("未知 served_by → undefined（不标；含 v1.17 A3 已删的 search.zhipu——执行序约束）", () => {
    expect(qualityForServedBy("unknown.channel")).toBeUndefined();
    // A3 执行序约束（parse24 冲突 1）：映射表第一版就不含 search.zhipu
    expect(qualityForServedBy("search.zhipu")).toBeUndefined();
  });

  it("防御值：空串 / undefined / 空聚合 / fanout(empty) / none → undefined", () => {
    expect(qualityForServedBy("")).toBeUndefined();
    expect(qualityForServedBy(undefined)).toBeUndefined();
    expect(qualityForServedBy(",,")).toBeUndefined();
    expect(qualityForServedBy("fanout(empty)")).toBeUndefined();
    expect(qualityForServedBy("none")).toBeUndefined();
  });
});

describe("tagQuality —— 纯函数打标（JSON 快照零扰动）", () => {
  function baseResult(
    servedBy: string,
    outcome: InteractResult<SearchResult>["outcome"] = "worked",
  ): InteractResult<SearchResult> {
    return {
      outcome,
      data:
        outcome === "worked"
          ? { query: "q", results: [], count: 0, engine: "x", region: "cn" }
          : null,
      served_by: servedBy,
      fallback_used: false,
      retrieval_method: "test",
    };
  }

  it("api 档结果 → 新对象含 quality:'api'（原对象不动）", () => {
    const r = baseResult("search.machine_mcp");
    const tagged = tagQuality(r);
    expect(tagged).not.toBe(r); // 纯函数：返回新对象
    expect(tagged.quality).toBe("api");
    expect(r.quality).toBeUndefined(); // 入参零改动
    expect(tagged.served_by).toBe("search.machine_mcp");
  });

  it("scrape / stale 档同理", () => {
    expect(tagQuality(baseResult("browse_headless")).quality).toBe("scrape");
    expect(tagQuality(baseResult("serp_http:ddg")).quality).toBe("scrape");
    expect(tagQuality(baseResult("recording_replay")).quality).toBe("stale");
  });

  it("查不到档位 → 原样返回（**不新增 quality 键**，既有快照逐键零扰动）", () => {
    const r = baseResult("unknown.channel");
    const tagged = tagQuality(r);
    expect(tagged).toBe(r); // 同一引用原样返回
    expect("quality" in tagged).toBe(false);
  });

  it("didnt/unknown outcome 也按 served_by 打标（quality 是路径轴不是成功轴）", () => {
    const r = baseResult("browse_headless", "didnt");
    expect(tagQuality(r).quality).toBe("scrape");
  });
});
