/**
 * bug09-r2-description-truth.spec.ts（对抗复审 r2 R2-1/R2-2 描述真值钉）
 *
 * 回炉修复员 2 复核 af765ef 发现 R2-1 限定漏钉 2 处残留：
 *  - BROWSE_HEADLESS_DESCRIPTION Returns 段「Every url-aware action echoes
 *    data.did_navigate (true/false)」全称断言未带 single-action 限定（第 4 处）
 *    ——steps 链结果（wrapChainResult → data.action:"chain"）不回显
 *    did_navigate，全称对链形态不真（与 R2-1 同类：BrowseChannel.ts:1022
 *    executeStep 直派裸 handler 不经 ensure-nav 门 + StepEngine.ts:330
 *    final_url 恒回请求串）；
 *  - BROWSE_LOGGED_IN_DESCRIPTION Args 段「as in browse_headless」交叉引用
 *    未显式限定（第 5 处）。
 *
 * 本 spec 把 af765ef 的三处限定 + 回炉 2 处 + R2-2 症状化全部钉死：摘除任一
 * 限定（还原全称断言）或复活 page_evicted 前向引用（全库无发射点）即红。
 * 行为面真值化在 doc/bugs/09 §5r2 开放项 5（独立小决议），不在本 spec。
 */
import { describe, it, expect } from "vitest";
import {
  BROWSE_HEADLESS_DESCRIPTION,
  BROWSE_LOGGED_IN_DESCRIPTION,
  BROWSE_HEADED_DESCRIPTION,
} from "../../src/tools/descriptions.js";

describe("对抗复审 r2 — R2-1/R2-2 描述真值钉", () => {
  describe("R2-1：url 语义全称断言必须限定 single-action（steps 链不经 ensure-nav 门、链结果无 did_navigate）", () => {
    it("BROWSE_HEADLESS_DESCRIPTION：evaluate 块限定在位（af765ef 处 1）", () => {
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "actions, single-action calls):",
      );
    });

    it("BROWSE_HEADLESS_DESCRIPTION：UNIFIED 块限定 + steps carve-out 在位（af765ef 处 2）", () => {
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "network / pdf), single-action",
      );
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "steps chains: ensure-nav does NOT apply per step",
      );
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "a chain's url is the resource key, not a per-step target",
      );
    });

    it("BROWSE_HEADLESS_DESCRIPTION：Returns 段「Every url-aware action」句必含 single-action 限定（回炉第 4 处残留——wrapChainResult 链结果 action:'chain' 无 did_navigate）", () => {
      // 摘除限定（还原「echoes data.did_navigate (true/false) — see」全称）即红
      expect(BROWSE_HEADLESS_DESCRIPTION).toMatch(
        /Every url-aware action\s+echoes data\.did_navigate \(true\/false\) in single-action calls/,
      );
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "steps chains carry no did_navigate",
      );
    });

    it("BROWSE_LOGGED_IN_DESCRIPTION：语义块限定在位（af765ef 处 3）", () => {
      expect(BROWSE_LOGGED_IN_DESCRIPTION).toContain(
        "single-action calls — steps chains run on the page established by",
      );
    });

    it("BROWSE_LOGGED_IN_DESCRIPTION：Args 段交叉引用显式限定（回炉第 5 处残留）", () => {
      expect(BROWSE_LOGGED_IN_DESCRIPTION).toMatch(
        /as in\s+browse_headless \(single-action calls; steps\s+chains — carve-out as qualified there\)/,
      );
    });
  });

  describe("R2-2：page_evicted 前向引用不得复活（全库无发射点/类型/测试）", () => {
    it("BROWSE_HEADED_DESCRIPTION：症状判读形态在位、信号形态缺席", () => {
      expect(BROWSE_HEADED_DESCRIPTION).not.toContain("page_evicted");
      expect(BROWSE_HEADED_DESCRIPTION).toContain(
        "Execution context was destroyed",
      );
    });
  });
});
