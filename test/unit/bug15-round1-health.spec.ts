/**
 * bug15-round1-health.spec.ts（飞轮第 1 轮 F4 测试用例——先于实施确认，
 * 实施后对照判定；bugs/15 §F3/F4）
 *
 * 覆盖：
 *  1. parseHostMemoryPressure 四态表（1/2/3/空/非数字——L4-03 空≠属性）
 *  2. chrome-status lasso_live 健康附注集成（压力 warn/critical → 附注在场；
 *     normal → 无附注；pages > 12 → pages 附注；两者叠加 join）
 *  3. 契约守卫：分类枚举零变更（十分类集合钉死）+ lasso_live directive 零变
 *     （allowed_commands 恒空——INV-88 面）+ health_note 只在 lasso_live 路径挂
 *  4. paste pack 渲染 health 行
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseHostMemoryPressure,
  PAGES_ADVISORY_THRESHOLD,
} from "../../src/doctor/chrome-status.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

describe("parseHostMemoryPressure —— 宿主压力四态（bugs/15 R1）", () => {
  it("sysctl 数字映射：1→normal 2→warn 3→critical", () => {
    expect(parseHostMemoryPressure("1")).toBe("normal");
    expect(parseHostMemoryPressure("2")).toBe("warn");
    expect(parseHostMemoryPressure("3")).toBe("critical");
    expect(parseHostMemoryPressure(" 3\n")).toBe("critical"); // 尾随空白容忍
  });
  it("null/空/非数字/越界 → unknown（空输出≠空属性——如实说不可探测）", () => {
    expect(parseHostMemoryPressure(null)).toBe("unknown");
    expect(parseHostMemoryPressure("")).toBe("unknown");
    expect(parseHostMemoryPressure("abc")).toBe("unknown");
    expect(parseHostMemoryPressure("0")).toBe("unknown");
    expect(parseHostMemoryPressure("4")).toBe("unknown");
  });
  it("阈值常量 = 12（温和提示线，非硬闸）", () => {
    expect(PAGES_ADVISORY_THRESHOLD).toBe(12);
  });
});

describe("chrome-status 健康附注集成（bugs/15 R1——源码锚+行为面）", () => {
  // 行为面经 classifyPortOccupier 全链（需真 TCP/CDP——重）；源码锚钉结构
  const src = readFileSync(
    `${HERE}/../../src/doctor/chrome-status.ts`,
    "utf8",
  );

  it("lasso_live 路径挂附注：压力 warn/critical 或 pages>12 → health_note", () => {
    expect(src).toContain('pressure === "warn" || pressure === "critical"');
    expect(src).toContain("evidence.cdp.pages > PAGES_ADVISORY_THRESHOLD");
    expect(src).toContain('evidence.health_note = notes.join(" | ")');
  });
  it("附注只在 lasso_live 路径（user_owned/launching/zombie 等零挂）", () => {
    const liveIdx = src.indexOf('if (evidence.cdp.reachable) {');
    const noteIdx = src.indexOf("evidence.health_note = notes.join");
    const zombieIdx = src.indexOf('finalize("ledger_zombie_collectible"');
    // 附注代码块在 lasso_live 分支内（reachable 块之后、zombie finalize 之前）
    expect(liveIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeGreaterThan(liveIdx);
    expect(zombieIdx).toBeGreaterThan(noteIdx);
  });
  it("契约守卫：分类枚举零新值（十分类钉死——L3-04 消费方契约）", () => {
    for (const cls of [
      "free", "lasso_launching", "lasso_live", "ledger_zombie_collectible",
      "ledger_user_owned", "ledger_stale", "lasso_profile_orphan_suspected",
      "user_asset_suspected", "external_occupier", "probe_failed",
    ]) {
      expect(src).toContain(`${cls}: {`);
    }
    // 无新分类混入（health 附注不立分类）
    expect(src).not.toContain("lasso_live_degraded");
  });
  it("INV-88 面守卫：lasso_live directive 保持零命令+零上报", () => {
    const liveBlock = src.slice(
      src.indexOf("lasso_live: {"),
      src.indexOf("lasso_live: {") + 120,
    );
    expect(liveBlock).toContain("allowed_commands: []");
    expect(liveBlock).toContain("must_report: false");
  });
  it("paste pack 渲染 health 行", () => {
    expect(src).toContain("if (ev.health_note) lines.push(`health: ${ev.health_note}`);");
  });
});
