/**
 * bug15-round1-health.spec.ts（飞轮第 1 轮 F4 测试用例——先于实施确认，
 * 实施后对照判定；bugs/15 §F3/F4）
 *
 * 覆盖（深查 R2 后：健康附注覆盖 user_owned+lasso_live 两路径——1b 修复）：
 *  1. parseHostMemoryPressure 四态表（1/2/3/空/非数字——L4-03 空≠属性）
 *  2. chrome-status lasso_live 健康附注集成（压力 warn/critical → 附注在场；
 *     normal → 无附注；pages > 12 → pages 附注；两者叠加 join）
 *  3. 契约守卫：分类枚举零变更（十分类集合钉死）+ lasso_live directive 零变
 *     （allowed_commands 恒空——INV-88 面）+ health_note 只在 lasso_live 路径挂
 *  4. paste pack 渲染 health 行
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  it("附注覆盖 lasso_live + ledger_user_owned 两路径（深度自查 1b 修复锚）", () => {
    const noteIdx = src.indexOf("evidence.health_note = notes.join");
    const userOwnedIdx = src.indexOf('finalize("ledger_user_owned"');
    const liveIdx = src.indexOf('finalize("lasso_live"');
    // 附注构造在 user_owned finalize 之前（1b：提前到共用位）
    expect(noteIdx).toBeGreaterThan(-1);
    expect(userOwnedIdx).toBeGreaterThan(noteIdx);
    expect(liveIdx).toBeGreaterThan(noteIdx);
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

describe("R2 CLI NOTE 守卫（深查 F4——M2 变异证实零守卫）", () => {
  it("CLI_USAGE launch-chrome 块含身份契约 NOTE（删即红）", () => {
    const src = readFileSync(`${HERE}/../../src/index.ts`, "utf8");
    expect(src).toContain("an asset, not a second browser");
    expect(src).toContain('--disable-sync');
  });
});

// ============================================================
// 深查 R2-A1 补：1b 行为用例（bug04 DI 范式——不再只靠源码排序锚）
// ============================================================
import { classifyPortOccupier } from "../../src/doctor/chrome-status.js";
import { recordLaunch, readLedgerSync } from "../../src/launcher/chrome-ledger.js";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("1b 行为面：user_owned/lasso_live 两路径健康附注（DI 全链）", () => {
  const PROFILE = `${os.homedir()}/.cache/lasso/chrome-profile-default`;
  const CHROME_CMD = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222`;
  let ledgerDir = "";
  const origEnv = process.env.LASSO_LAUNCHED_CHROMES_PATH;

  beforeEach(() => {
    ledgerDir = mkdtempSync(path.join(os.tmpdir(), "lasso-15b-"));
    process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(ledgerDir, "chromes.json");
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
    else process.env.LASSO_LAUNCHED_CHROMES_PATH = origEnv;
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  function deps(over: Record<string, unknown> = {}) {
    return {
      tcpFn: async () => true,
      cdpVersionFn: async () => ({ ok: true, browser: "Chrome/150" }),
      cdpListFn: async () => 14,
      lsofFn: async () => 66333,
      psFn: () => ({ command: CHROME_CMD, etimeS: 900 }),
      aliveFn: () => true,
      hostPressureFn: () => "3", // critical
      touchStatFn: () => undefined, // hermetic（无外部 touch 信号）
      ...over,
    };
  }

  /** 陈年记录（避 launching 窗口——bug04 范式） */
  const OLD = Date.now() - 3_600_000 * 10;

  it("visible（user_owned）+critical 压力+14 pages → health_note 双附注在场（1b 修复的行为级钉）", async () => {
    await recordLaunch({
      port: 9222, pid: 66333,
      profileDir: PROFILE,
      launchedAt: OLD, status: "ready" as const,
      launchMode: "visible", idleMs: 0,
    });
    const r = await classifyPortOccupier(9222, deps() as never);
    expect(r.classification).toBe("ledger_user_owned"); // visible 即 user-owned
    expect(r.evidence.health_note).toContain("host memory pressure=critical");
    expect(r.evidence.health_note).toContain("pages=14");
  });

  it("hidden（lasso_live）+normal 压力+few pages → 无附注", async () => {
    await recordLaunch({
      port: 9222, pid: 66333,
      profileDir: PROFILE,
      launchedAt: OLD, status: "ready" as const,
      launchMode: "hidden", idleMs: 3_600_000,
    });
    const r = await classifyPortOccupier(9222, deps({ hostPressureFn: () => "1", cdpListFn: async () => 3 }) as never);
    expect(r.classification).toBe("lasso_live");
    expect(r.evidence.health_note).toBeUndefined();
  });

  it("CDP 不可达的 user_owned → 无附注（reachable 包裹守卫）", async () => {
    await recordLaunch({
      port: 9222, pid: 66333,
      profileDir: PROFILE,
      launchedAt: OLD, status: "ready" as const,
      launchMode: "visible", idleMs: 0,
    });
    const r = await classifyPortOccupier(9222, deps({ cdpVersionFn: async () => ({ ok: false }) }) as never);
    expect(r.classification).toBe("ledger_user_owned");
    expect(r.evidence.health_note).toBeUndefined();
  });
});
