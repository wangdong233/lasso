/**
 * bug06-chrome-status.spec.ts（BUG-06 决议 B，doc/bugs/06，2026-09-10）
 *
 * 超龄可观测回归——hard_cap_watch 咨询块（只读 advisory）：
 *  - 命中：台账在案 + 非用户拥有 + 非 render + 非 hardCapExempt + 有效期限=cap
 *    （idleMs<=0 或 >cap）+ lastUse 龄 > 50% cap → evidence.hard_cap_watch 在场
 *  - 铁律（B 面零新增 kill/指令面）：classification 不变（仍 lasso_live）、
 *    allowed_commands 恒空、AGENT_DIRECTIVES 不变（INV-88 契约不破）
 *  - touch 文件新鲜（A-7 跨进程真源）→ 无 watch（在用永不杀的观测面镜像）
 *  - paste pack 增行：预期回收时刻 + touch 续命法 + 用户本人 chrome-stop 出口
 *  - doctor next_step 纯渲染（chrome-status 单一真源 → lasso_live 分支追加行）
 *
 * 全 DI 注入——零真机、零真 lsof/ps、台账经 env 隔离。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyPortOccupier,
  AGENT_DIRECTIVES,
  type ClassifyPortOccupierDeps,
} from "../../src/doctor/chrome-status.js";
import { classifyPortOccupierNextStep } from "../../src/doctor/doctor.js";
import { recordLaunch, type LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";

const PROFILE = `${os.homedir()}/.cache/lasso/chrome-profile-default`;
const CHROME_CMD = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222`;

const CAP = 24 * 3_600_000; // 24h

let tmpDir: string;
let nowMs: number;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-bug06-cs-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "launched-chromes.json");
  process.env.LASSO_CHROME_TOUCH_DIR = tmpDir;
  nowMs = Date.now();
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_CHROME_TOUCH_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 66222,
    profileDir: PROFILE,
    launchedAt: nowMs - 13 * 3_600_000, // 13h 前（> 50% of 24h cap）
    status: "ready",
    launchMode: "hidden",
    ...overrides,
  };
}

/** 全证据链齐备 + CDP 可达（→ lasso_live 分支）的 DI 集。 */
function baseDeps(overrides: Partial<ClassifyPortOccupierDeps> = {}): ClassifyPortOccupierDeps {
  return {
    tcpFn: async () => true,
    cdpVersionFn: async () => ({ ok: true, browser: "Chrome/150" }),
    cdpListFn: async () => null,
    lsofFn: async () => 66222,
    psFn: () => ({ command: CHROME_CMD, etimeS: 46_800 }),
    aliveFn: () => true,
    now: () => nowMs,
    touchStatFn: () => undefined, // 无外部信号（hermetic）
    hardCapMs: CAP,
    ...overrides,
  };
}

describe("BUG-06B · hard_cap_watch 咨询块", () => {
  it("1. idle0 超龄（13h > 50% cap）→ watch 在场；classification 仍 lasso_live；allowed_commands 空（零新增 kill 面）", async () => {
    await recordLaunch(makeRec({ idleMs: 0 }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("lasso_live"); // 分类不变（决议 B）
    expect(r.agent_directive.allowed_commands).toEqual([]); // INV-88 契约不破
    expect(r.agent_directive).toEqual(AGENT_DIRECTIVES.lasso_live); // 指令面整体不变
    const w = r.evidence.hard_cap_watch;
    expect(w).toBeDefined();
    expect(w!.cap_ms).toBe(CAP);
    expect(w!.idle_for_ms).toBe(13 * 3_600_000);
    expect(w!.ratio).toBeGreaterThan(0.5);
    expect(w!.reap_at_epoch_ms).toBe(nowMs - 13 * 3_600_000 + CAP); // lastUse + cap
    // 决议 B：evidence.ledger_record 增 idleMs
    expect(r.evidence.ledger_record?.idleMs).toBe(0);
  });

  it("2. paste pack 含硬顶行（预期回收时刻 + touch 续命法 + 用户本人 chrome-stop 出口）", async () => {
    await recordLaunch(makeRec({ idleMs: 0 }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.user_paste_pack).toContain("hard-cap watch:");
    expect(r.user_paste_pack).toContain(`touch ~/.cache/lasso/chrome-touch-9222`);
    expect(r.user_paste_pack).toContain(`lasso-mcp chrome-stop --port 9222`);
    expect(r.user_paste_pack).toContain("auto-reaps at");
  });

  it("3. 未超龄（龄 < 50% cap）→ 无 watch", async () => {
    await recordLaunch(makeRec({ idleMs: 0, launchedAt: nowMs - 3 * 3_600_000 })); // 3h < 12h
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("lasso_live");
    expect(r.evidence.hard_cap_watch).toBeUndefined();
  });

  it("4. touch 文件新鲜（A-7 跨进程真源）→ 无 watch（在用永不杀的观测面镜像）", async () => {
    await recordLaunch(makeRec({ idleMs: 0 })); // launchedAt 13h 前
    const r = await classifyPortOccupier(
      9222,
      baseDeps({ touchStatFn: () => nowMs - 3_600_000 }), // 1h 前有 browse/touch 活动
    );
    expect(r.evidence.hard_cap_watch).toBeUndefined();
  });

  it("5. 用户拥有（userTakenAt）→ 无 watch（豁免前置短路；classification ledger_user_owned）", async () => {
    await recordLaunch(makeRec({ idleMs: 0, userTakenAt: nowMs - 1 }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("ledger_user_owned");
    expect(r.evidence.hard_cap_watch).toBeUndefined();
  });

  it("6. visible 档 → 无 watch（P1 红线豁免）", async () => {
    await recordLaunch(makeRec({ idleMs: 0, launchMode: "visible" }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("ledger_user_owned");
    expect(r.evidence.hard_cap_watch).toBeUndefined();
  });

  it("7. render 档 → 无 watch（D3 红线隔离）", async () => {
    await recordLaunch(makeRec({ idleMs: 0, launchMode: "render" }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.evidence.hard_cap_watch).toBeUndefined();
  });

  it("8. hardCapExempt=true（--no-hard-cap）→ 无 watch（双意图豁免）", async () => {
    await recordLaunch(makeRec({ idleMs: 0, hardCapExempt: true }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("lasso_live");
    expect(r.evidence.hard_cap_watch).toBeUndefined();
  });

  it("9. idleMs>0 且 ≤cap（有效期限=idle 非 cap）→ 无 watch；idleMs>cap（夹紧到 cap）→ watch", async () => {
    await recordLaunch(makeRec({ idleMs: 30 * 60_000 })); // 30min ≤ 24h
    let r = await classifyPortOccupier(9222, baseDeps());
    expect(r.evidence.hard_cap_watch).toBeUndefined();
    await recordLaunch(makeRec({ idleMs: 7 * 24 * 3_600_000 })); // 7d > 24h → min 夹紧
    r = await classifyPortOccupier(9222, baseDeps());
    expect(r.evidence.hard_cap_watch).toBeDefined();
  });

  it("10. hardCapMs=0（部署级 LASSO_LAUNCH_HARD_CAP_MS=0）→ 无 watch（禁用即不告警）", async () => {
    await recordLaunch(makeRec({ idleMs: 0 }));
    const r = await classifyPortOccupier(9222, baseDeps({ hardCapMs: 0 }));
    expect(r.evidence.hard_cap_watch).toBeUndefined();
  });
});

describe("BUG-06B · doctor 渲染行（chrome-status 单一真源 → 纯渲染）", () => {
  it("11. lasso_live + watch 在场 → next_step 含「硬顶超龄观察」行（touch 续命 + 用户 chrome-stop 出口）", async () => {
    await recordLaunch(makeRec({ idleMs: 0 }));
    const text = await classifyPortOccupierNextStep(9222, baseDeps());
    expect(text).toContain("正常使用即可");
    expect(text).toContain("硬顶超龄观察");
    expect(text).toContain("touch ~/.cache/lasso/chrome-touch-9222");
    expect(text).toContain("chrome-stop --port 9222");
  });

  it("12. 无 watch（未超龄）→ lasso_live 文案与旧版逐字节一致（零回归锚）", async () => {
    await recordLaunch(makeRec({ idleMs: 30 * 60_000, launchedAt: nowMs - 60_000 }));
    const text = await classifyPortOccupierNextStep(9222, baseDeps());
    expect(text).toBe(
      `端口 9222 是 lasso 台账在案且健康的 Chrome（pid 66222，CDP 可达）：正常使用即可`,
    );
  });
});
