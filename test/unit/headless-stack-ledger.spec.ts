/**
 * headless-stack-ledger.spec.ts（BUG-08 决议 B-2，doc/bugs/08，2026-09-15）
 *
 * 内部栈 sidecar 的判杀算法真值表（R1 pid 归并版）——全依赖注入（假 ps/kill），
 * 零真进程杀面。判定序（= 实现序，INV-96③ 文本锚）：
 *
 *   pid 归并（同 pid 任一 owner 活 → 整组零动作）→ alive → 包串 →
 *   lstart 与 spawnedAt 一致 → owner 死 → killTreeSync
 *
 * R1 复核轮三行新增（决议 §B-2 测试面）：
 *  - 陈旧记录（owner 死）+ 活记录（owner 活）同 pid → 整组不杀 + 只清陈旧条
 *  - 全组 owner 死 + lstart 不符 → 只清记录绝不杀
 *  - 陈旧记录 pid 被活 server 栈复用（真实事故序列复刻）→ 不杀
 *
 * 变异红证（决议 §6）：拆 pid 归并 → 同 pid 双记录用例红；拆 lstart 核对 →
 * 起始时间不符用例红；拆条件② 包串 → 包串不符用例红。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendStackRecord,
  readStacksSync,
  removeStackRecords,
  removeStackRecordsForOwner,
  stacksLedgerPath,
  sweepOrphanStacks,
  parseLstartToEpochMs,
  LSTART_FORWARD_TOLERANCE_MS,
  type HeadlessStackRecord,
  type SweepDeps,
} from "../../src/subprocess/headless-stack-ledger.js";

const PKG = "chrome-devtools-mcp@1.7.0";

// ============================================================
// 真值表 harness：全依赖注入
// ============================================================
class SweepHarness {
  alivePids = new Set<number>();
  cmdByPid = new Map<number, string>();
  lstartByPid = new Map<number, string>();
  killed: number[] = [];

  deps(): SweepDeps {
    return {
      expectedPackageToken: PKG,
      isPidAlive: (pid) => this.alivePids.has(pid),
      psCommand: (pid) => this.cmdByPid.get(pid) ?? null,
      psLstart: (pid) => this.lstartByPid.get(pid) ?? null,
      killTree: (pid) => {
        this.killed.push(pid);
      },
      log: () => {},
    };
  }

  /** 放一个「活的 lasso 栈」形态：pid 活 + 包串 + lstart 与 spawnedAt 一致。 */
  stack(pid: number, ownerPid: number, spawnedAt = Date.now() - 60_000): HeadlessStackRecord {
    this.alivePids.add(pid);
    this.cmdByPid.set(pid, `npx chrome-devtools-mcp@1.7.0 --headless --isolated`);
    // lstart = spawnedAt - 3s（健康握手窗内，后向 60s 界）
    this.lstartByPid.set(pid, new Date(spawnedAt - 3_000).toString());
    return { specName: "headless", pid, ownerPid, spawnedAt };
  }
}

let dir: string;
let sidecar: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lasso-b08b-"));
  sidecar = path.join(dir, "headless-stacks.json");
  process.env.LASSO_HEADLESS_STACKS_PATH = sidecar;
});

afterEach(() => {
  delete process.env.LASSO_HEADLESS_STACKS_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function writeRecords(recs: HeadlessStackRecord[]): void {
  writeFileSync(sidecar, JSON.stringify(recs), "utf8");
}

// ============================================================
// 读写往返
// ============================================================
describe("headless-stack-ledger — sidecar 读写往返", () => {
  it("append → read 往返；同 pid+owner 双键去重", () => {
    appendStackRecord({ specName: "headless", pid: 111, ownerPid: 1, spawnedAt: 1000 });
    appendStackRecord({ specName: "logged_in:p", pid: 222, ownerPid: 2, spawnedAt: 2000 });
    appendStackRecord({ specName: "headless", pid: 111, ownerPid: 1, spawnedAt: 3000 }); // 去重
    const all = readStacksSync();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.pid === 111)!.spawnedAt).toBe(1000); // 首条保留
  });

  it("removeStackRecords 按 pid 清；removeStackRecordsForOwner 按 owner 清（空账删文件）", () => {
    appendStackRecord({ specName: "headless", pid: 111, ownerPid: 1, spawnedAt: 1000 });
    appendStackRecord({ specName: "headless", pid: 222, ownerPid: 2, spawnedAt: 2000 });
    removeStackRecords([111]);
    expect(readStacksSync().map((r) => r.pid)).toEqual([222]);
    removeStackRecordsForOwner(2);
    expect(readStacksSync()).toEqual([]);
  });

  it("文件缺失 / 损坏 / 非数组 → []（不抛，chrome-ledger 同容错）", () => {
    expect(readStacksSync()).toEqual([]); // 缺失
    writeFileSync(sidecar, "{corrupt", "utf8");
    expect(readStacksSync()).toEqual([]);
    writeFileSync(sidecar, '{"a":1}', "utf8");
    expect(readStacksSync()).toEqual([]);
  });

  it("stacksLedgerPath 尊重 LASSO_HEADLESS_STACKS_PATH 覆盖", () => {
    expect(stacksLedgerPath()).toBe(sidecar);
  });
});

// ============================================================
// 判杀真值表（三重判定 + R1 pid 归并）
// ============================================================
describe("headless-stack-ledger — 判杀真值表", () => {
  it("活 owner → 整组零动作（多 lasso server 并存合法；记录原样保留）", () => {
    const h = new SweepHarness();
    const LIVE_OWNER = 555_001;
    h.alivePids.add(LIVE_OWNER);
    const rec = h.stack(111, LIVE_OWNER); // owner 活
    writeRecords([rec]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([]);
    expect(r.skippedLiveOwner).toEqual([111]);
    expect(readStacksSync()).toHaveLength(1); // 零动作
  });

  it("全组 owner 死 + pid 已死（① 不成立）→ 只清记录", () => {
    const h = new SweepHarness();
    const rec = h.stack(111, 999_999);
    h.alivePids.delete(111); // 栈进程已死
    writeRecords([rec]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([]);
    expect(r.recordsClearedOnly).toEqual([111]);
    expect(readStacksSync()).toEqual([]);
  });

  it("全组 owner 死 + pid 活 + 包串不符（② 不成立：非 lasso 进程复用 pid）→ 只清绝不杀", () => {
    const h = new SweepHarness();
    const rec = h.stack(111, 999_999);
    h.cmdByPid.set(111, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"); // 用户浏览器
    writeRecords([rec]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([]); // 防误伤红线核心断言
    expect(r.recordsClearedOnly).toEqual([111]);
    expect(readStacksSync()).toEqual([]);
  });

  it("全组 owner 死 + ps 失败（null）→ fail-safe 只清绝不杀", () => {
    const h = new SweepHarness();
    const rec = h.stack(111, 999_999);
    h.cmdByPid.delete(111);
    writeRecords([rec]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([]);
    expect(r.recordsClearedOnly).toEqual([111]);
  });

  it("全组 owner 死 + lstart 比记录晚超容差（③ 不成立：pid 被任何新进程复用）→ 只清绝不杀", () => {
    const h = new SweepHarness();
    const spawnedAt = Date.now() - 60_000;
    const rec = h.stack(111, 999_999, spawnedAt);
    // pid 复用：新进程 lstart = spawnedAt + 10min（远晚于 +5s 前向容差）
    h.lstartByPid.set(111, new Date(spawnedAt + 600_000).toString());
    writeRecords([rec]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([]);
    expect(r.recordsClearedOnly).toEqual([111]);
    expect(readStacksSync()).toEqual([]);
  });

  it("全组 owner 死 + lstart 解析失败 → fail-safe 只清绝不杀（决议 §7 残余 3）", () => {
    const h = new SweepHarness();
    const rec = h.stack(111, 999_999);
    h.lstartByPid.set(111, "not a date at all");
    writeRecords([rec]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([]);
    expect(r.recordsClearedOnly).toEqual([111]);
  });

  it("全组 owner 死 + ①②③ 全过 → killTreeSync + 清组记录（孤儿栈回收正门）", () => {
    const h = new SweepHarness();
    const rec = h.stack(111, 999_999);
    writeRecords([rec]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([111]);
    expect(readStacksSync()).toEqual([]);
  });

  it("lstart 早于记录一个健康握手窗（-3s）→ 视为一致（spawnedAt 在握手完成后落笔）", () => {
    const h = new SweepHarness();
    const rec = h.stack(111, 999_999);
    h.alivePids.add(111);
    writeRecords([rec]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([111]); // 一致 → 杀
  });

  // ---------- R1 新增多记录行（pid 归并） ----------
  it("R1-A：陈旧记录（owner 死）与活记录（owner 活）同 pid → 整组不杀 + 只清陈旧条", () => {
    const h = new SweepHarness();
    const LIVE_OWNER = 555_002;
    h.alivePids.add(LIVE_OWNER);
    const spawnedAt = Date.now() - 120_000;
    const stale = h.stack(111, 888_888, spawnedAt); // 陈旧：owner 死（888_888 不在 alivePids）
    const live = h.stack(111, LIVE_OWNER, spawnedAt + 60_000); // 活：owner 活
    writeRecords([stale, live]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([]); // 整组零动作
    expect(r.skippedLiveOwner).toEqual([111]);
    const after = readStacksSync();
    expect(after).toHaveLength(1); // 只清陈旧条
    expect(after[0]!.ownerPid).toBe(LIVE_OWNER);
  });

  it("R1-B：全组 owner 死 + lstart 不符 → 只清记录绝不杀（跨记录 pid 复用封口）", () => {
    const h = new SweepHarness();
    const r1 = h.stack(111, 888_888, Date.now() - 120_000);
    const r2 = h.stack(111, 777_777, Date.now() - 60_000);
    // pid 复用形态：现持 pid 的进程 lstart 晚于两条记录 + 前向容差
    h.lstartByPid.set(111, new Date(Date.now() + 600_000).toString());
    writeRecords([r1, r2]);
    const r = sweepOrphanStacks(h.deps());
    expect(r.killed).toEqual([]);
    expect(r.recordsClearedOnly).toEqual([111]);
    expect(readStacksSync()).toEqual([]);
  });

  it("R1-C：真实事故序列复刻——server C 崩溃留孤儿栈 → pid 复用给活 server B 的栈 → 任何 logged_in spawn 触发扫除不误杀 B", () => {
    const h = new SweepHarness();
    const LIVE_OWNER_B = 555_003;
    h.alivePids.add(LIVE_OWNER_B);
    // C 的陈旧记录（owner 死；pid 111 的栈已消亡）
    const stale: HeadlessStackRecord = {
      specName: "logged_in:current",
      pid: 111,
      ownerPid: 888_888,
      spawnedAt: Date.now() - 600_000,
    };
    // B 的活记录：同 pid 111（复用），owner B 活
    const live = h.stack(111, LIVE_OWNER_B, Date.now() - 30_000);
    writeRecords([stale, live]);
    const r = sweepOrphanStacks(h.deps());
    // 逐记录独立判定会在 stale 条上满足「①活②包串同③C死」误杀 B 的活栈；
    // pid 归并版：整组零动作（变异红证：拆归并步骤 → 本用例红）
    expect(r.killed).toEqual([]);
    expect(r.skippedLiveOwner).toEqual([111]);
    const after = readStacksSync();
    expect(after.some((x) => x.ownerPid === LIVE_OWNER_B)).toBe(true);
  });

  it("空 sidecar → 零动作零写", () => {
    const h = new SweepHarness();
    const r = sweepOrphanStacks(h.deps());
    expect(r).toEqual({ killed: [], recordsClearedOnly: [], skippedLiveOwner: [] });
  });
});

// ============================================================
// parseLstartToEpochMs（平台差异容错，决议 §7 残余 3）
// ============================================================
describe("headless-stack-ledger — parseLstartToEpochMs", () => {
  it("macOS 形态（DAY MON DD HH:MM:SS YYYY，日字段双空格填充）可解析", () => {
    const epoch = parseLstartToEpochMs("Mon Sep 15 18:34:17 2026");
    expect(epoch).not.toBeNull();
    expect(Number.isFinite(epoch!)).toBe(true);
  });

  it("空串 / 垃圾串 / 双空格日字段 → null 或有限值（永不 NaN 上浮）", () => {
    expect(parseLstartToEpochMs("")).toBeNull();
    const garbage = parseLstartToEpochMs("garbage");
    expect(garbage === null || Number.isFinite(garbage)).toBe(true);
    const padded = parseLstartToEpochMs("Tue Sep  1 08:00:00 2026");
    expect(padded === null || Number.isFinite(padded)).toBe(true);
  });

  it("前向容差常量 = 5000（决议 ±5s）", () => {
    expect(LSTART_FORWARD_TOLERANCE_MS).toBe(5_000);
  });
});
