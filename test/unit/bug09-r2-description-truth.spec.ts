/**
 * bug09-r2-description-truth.spec.ts（对抗复审 r2 R2-1/R2-2 描述真值钉）
 *
 * 回炉修复员 2 复核 af765ef 发现 R2-1 限定漏钉 2 处残留：
 *  - BROWSE_HEADLESS_DESCRIPTION Returns 段「Every url-aware action echoes
 *    data.did_navigate (true/false)」全称断言未带 single-action 限定（第 4 处）
 *  - BROWSE_LOGGED_IN_DESCRIPTION Args 段「as in browse_headless」交叉引用
 *    未显式限定（第 5 处）。
 *
 * 本 spec 把 af765ef 的三处限定 + 回炉 2 处钉死：摘除任一限定（还原全称断言）
 * 即红。
 *
 * **§8.A 尾款轮更新（WT4/S 单元）**：R2-2 组随驱逐哨兵落地（doc/bugs/09
 * §8.A A.5r2-5）翻转为三组正向断言（信号句 ∧ 症状兜底句 ∧ consent 语言
 * ——摘任一即红）。
 *
 * **§8.B 尾款轮更新（2026-09-16，WT4/T 单元）**：开放项 5（steps 链真值化）
 * 已实施——链结果现在回显 chain-level did_navigate + tail-read final_url。
 * R2-1 的「single-action 限定」对 did_navigate/final_url 回显**语义**仍真
 * （链走自己的回显契约，不走 ensure-nav 单 action 契约），但「steps chains
 * carry no did_navigate」的缺席措辞已翻转为链级回显真值语义（下方断言同步
 * 翻转，行为面真值断言在 test/unit/bug09-chain-truth.spec.ts）。
 */
import { describe, it, expect } from "vitest";
import {
  BROWSE_HEADLESS_DESCRIPTION,
  BROWSE_LOGGED_IN_DESCRIPTION,
  BROWSE_HEADED_DESCRIPTION,
} from "../../src/tools/descriptions.js";

describe("对抗复审 r2 — R2-1/R2-2 描述真值钉", () => {
  describe("R2-1：url 语义全称断言必须限定 single-action（steps 链不经 ensure-nav 门——链走自己的回显契约）", () => {
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

    it("BROWSE_HEADLESS_DESCRIPTION：Returns 段「Every url-aware action」句必含 single-action 限定（回炉第 4 处——did_navigate/final_url 回显语义单双分轨）", () => {
      // 摘除限定（还原「echoes data.did_navigate (true/false) — see」全称）即红
      expect(BROWSE_HEADLESS_DESCRIPTION).toMatch(
        /Every url-aware action\s+echoes data\.did_navigate \(true\/false\) in single-action calls/,
      );
    });

    it("§8.B 链级回显真值语义在位（「steps chains carry no did_navigate」旧缺席措辞不得复活）", () => {
      // UNIFIED 块链语义句（bug09 §8.B）
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "Chain-level echo IS provided (bug09 §8.B)",
      );
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "tail-read truth of where the chain actually ran",
      );
      // Returns 段链句
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "steps chains echo chain-level",
      );
      // 残留页不再谎称目标页的消谎承诺
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "never the requested url echoed back",
      );
      // 旧缺席措辞消灭（回归锚——R2-1 时代的行为缺口描述不得回潮）
      expect(BROWSE_HEADLESS_DESCRIPTION).not.toContain(
        "steps chains carry no did_navigate",
      );
    });

    it("BROWSE_LOGGED_IN_DESCRIPTION：语义块限定在位（af765ef 处 3 + §8.B 链级回显补语）", () => {
      expect(BROWSE_LOGGED_IN_DESCRIPTION).toContain(
        "single-action calls — steps chains run on the page established by",
      );
      expect(BROWSE_LOGGED_IN_DESCRIPTION).toContain(
        "echo chain-level",
      );
    });

    it("BROWSE_LOGGED_IN_DESCRIPTION：Args 段交叉引用显式限定（回炉第 5 处 + §8.B 措辞）", () => {
      expect(BROWSE_LOGGED_IN_DESCRIPTION).toMatch(
        /as in\s+browse_headless \(single-action calls; steps\s+chains echo chain-level did_navigate \+\s+tail-read final_url, as qualified there\)/,
      );
    });
  });

  describe("R2-2→§8.A：驱逐哨兵信号形态落地（WT4 合并）——companion 双形态共存", () => {
    it("① 信号句在场：companion 块以 data.eviction_suspected 信号形态为主（摘除即红）", () => {
      expect(BROWSE_HEADED_DESCRIPTION).toContain(
        "when a browse response carries data.eviction_suspected",
      );
      expect(BROWSE_HEADED_DESCRIPTION).toContain("NOT confirmed");
    });

    it("② 症状兜底句在场：evaluate 死于 'Execution context was destroyed' 的判读形态（同 host 盲区/异常路径）保留", () => {
      expect(BROWSE_HEADED_DESCRIPTION).toContain(
        "Execution context was destroyed",
      );
      expect(BROWSE_HEADED_DESCRIPTION).toContain(
        "signal unavailable when the redirect stays on-host",
      );
    });

    it("③ consent 语言钉（r3 硬钉）：companion 块含 ASK THE USER FIRST——症状路径是唯一教 agent 从症状转 headed 的静态文本，摘除即红（与 INV-98(e) 描述/运行时双钉）", () => {
      expect(BROWSE_HEADED_DESCRIPTION).toMatch(/ASK THE USER FIRST/);
    });

    it("旧名 page_evicted 不得复活（r3 更名 eviction_suspected——认识论诚实：S1/S2 无归因能力，未发版窗口零迁移）", () => {
      expect(BROWSE_HEADED_DESCRIPTION).not.toContain("page_evicted");
    });

    it("BROWSE_HEADLESS_DESCRIPTION Returns 段同步信号面：data.eviction_suspected 说明 + ask-user 指引在场", () => {
      expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
        "data.eviction_suspected {from,to,at_ms}",
      );
      expect(BROWSE_HEADLESS_DESCRIPTION).toMatch(
        /ASK THE USER FIRST, then retry with\s+browse_headed/,
      );
    });
  });
});
