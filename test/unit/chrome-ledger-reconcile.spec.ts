/**
 * chrome-ledger-reconcile.spec.ts（2026-10-29 提案 v2：台账读点对账）
 *
 * 守护不变量 INV-L1/L2（INV-111 机械锚的行为面）：
 *  - INV-L1：凡 readLedgerSync() 返回的记录，pid 必活——死条目（ESRCH）读取即
 *    销账，「死 pid 记为 ready」寿命 ≤ 一次读取（京东云僵尸台账形态的根治回归）。
 *  - INV-L2：销账不需要「杀」授权——visible/login 死条目同样销账（mode-blind）；
 *    K4 指令面死锁消解（chrome-status 教的 zombie-gate 清账命令现可用）。
 *  - 防线负测：活 visible 条目 + zombie-gate 仍 gated_skipped（kill 豁免零松动
 *    ——本案唯一翻车方向）。
 *
 * 测试策略：全局 setup（test/setup-ledger.ts）已注入恒活判活（既有 spec 零适配）；
 * 本 spec 显式覆盖钩子注入受控探活，afterEach 恢复恒活。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readLedgerSync,
  __setLedgerAliveFnForTests,
  type LaunchedChromeRecord,
} from "../../src/launcher/chrome-ledger.js";
import { stopLaunchedChromes } from "../../src/launcher/chrome-stop.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let ledgerPath: string;
let tmpRoot: string;

function rec(over: Partial<LaunchedChromeRecord>): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 111111,
    profileDir: "/tmp/does-not-matter",
    launchedAt: Date.now(),
    status: "ready",
    ...over,
  };
}

function seedLedger(records: LaunchedChromeRecord[]): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(records, null, 2) + "\n", "utf8");
}

function rawFile(): LaunchedChromeRecord[] {
  return JSON.parse(readFileSync(ledgerPath, "utf8")) as LaunchedChromeRecord[];
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ledger-reconcile-"));
  ledgerPath = join(tmpRoot, "launched-chromes.json");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
});

afterEach(() => {
  __setLedgerAliveFnForTests(() => true); // 恢复全局 setup 的恒活基线
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("读点对账（INV-L1：读到的账 pid 必活）", () => {
  it("ESRCH 死条目：返回值不含 + 盘面销账（京东云形态回归锚）", () => {
    seedLedger([
      rec({ port: 9222, pid: 3374725, launchMode: "visible", status: "ready" }),
      rec({ port: 9223, pid: process.pid, launchMode: "hidden" }),
    ]);
    __setLedgerAliveFnForTests((pid) => pid === process.pid); // 3374725 → ESRCH 形态
    const out = readLedgerSync();
    expect(out.map((r) => r.port)).toEqual([9223]); // 死条目不返回
    expect(rawFile().map((r) => r.port)).toEqual([9223]); // 盘面同步自清
  });

  it("非 ESRCH 形态（EPERM 归一化为活）：保留不销（无证据不删）", () => {
    // EPERM→活的归一化在 isAliveStrict 内部（catch code 判断，INV-111(a) ESRCH
    // 字面量锚）；钩子契约=返回 boolean，注入「判活」即验证该归一化后的效果。
    seedLedger([rec({ port: 9222, pid: 42, launchMode: "hidden" })]);
    __setLedgerAliveFnForTests(() => true);
    const out = readLedgerSync();
    expect(out.map((r) => r.port)).toEqual([9222]); // 保留
    expect(rawFile()).toHaveLength(1); // 盘面不动
  });

  it("空台账/文件不存在：[] 容错零销账副作用", () => {
    __setLedgerAliveFnForTests(() => false);
    expect(readLedgerSync()).toEqual([]);
  });

  it("混合条目：只销死的，活的按原样返回（字段往返无损）", () => {
    seedLedger([
      rec({ port: 1, pid: 1, launchMode: "visible", userTakenAt: 123, ownerKind: "cli", idleMs: 0 }),
      rec({ port: 2, pid: 2, launchMode: "login" }),
      rec({ port: 3, pid: process.pid, launchMode: "render", hardCapExempt: true }),
    ]);
    __setLedgerAliveFnForTests((pid) => pid === process.pid);
    const out = readLedgerSync();
    expect(out.map((r) => r.port)).toEqual([3]);
    expect(out[0]!.hardCapExempt).toBe(true); // 可选字段往返保真
  });

  it("render 死条目销账连带临时 profile 盘清理（前缀守卫内）", () => {
    const profileDir = join(tmpRoot, "render-chrome-profile-abc123");
    mkdirSync(profileDir, { recursive: true });
    seedLedger([rec({ port: 9, pid: 9, launchMode: "render", profileDir })]);
    __setLedgerAliveFnForTests(() => false);
    readLedgerSync();
    expect(existsSync(profileDir)).toBe(false); // 收尸
    expect(rawFile()).toHaveLength(0);
  });

  it("render 死条目 profile 前缀不匹配：目录拒绝删除（防污染台账任意路径删除）", () => {
    const evilDir = join(tmpRoot, "evil-not-render-prefix");
    mkdirSync(evilDir, { recursive: true });
    seedLedger([rec({ port: 9, pid: 9, launchMode: "render", profileDir: evilDir })]);
    __setLedgerAliveFnForTests(() => false);
    readLedgerSync();
    expect(existsSync(evilDir)).toBe(true); // 前缀守卫拒绝
    expect(rawFile()).toHaveLength(0); // 账照销（盘不动）
  });

  it("幂等：第二次读取零销账动作（盘面已收敛）", () => {
    seedLedger([rec({ port: 5, pid: 5 })]);
    __setLedgerAliveFnForTests(() => false);
    readLedgerSync();
    const first = rawFile();
    expect(first).toHaveLength(0);
    const out2 = readLedgerSync();
    expect(out2).toEqual([]);
  });
});

describe("指令面回归（K4：chrome-status 教的 zombie-gate 清账命令兑现）", () => {
  it("死 visible 条目 + zombie-gate → 读点先销 → stopped 空 + 台账空（非 gated_skipped）", async () => {
    seedLedger([rec({ port: 9222, pid: 3374725, launchMode: "visible" })]);
    __setLedgerAliveFnForTests(() => false); // 死条目
    const r = await stopLaunchedChromes({ port: 9222, zombieGate: true });
    expect(r.gated_skipped ?? []).toEqual([]); // 不再被 gate 自锁（K3/K4 消解）
    expect((r.stopped ?? []).map((s) => s.action)).toEqual([]); // 读点已销 → targets 空
    expect(rawFile()).toHaveLength(0); // 账清
  });

  it("防线负测：活 visible 条目 + zombie-gate → 仍 gated_skipped 且零 kill（三红线）", async () => {
    seedLedger([rec({ port: 9222, pid: 424242, launchMode: "visible" })]);
    // 恒活（继承全局 setup）——活资产形态
    const killTreeFn = vi.fn();
    const r = await stopLaunchedChromes({ port: 9222, zombieGate: true, killTreeFn });
    expect(r.gated_skipped ?? []).toEqual([
      expect.objectContaining({
        port: 9222,
        pid: 424242,
        reason: "launch_mode_visible_gated_never_kill_user_asset",
      }),
    ]);
    expect(killTreeFn).not.toHaveBeenCalled(); // kill 面零松动
    expect(rawFile()).toHaveLength(1); // 账保留（活资产不销）
  });
});
