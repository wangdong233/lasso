/**
 * render-doctor.spec.ts（v1.19 渲染档设计决议 3.9 —— R4 孤儿检测 + 陈年 profile）
 *
 * 守护点（设计决议 §8.1）：
 *  - 孤儿检出：指纹对 + 无台账 + etime>10min 三重证据
 *  - 真身 Chrome（无指纹）零误伤；台账在案不是孤儿；年轻进程（<10min）不是孤儿
 *  - --clean 双证据护栏：指纹对 + profile 前缀命中才树杀 + rmSync；单证据只报告
 *  - dry-run 默认不动手
 *  - 陈年 profile：age>24h + 未被台账引用 → 报告 / --clean 删除；引用中/年轻不动
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  renderDoctor,
  parseEtimeSeconds,
  RENDER_ORPHAN_MIN_AGE_SEC,
} from "../../src/render/render-doctor.js";
import { recordLaunch, type LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";
import { RENDER_PROFILE_PREFIX } from "../../src/render/render-flags.js";

let tmpDir: string;
let ledgerPath: string;
let profileBase: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-render-doc-"));
  ledgerPath = path.join(tmpDir, "launched-chromes.json");
  profileBase = path.join(tmpDir, "profiles");
  await fs.mkdir(profileBase, { recursive: true });
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9224,
    pid: 4242,
    profileDir: path.join(profileBase, `${RENDER_PROFILE_PREFIX}owned-0001`),
    launchedAt: Date.now(),
    status: "ready",
    launchMode: "render",
    ...overrides,
  };
}

/** 伪造渲染档进程行（指纹对齐）。 */
function renderPsLine(pid: number, etime: string, profileDir?: string): string {
  const udd = profileDir ? ` --user-data-dir=${profileDir}` : "";
  return `${pid} ${etime} /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --no-sandbox --disable-gpu --font-render-hinting=full --run-all-compositor-stages-before-draw${udd} --remote-debugging-port=9224`;
}

describe("parseEtimeSeconds", () => {
  it("macOS/Linux etime 形态（mm:ss / hh:mm:ss / dd-hh:mm:ss）", () => {
    expect(parseEtimeSeconds("04:55")).toBe(4 * 60 + 55);
    expect(parseEtimeSeconds("1:02:03")).toBe(3723);
    expect(parseEtimeSeconds("1-03:04:05")).toBe(86_400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseEtimeSeconds("garbage")).toBe(0);
    expect(parseEtimeSeconds("")).toBe(0);
  });
});

describe("孤儿检测（三重证据）", () => {
  it("指纹对 + 无台账 + etime>10min → 检出；--clean 双证据命中才树杀 + rmSync", async () => {
    const orphanProfile = path.join(profileBase, `${RENDER_PROFILE_PREFIX}orphan-0001`);
    await fs.mkdir(orphanProfile, { recursive: true });
    writeFileSync(path.join(orphanProfile, "lockfile"), "x");
    const kills: Array<[number, string?]> = [];
    const report = renderDoctor({
      profileBaseDir: profileBase,
      psAllFn: () => renderPsLine(55801, "15:00", orphanProfile),
      readLedgerFn: () => [],
      clean: true,
      killTreeFn: (pid, tag) => void kills.push([pid, tag]),
    });
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]).toMatchObject({ pid: 55801, cleanable: true, profileDir: orphanProfile });
    expect(report.cleaned.orphansKilled).toBe(1);
    expect(kills).toEqual([[55801, "render-doctor:55801"]]);
    await expect(fs.stat(orphanProfile)).rejects.toThrow(); // profile 连带删
  });

  it("真身 Chrome（无指纹对）零误伤；单旗标撞他家用法不命中", () => {
    const kills: Array<[number, string?]> = [];
    const report = renderDoctor({
      profileBaseDir: profileBase,
      psAllFn: () =>
        [
          "60001 20:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/Users/x/Library/Application Support/Google/Chrome",
          "60002 20:00 some-browser --run-all-compositor-stages-before-draw",
          "60003 20:00 some-browser --font-render-hinting=full",
        ].join("\n"),
      readLedgerFn: () => [],
      clean: true,
      killTreeFn: (pid, tag) => void kills.push([pid, tag]),
    });
    expect(report.orphans).toEqual([]);
    expect(kills).toEqual([]);
  });

  it("台账在案（lasso 拥有）不是孤儿；年轻进程（<10min）不是孤儿", async () => {
    const owned = makeRec({ pid: 55802 });
    await recordLaunch(owned);
    const report = renderDoctor({
      profileBaseDir: profileBase,
      psAllFn: () =>
        [
          renderPsLine(55802, "20:00", owned.profileDir), // 在案 → 非孤儿
          renderPsLine(55803, "05:00"), // 年轻（<10min）→ 非孤儿（拉起窗口竞态容忍）
        ].join("\n"),
    });
    expect(report.orphans).toEqual([]);
  });

  it("指纹对但 --user-data-dir 无 render 前缀（单证据）→ 只报告 cleanable:false，--clean 也不动手", () => {
    const kills: Array<[number, string?]> = [];
    const report = renderDoctor({
      profileBaseDir: profileBase,
      psAllFn: () => renderPsLine(55804, "15:00", "/tmp/puppeteer_dev_chrome_profile-xyz"),
      readLedgerFn: () => [],
      clean: true,
      killTreeFn: (pid, tag) => void kills.push([pid, tag]),
    });
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]!.cleanable).toBe(false);
    expect(report.orphans[0]!.profileDir).toBeUndefined();
    expect(report.cleaned.orphansKilled).toBe(0);
    expect(kills).toEqual([]);
  });

  it("dry-run 默认不动手（检出但不杀）", async () => {
    const orphanProfile = path.join(profileBase, `${RENDER_PROFILE_PREFIX}orphan-0002`);
    await fs.mkdir(orphanProfile, { recursive: true });
    const kills: Array<[number, string?]> = [];
    const report = renderDoctor({
      profileBaseDir: profileBase,
      psAllFn: () => renderPsLine(55805, "15:00", orphanProfile),
      readLedgerFn: () => [],
      killTreeFn: (pid, tag) => void kills.push([pid, tag]),
    });
    expect(report.orphans).toHaveLength(1);
    expect(report.clean).toBe(false);
    expect(report.cleaned).toEqual({ orphansKilled: 0, profilesRemoved: 0 });
    expect(kills).toEqual([]);
    await expect(fs.stat(orphanProfile)).resolves.toBeTruthy();
  });
});

describe("陈年 profile 扫描", () => {
  it("age>24h 且未被台账引用 → 报告；--clean 删除；引用中/年轻不动", async () => {
    const stale = path.join(profileBase, `${RENDER_PROFILE_PREFIX}stale-0001`);
    const fresh = path.join(profileBase, `${RENDER_PROFILE_PREFIX}fresh-0001`);
    const owned = path.join(profileBase, `${RENDER_PROFILE_PREFIX}owned-0001`);
    for (const d of [stale, fresh, owned]) await fs.mkdir(d, { recursive: true });
    const now = Date.now();
    utimesSync(stale, new Date(now - 25 * 3_600_000), new Date(now - 25 * 3_600_000));
    utimesSync(owned, new Date(now - 48 * 3_600_000), new Date(now - 48 * 3_600_000));
    // fresh 保持当前 mtime
    await recordLaunch(makeRec({ profileDir: owned }));

    // dry-run：只报告
    const r1 = renderDoctor({ profileBaseDir: profileBase, psAllFn: () => "" });
    expect(r1.staleProfiles.map((s) => path.basename(s.dir))).toEqual([
      `${RENDER_PROFILE_PREFIX}stale-0001`,
    ]);
    // owned 年龄虽老但被台账引用 → 不列；fresh 年轻 → 不列

    // --clean：删除陈年未引用
    const r2 = renderDoctor({ profileBaseDir: profileBase, psAllFn: () => "", clean: true });
    expect(r2.cleaned.profilesRemoved).toBe(1);
    await expect(fs.stat(stale)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeTruthy();
    await expect(fs.stat(owned)).resolves.toBeTruthy();
  });

  it("非前缀目录不受扫描影响", async () => {
    const other = path.join(profileBase, "chrome-profile-default");
    mkdirSync(other, { recursive: true });
    utimesSync(other, new Date(0), new Date(0));
    const r = renderDoctor({ profileBaseDir: profileBase, psAllFn: () => "" });
    expect(r.staleProfiles).toEqual([]);
  });
});
