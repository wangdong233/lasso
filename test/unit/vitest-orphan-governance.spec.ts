/**
 * vitest-orphan-governance.spec.ts（BUG-08 F，2026-09-15——vitest 孤儿进程治理）
 *
 * 事故（用户实锤）：lasso 测试残留的 vitest forks-pool worker 孤儿群把整机负载打到
 * 188（单 worker 87% CPU）。机理 = agent/进程被中断时 vitest 主进程死而 worker
 * 子进程存活自旋。
 *
 * 白盒（vitest 2.1.9 dist/config.js:99 `pool: "forks"`——CLI help 的 "default:
 * threads" 是误导文案，resolver 实际缺省 forks）+ 真机复刻（本 spec 的行为组）：
 *  - forks：SIGKILL(主) 后忙 worker 存活（marker 实证 pid ≠ 主 pid）→ 事故形态；
 *  - threads：worker = 主进程内线程（marker pid == 主 pid），主死线程死 → 结构性消灭。
 *
 * 治理两层：
 *  1. 结构层：生产 vitest.workspace.ts 两 project 显式钉 pool "threads"（纯锚组）；
 *  2. belt 层：gate.mjs 的 vitest 步骤走 runWithBelt（async spawn + 超时竞赛）——
 *     belt 到点在**树根仍活**时 killTreeSync 整树（E1 白盒实锤：spawnSync timeout
 *     只 SIGTERM 直子 npx 且返回时根已死 → 忙 worker 漏杀；本 spec 行为组三钉之）。
 *
 * 本 spec 在 SLOW_SPECS 桶（真 spawn 嵌套 vitest，>5s 窗口）。
 */
import { describe, it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { killTreeSync } from "../../src/util/kill-tree.js";
import {
  parseGateVitestBeltMs,
  runWithBelt,
  DEFAULT_GATE_VITEST_BELT_MS,
  vitestSummary as libVitestSummary,
} from "../../scripts/gate-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const FIXTURE_DIR = join(REPO, "test", "fixtures", "vitest-orphan-probe");
const VITEST_BIN = join(REPO, "node_modules", ".bin", "vitest");

const workspaceText = readFileSync(join(REPO, "vitest.workspace.ts"), "utf8");
const gateText = readFileSync(join(REPO, "scripts", "gate.mjs"), "utf8");
const gateLibText = readFileSync(join(REPO, "scripts", "gate-lib.mjs"), "utf8");

/** 从生产 workspace 提取池选择（夹具运行跟随生产——防"夹具绿、生产红"漂移）。 */
function productionPool(): string {
  const m = workspaceText.match(/const ORPHAN_GUARD_POOL = "(threads|forks|vmThreads)"/);
  if (!m) throw new Error("vitest.workspace.ts 未钉 ORPHAN_GUARD_POOL 常量");
  return m[1]!;
}

// ============================================================
// 一、纯锚组（mutation 守卫：治理结构回退即红，零 spawn 秒级判）
// ============================================================
describe("BUG-08 F — 生产池钉死（结构层锚）", () => {
  it("vitest.workspace.ts 两 project 显式 pool threads（ORPHAN_GUARD_POOL 常量）——回退 forks/缺省即红", () => {
    expect(productionPool()).toBe("threads"); // 变异样本 1：常量改 "forks" → 红
    // 两 project 都必须用常量钉（少一个 project = 部分回退）。变异样本 2：删任一行 → 红
    const uses = workspaceText.match(/pool: ORPHAN_GUARD_POOL/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it("治理注释锚在场（BUG-08 F 出处 + forks 事故机理——防后人无据回退）", () => {
    expect(workspaceText).toMatch(/BUG-08 F（2026-09-15）：pool 显式钉死 "threads"/);
    expect(workspaceText).toMatch(/忙 worker 存活自旋/);
    // 本 spec 自身在 SLOW_SPECS 注册（嵌套 vitest 是重 spawn 型，禁进 5s 默认桶）
    expect(workspaceText).toMatch(/"test\/unit\/vitest-orphan-governance\.spec\.ts"/);
  });
});

describe("BUG-08 F — gate 追杀带接线（belt 层锚）", () => {
  it("gate.mjs：vitest 步骤走 runWithBelt + 异常终态触发追杀 + 判绿含 abnormal + belt 预算可调", () => {
    // 变异样本 3：拆 runWithBelt 接线 / 拆 abnormal 追杀 / 判绿漏 abnormal → 红
    expect(gateText).toMatch(/await runWithBelt\("vitest run（全量）", "npx", \["vitest", "run"\]/);
    expect(gateText).toMatch(/if \(vitest\.abnormal\) \{/);
    expect(gateText).toMatch(/vitest\.beltFired/); // 超时路径（belt 已整杀）与外部击杀路径（死后 best-effort）分流
    expect(gateText).toMatch(/await chaseVitestTree\(vitest\.pid/);
    expect(gateText).toMatch(/vitest\.ok && !vitest\.abnormal && vSum\.failedFiles === 0/);
    expect(gateText).toMatch(/LASSO_GATE_VITEST_TIMEOUT_MS/);
    // 🔴 E1 反面锚（2026-09-15 白盒实锤）：spawnSync timeout 不能作 belt 载体——
    // 它只对直子（npx）发 SIGTERM，且返回时根已死、pgrep -P 恒空 → 忙 worker 漏杀
    expect(gateText).not.toMatch(/timeoutMs: beltMs/);
  });

  it("gate-lib runWithBelt：belt 在树根存活时 killTreeSync（先枚举后杀单趟）；单一真源纪律零第二份 pgrep 递归", () => {
    // 变异样本 4：belt 改为「返回后追杀」（spawnSync timeout 形态）→ 时序锚红；
    // gate-lib 内联自写 pgrep 递归 → 红（kill-tree.ts 头注禁第二份实现）
    expect(gateLibText).toMatch(/runWithBelt/);
    expect(gateLibText).toMatch(/killTreeSync\(pid, "gate:vitest-belt"\)/); // belt timer 内、根活时调用
    expect(gateLibText).toMatch(/dist\/util\/kill-tree\.js/);
    expect(gateLibText).not.toMatch(/"pgrep"/); // 枚举只能发生在 kill-tree.ts（真源）
    expect(gateLibText).not.toMatch(/spawnSync\(/); // async spawn 载体（spawnSync 返回时根已死）
    // vitestSummary 原样搬出（§14 判绿权威源不因重构漂移）
    const s = libVitestSummary(" Test Files  3 failed | 41 passed (44)\n      Tests  5 failed | 900 passed | 3 skipped (908)\n");
    expect(s.failedFiles).toBe(3);
    expect(s.failedTests).toBe(5);
    expect(s.tests).toContain("3 skipped");
  });

  it("parseGateVitestBeltMs 三态：未设→缺省 20min / 合法覆盖 / 非法（NaN、负、0、小数截断）→ 缺省", () => {
    expect(DEFAULT_GATE_VITEST_BELT_MS).toBe(20 * 60_000);
    expect(parseGateVitestBeltMs(undefined)).toBe(DEFAULT_GATE_VITEST_BELT_MS);
    expect(parseGateVitestBeltMs("")).toBe(DEFAULT_GATE_VITEST_BELT_MS);
    expect(parseGateVitestBeltMs("60000")).toBe(60_000);
    expect(parseGateVitestBeltMs("abc")).toBe(DEFAULT_GATE_VITEST_BELT_MS);
    expect(parseGateVitestBeltMs("-1")).toBe(DEFAULT_GATE_VITEST_BELT_MS); // 负 belt = 永不追杀的静默陷阱 → 拒
    expect(parseGateVitestBeltMs("0")).toBe(DEFAULT_GATE_VITEST_BELT_MS);
    expect(parseGateVitestBeltMs("1500.9")).toBe(1500); // 正小数截断（Number 合法形态）
  });
});

// ============================================================
// 二、行为组（真机复刻：嵌套 spawn vitest → 杀主 → 数孤儿）
// ============================================================
function isAlive(pid: number | undefined | null): boolean {
  if (pid === undefined || pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** pgrep -P 直调枚举直接子进程（execFileSync 无 shell 层——PERF-5 假阳性教训）。 */
function childPids(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // pgrep 退出码 1 = 无子进程
  }
}

/** 父 pid 读取（ps -o ppid=，无 shell 层）。 */
function parentPid(pid: number): number {
  try {
    return Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

/** 递归后代枚举（kill-tree.ts 同型遍历，只读版）。 */
function descendantsOf(pid: number): number[] {
  const out: number[] = [];
  const queue = [pid];
  let guard = 0;
  while (queue.length > 0 && guard++ < 64) {
    const p = queue.shift()!;
    for (const c of childPids(p)) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

interface ProbeRun {
  mainPid: number;
  markerPath: string;
  stdout: string;
  proc: ReturnType<typeof spawn>;
}

/** 嵌套拉起 vitest（夹具 cwd），等 marker 落盘（= 探针测试体已进入长睡）。 */
async function spawnProbeVitest(pool: string, markerPath: string): Promise<ProbeRun> {
  const proc = spawn(VITEST_BIN, ["run", "--pool", pool], {
    cwd: FIXTURE_DIR,
    env: { ...process.env, LASSO_ORPHAN_PROBE_MARKER: markerPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  proc.stdout!.on("data", (d) => (stdout += String(d)));
  proc.stderr!.on("data", (d) => (stdout += String(d)));
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return { mainPid: proc.pid!, markerPath, stdout, proc };
    if (proc.exitCode !== null) {
      throw new Error(`nested vitest exited early (code ${proc.exitCode}): ${stdout.slice(0, 600)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  killTreeSync(proc.pid!, "orphan-spec-spawn-timeout");
  throw new Error(`nested vitest marker timeout (25s): ${stdout.slice(0, 600)}`);
}

/** 等 pid 死（宽限内轮询）；返回是否已死。 */
async function waitDead(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

describe("BUG-08 F — 行为复刻：SIGKILL(vitest main) 后 worker 残留判定", () => {
  it("生产池（threads）：worker 是主进程线程（marker pid == main pid）→ 杀主后零孤儿", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lasso-orph-threads-"));
    const markerPath = join(dir, "marker");
    let mainPid = 0;
    try {
      const run = await spawnProbeVitest(productionPool(), markerPath);
      mainPid = run.mainPid;
      const descendants = descendantsOf(mainPid); // 运行期快照（threads 下无 node worker 子进程，至多瞬时 esbuild）
      const workerPid = Number(readFileSync(markerPath, "utf8").trim());
      // threads 池身份证据：探针测试体的 pid 就是主进程 pid（线程无独立 pid）
      expect(workerPid).toBe(mainPid);

      process.kill(mainPid, "SIGKILL"); // 事故形态：主进程被硬杀
      await waitDead(mainPid, 3_000);
      expect(isAlive(mainPid)).toBe(false);
      // 宽限 2s 后快照存活后代；**先追杀再断言**——本测试若因治理回退变红，
      // 也不能把孤儿留在机器上（自清洁红线：红而干净，不红而泄漏）。
      await new Promise((r) => setTimeout(r, 2_000));
      const survivors = descendants.filter((p) => isAlive(p));
      for (const p of survivors) killTreeSync(p, "orphan-spec-threads-defensive");
      expect(survivors).toEqual([]); // threads 池下永不为空以外的情况 = 孤儿类复活
      mainPid = 0; // 全部验证过——无需兜底
    } finally {
      // 兜底：任一断言中途抛出（如治理回退红）也不能让嵌套 vitest 整树存活
      if (mainPid !== 0 && isAlive(mainPid)) killTreeSync(mainPid, "orphan-spec-threads-finally");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("对照池（forks）：忙 worker 在杀主后存活（事故复刻）→ killTreeSync 追杀后零残留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lasso-orph-forks-"));
    const markerPath = join(dir, "marker");
    let mainPid = 0;
    try {
      const run = await spawnProbeVitest("forks", markerPath);
      mainPid = run.mainPid;
      const descendants = descendantsOf(mainPid);
      const workerPid = Number(readFileSync(markerPath, "utf8").trim());
      // forks 池身份证据：worker 是独立子进程（pid ≠ 主 pid）——这正是孤儿源
      expect(workerPid).not.toBe(mainPid);
      expect(descendants).toContain(workerPid);

      process.kill(mainPid, "SIGKILL"); // 用户事故同型：agent 中断杀掉 vitest 主进程
      await waitDead(mainPid, 3_000);
      expect(isAlive(mainPid)).toBe(false);
      // 🔴 事故形态：忙 worker（120s 长睡中的探针）在主死后仍存活——孤儿实证
      await new Promise((r) => setTimeout(r, 1_500));
      const orphaned = descendants.filter((p) => isAlive(p));
      expect(orphaned).toContain(workerPid); // 变异锚：threads 生产回退 forks 时，本断言 = 事故重演现场

      // belt 同型追杀（gate-lib 的树杀真源）：对残留孤儿整树 SIGKILL → 零残留
      for (const p of orphaned) killTreeSync(p, "orphan-spec-pursuit");
      await new Promise((r) => setTimeout(r, 1_000));
      const after = descendants.filter((p) => isAlive(p));
      expect(after).toEqual([]);
      mainPid = 0; // 全部验证过——无需兜底
    } finally {
      // 兜底：任一断言中途抛出也不能让 forks 池孤儿存活（对照池事故形态最危险）
      if (mainPid !== 0 && isAlive(mainPid)) killTreeSync(mainPid, "orphan-spec-forks-finally");
      else if (mainPid !== 0) {
        for (const p of descendantsOf(mainPid)) if (isAlive(p)) killTreeSync(p, "orphan-spec-forks-finally");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ============================================================
// 三、gate belt 行为组（runWithBelt 真机钉——超时路径「根活树杀」时序）
// ============================================================
describe("BUG-08 F — gate belt（runWithBelt）超时路径：根活时整树 SIGKILL", () => {
  it("健康路径：子进程自然退出 → ok/退出码/输出语义与 spawnSync 等价，belt 不开火", async () => {
    const r = await runWithBelt("probe-ok", "node", ["-e", "console.log('belt-ok-marker')"], {
      beltMs: 10_000,
    });
    expect(r.beltFired).toBe(false);
    expect(r.abnormal).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(0);
    expect(r.out).toContain("belt-ok-marker");
  }, 15_000);

  it("超时路径（事故形态复刻）：forks 忙 worker 长睡中 belt 到点 → 整树（含 npx→vitest→worker）零存活", async () => {
    // E1 白盒（2026-09-15）：SIGTERM(npx) 后 vitest main 优雅死、空闲 worker 随死，
    // 但忙 worker 原样存活（孤儿事故形态）；死根 pgrep 恒空。belt 必须在根活时
    // killTreeSync（先枚举后杀单趟）——本测试就是对该时序的行为钉。
    const dir = mkdtempSync(join(tmpdir(), "lasso-orph-belt-"));
    const markerPath = join(dir, "marker");
    const beltLogs: string[] = [];
    try {
      // belt 12s：夹具冷启动 ~3s + marker 落盘后忙睡中；belt 开火时探针必在 120s 长睡内
      const beltP = runWithBelt(
        "belt-fixture",
        "npx",
        ["vitest", "run", "--pool", "forks"],
        {
          beltMs: 12_000,
          cwd: FIXTURE_DIR,
          env: { ...process.env, LASSO_ORPHAN_PROBE_MARKER: markerPath },
          log: (m: string) => beltLogs.push(m),
        },
      );
      // 等 marker（探针测试体已进入长睡），从 worker 沿 ppid 链上溯 npx 根，快照整树（belt 开火前）
      const deadline = Date.now() + 25_000;
      while (!existsSync(markerPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(existsSync(markerPath)).toBe(true);
      const workerPid = Number(readFileSync(markerPath, "utf8").trim());
      // 🔴 父链稳定窗（2026-09-18 flake 收口）：marker 出现 ≠ vitest main 的父已挂上
      // npx——高载下进程表登记可滞后，parentPid 偶返 ≤1（实测全量并发 1 红复现）。
      // 轮询至 npx 根可见（≤10s），超窗才断言——树快照语义（belt 开火前全树在册）不变。
      let vitestMainPid = parentPid(workerPid); // forks 池：worker 的父 = vitest main
      let npxRootPid = parentPid(vitestMainPid); // vitest main 的父 = npx（belt 的树根）
      const rootDeadline = Date.now() + 10_000;
      while (npxRootPid <= 1 && Date.now() < rootDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        vitestMainPid = parentPid(workerPid);
        npxRootPid = parentPid(vitestMainPid);
      }
      const treeSnapshot = [npxRootPid, vitestMainPid, ...descendantsOf(npxRootPid)];
      expect(npxRootPid).toBeGreaterThan(1);

      const r = await beltP;
      // belt 开火 + 异常终态 + 恒红
      expect(r.beltFired).toBe(true);
      expect(r.abnormal).toBe(true);
      expect(r.ok).toBe(false);
      expect(beltLogs.length).toBeGreaterThan(0);
      expect(beltLogs[0]).toMatch(/root pid=\d+/);

      // 整树零存活：npx 根 / vitest main / 忙 worker（E1 中 SIGTERM(npx) 后的幸存者）
      // ——belt 的「根活时先枚举后杀」时序下一个不剩；「返回后追杀」形态在此必红
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const p of treeSnapshot) {
        if (await waitDead(p, 3_000)) continue;
        killTreeSync(p, "orphan-spec-belt-defensive");
        throw new Error(`belt 后仍有存活树成员 pid=${p}（根活树杀时序失效）`);
      }
    } finally {
      // 兜底：从 belt 日志解析 root pid，树残留防御性追杀（红也要红得干净）
      const rootPid = Number((beltLogs[0]?.match(/root pid=(\d+)/) ?? [])[1] ?? 0);
      if (rootPid > 0) killTreeSync(rootPid, "orphan-spec-belt-finally");
      if (existsSync(markerPath)) {
        const w = Number(readFileSync(markerPath, "utf8").trim());
        if (Number.isInteger(w) && isAlive(w)) killTreeSync(w, "orphan-spec-belt-finally");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
