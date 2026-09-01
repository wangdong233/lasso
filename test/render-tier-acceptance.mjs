#!/usr/bin/env node
/**
 * render-tier-acceptance.mjs（v1.19 渲染档 —— 验收脚本真跑自动化）
 *
 * 需求《需求-渲染档浏览器治理.md》§五 验收命令脚本 0-4 条的固化真跑版（照抄命令
 * 语义，断言机械化），产出逐条 PASS/FAIL + 真实输出证据：
 *
 *   0 清场        render-chrome --stop 幂等 + 指纹计数 0（零误伤日常 Chrome/真身）
 *   1 ensure 契约  exit 0 + stdout 单行 JSON 字段齐（wsEndpoint/port/startedAt/
 *                 reused/touchPath/pid）+ 命令行含确定性旗标对指纹
 *   2 幂等        二次 ensure → reused:true（同 wsEndpoint/pid）
 *   3 SIGKILL 免疫 真实 attach 消费方被 kill -9 后渲染档存活；压缩 idle
 *                 （LASSO_RENDER_IDLE_MS=30000）+ 宽限后回收；profile 目录清零；
 *                 guardian 账空自退
 *   4 mode 过滤   chrome-stop --modes hidden 不动渲染档；--modes render 可收
 *  （5 旗标活对照  可选 --consumer-repo=<path>：§一.4 导出脚本活导出消费方
 *                 puppeteer 全集 vs 渲染档实际命令行 diff——零差或逐条解释）
 *
 * 用法：
 *   npm run build && node test/render-tier-acceptance.mjs [--consumer-repo=<abs path>]
 *
 * 运行面注意：
 *  - 真机真 Chrome（默认端口 9224 + 真实 ~/.cache/lasso 台账/profile）——这是验收
 *    语义（消费方迁移条件），不是隔离单测；跑完自动清场（stop + profile 断言归零）
 *  - 指纹计数期望 = 判活 ≥1 / 判死 === 0（P2-6：真机 ps 计数 = 1 主进程 + 3 helper
 *    继承全旗标 argv = 4；需求原文「期望 1」按 r4 复审读作 ≥1）
 *  - P2-7 混跑窗口防护：item 3 压缩 guardian tick（1s）抢先收割——旧版 lasso server
 *    （无 profile 清理）的 15s reaper 同读默认台账，慢 tick 落败即零干扰（r4 同法）
 *  - item 3 前显式优雅停掉 item 1/2 拉起的默认参数 guardian（SIGTERM 统一收口），
 *    使压缩 env 的新 guardian 得以补拉——这同时验证「guardian 死后 ensure respawn」
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
if (!existsSync(DIST_ENTRY)) {
  console.error("dist/index.js 不存在——先跑 `npm run build`（验收脚本跑 dist 产物）");
  process.exit(2);
}

// ---- 常量（与 src/render/render-flags.ts 同源；活对照在 item 5 直接 import dist）----
const RENDER_PORT = 9224;
const FP_A = "--run-all-compositor-stages-before-draw";
const FP_B = "--font-render-hinting=full";
const PROFILE_PREFIX = "render-chrome-profile-";
const CACHE_DIR = path.join(os.homedir(), ".cache", "lasso");
const LEDGER_PATH = path.join(CACHE_DIR, "launched-chromes.json");
const GUARDIAN_PIDFILE = path.join(CACHE_DIR, "render-guardian.json");
const CONSUMER_FLAGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--font-render-hinting=full",
  "--force-color-profile=srgb",
  "--run-all-compositor-stages-before-draw",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

// ---- CLI arg ----
const consumerRepoArg = process.argv.find((a) => a.startsWith("--consumer-repo="));
const CONSUMER_REPO = consumerRepoArg ? path.resolve(consumerRepoArg.slice("--consumer-repo=".length)) : null;

// ============================================================
// 证据收集
// ============================================================
const results = [];
function pass(item, label, evidence = "") {
  results.push({ item, label, ok: true });
  console.log(`[PASS ${item}] ${label}${evidence ? ` —— ${evidence}` : ""}`);
}
function fail(item, label, evidence = "") {
  results.push({ item, label, ok: false });
  console.log(`[FAIL ${item}] ${label}${evidence ? ` —— ${evidence}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// helpers
// ============================================================
function runCli(args, { env = {}, timeoutMs = 40_000 } = {}) {
  const r = spawnSync(process.execPath, [DIST_ENTRY, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** ps 全表（stat 列 included）；读失败（status≠0 / 行数异常少）→ psOk:false。 */
function psTable() {
  const r = spawnSync("ps", ["-Axo", "pid=,stat=,command="], { encoding: "utf8", timeout: 8_000 });
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim() !== "");
  return { psOk: r.status === 0 && lines.length > 50, lines };
}

/**
 * 指纹计数（FP_A 单旗标——需求 §五 命令同源）；paired = 同时含 FP_B（成对指纹）。
 * 防两类假读：①ps 读失败（status≠0/空表）→ psOk:false（调用方按「未知」重试，
 * 绝不当 0——首轮真机验收即抓到单次 ps 空读把活 Chrome 误判已收割）；②僵尸行
 * （stat Z，被杀待收尸的残留 argv）不计——已死进程不是「在世渲染档」。
 */
function fingerprintCount({ paired = false } = {}) {
  const { psOk, lines } = psTable();
  if (!psOk) return { n: -1, psOk: false };
  const n = lines.filter((l) => {
    if (!l.includes(FP_A) || (paired && !l.includes(FP_B))) return false;
    const stat = l.trim().split(/\s+/)[1] ?? "";
    return !stat.startsWith("Z");
  }).length;
  return { n, psOk: true };
}

/** 判活（≥1；P2-6：1 主 + helper 继承 argv，需求「期望 1」读作 ≥1）；ps 假读重试至多 3 次。 */
async function fingerprintAlive({ paired = false } = {}) {
  for (let i = 0; i < 3; i++) {
    const { n, psOk } = fingerprintCount({ paired });
    if (psOk) return n;
    await sleep(400);
  }
  return -1; // 三连读失败——诚实返回未知
}

/** 判死（连续 N 次干净读 0；N=2 防单次假读）。 */
async function fingerprintDeadConsecutive(pollMs = 1_000, consecutive = 2) {
  let streak = 0;
  for (let i = 0; i < 6; i++) {
    const { n, psOk } = fingerprintCount();
    if (psOk) streak = n === 0 ? streak + 1 : 0;
    else streak = 0;
    if (streak >= consecutive) return true;
    await sleep(pollMs);
  }
  return false;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function psPidCommand(pid) {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3_000 });
  return (r.stdout ?? "").trim();
}

function renderProfileDirs() {
  try {
    return readdirSync(CACHE_DIR).filter((d) => d.startsWith(PROFILE_PREFIX));
  } catch {
    return [];
  }
}

function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return [];
  }
}

function readGuardianPid() {
  try {
    return JSON.parse(readFileSync(GUARDIAN_PIDFILE, "utf8")).pid;
  } catch {
    return null;
  }
}

/**
 * 等待条件为真：连续 confirmN 次为真才返回（防单次假读——pidAlive 竞态/台账读
 * 失败退 [] 都会单次假真）；超时返回 null。
 * 🔴 语义注：本函数「条件为真」即收。首轮验收曾写反语义（条件为假才收）——
 * 活 Chrome 被瞬间判定已收割，下游 3.4/3.5/4.1 全链误报，白盒最小化重读才定位。
 */
async function waitForTrue(condFn, timeoutMs, pollMs = 500, confirmN = 2) {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  while (Date.now() < deadline) {
    if (condFn()) {
      streak++;
      if (streak >= confirmN) return Date.now();
    } else {
      streak = 0;
    }
    await sleep(pollMs);
  }
  return null;
}

/** 解析 ensure stdout：单行 JSON（stdout 纯净性硬约束）。 */
function parseEnsureOut(stdout) {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length !== 1) throw new Error(`stdout 非单行（${lines.length} 行）: ${JSON.stringify(lines.slice(0, 3))}`);
  return JSON.parse(lines[0]);
}

// ============================================================
// item 0 清场
// ============================================================
console.log("==== 0) 清场：render-chrome --stop 幂等 + 指纹归零 ====");
const baselineProfiles = renderProfileDirs();
const baselineLedger = readLedger();
{
  const r = runCli(["render-chrome", "--stop"]);
  if (r.status !== 0) fail("0.1", "--stop 退出码 0", `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
  else {
    let parsed;
    try {
      parsed = JSON.parse(r.stdout.trim());
      if (!Array.isArray(parsed.stopped)) throw new Error("stopped 非数组");
      pass("0.1", "--stop 幂等 exit 0", `stdout=${r.stdout.trim().slice(0, 120)}`);
    } catch (e) {
      fail("0.1", "--stop stdout 可解析 {stopped:[]}", `${e}; stdout=${r.stdout.slice(0, 200)}`);
    }
  }
  const c = await fingerprintAlive();
  if (c === 0) pass("0.2", `指纹计数 0（无遗留渲染档；基线 profile 目录 ${baselineProfiles.length} 个）`);
  else
    fail(
      "0.2",
      "指纹计数 0",
      `实际 ${c}——疑似孤儿（>10min 无台账），先跑 \`node dist/index.js render-chrome doctor --clean\``,
    );
}

// ============================================================
// item 1 ensure 契约
// ============================================================
console.log("\n==== 1) ensure：exit 0 + stdout 单行 JSON 字段齐 + 旗标对指纹 ====");
let ensure1 = null;
{
  const r = runCli(["render-chrome", "--ensure"]);
  if (r.status !== 0) {
    fail("1.1", "ensure exit 0", `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
  } else {
    try {
      ensure1 = parseEnsureOut(r.stdout);
      pass("1.1", "exit 0 + stdout 单行 JSON", `reused=${ensure1.reused} port=${ensure1.port} pid=${ensure1.pid}`);
    } catch (e) {
      fail("1.1", "stdout 单行 JSON", String(e));
    }
  }
  if (ensure1) {
    const checks = [
      ["wsEndpoint 形状", typeof ensure1.wsEndpoint === "string" && /^ws:\/\/127\.0\.0\.1:9224\/devtools\/browser\//.test(ensure1.wsEndpoint)],
      ["port === 9224", ensure1.port === 9224],
      ["startedAt 为 epoch ms", Number.isFinite(ensure1.startedAt) && ensure1.startedAt > 0],
      ["reused === false（清场后 fresh）", ensure1.reused === false],
      ["touchPath = chrome-touch-9224", ensure1.touchPath === path.join(CACHE_DIR, "chrome-touch-9224")],
      ["pid 为数字", Number.isInteger(ensure1.pid)],
    ];
    for (const [label, ok] of checks) (ok ? pass : fail)(`1.2`, label, ok ? "" : JSON.stringify(ensure1).slice(0, 200));
    // ensure 自 touch（宽限）→ 文件在且新鲜
    try {
      const mtime = statSync(ensure1.touchPath).mtimeMs;
      Date.now() - mtime < 60_000
        ? pass("1.3", "touchPath 文件已建（ensure 自 touch）", `mtime 距今 ${Math.round(Date.now() - mtime)}ms`)
        : fail("1.3", "touchPath 文件新鲜", `mtime 距今 ${Date.now() - mtime}ms`);
    } catch (e) {
      fail("1.3", "touchPath 文件存在", String(e));
    }
  }
  // 旗标对指纹（需求 §五 1：grep --font-render-hinting=full ≥1；P2-6：判活期望 ≥1）
  const cA = await fingerprintAlive();
  const cPair = await fingerprintAlive({ paired: true });
  if (cA >= 1 && cPair >= 1)
    pass("1.4", "命令行含确定性旗标对指纹", `FP_A 计数=${cA}（1 主 + helper 继承 argv，P2-6 口径 ≥1）；成对命中=${cPair}`);
  else fail("1.4", "旗标对指纹命中", `FP_A=${cA} paired=${cPair}`);
}

// ============================================================
// item 2 幂等 reused
// ============================================================
console.log("\n==== 2) 幂等：二次 ensure → reused:true ====");
if (ensure1) {
  const r = runCli(["render-chrome", "--ensure"]);
  let ok = r.status === 0;
  let j = null;
  try {
    j = parseEnsureOut(r.stdout);
  } catch (e) {
    ok = false;
    fail("2.1", "二次 ensure stdout 单行可解析", String(e));
  }
  if (j) {
    const same = j.reused === true && j.wsEndpoint === ensure1.wsEndpoint && j.pid === ensure1.pid && j.port === 9224;
    (ok && same)
      ? pass("2.1", "reused:true + 同 wsEndpoint/pid（零重拉）", `pid=${j.pid} reused=${j.reused}`)
      : fail("2.1", "reused:true 同实例", `status=${r.status} out=${JSON.stringify(j)}`);
  }
} else {
  fail("2.1", "依赖 item 1", "item 1 失败跳过");
}

// ============================================================
// item 3 SIGKILL 免疫 + 压缩 idle 回收 + profile 删除
// ============================================================
console.log("\n==== 3) SIGKILL 免疫 + idle 回收（LASSO_RENDER_IDLE_MS=30000 压缩）+ profile 清零 ====");
let ensure3Pid = null;
let ensure3ProfileDir = null;
{
  // 3.0 收掉 item 1/2 实例 + 优雅停旧 guardian（默认 15s tick）→ 压缩 env 新 guardian 才能补拉
  const stopR = runCli(["render-chrome", "--stop"]);
  if (stopR.status !== 0) fail("3.0", "stop 收场 exit 0", `status=${stopR.status}`);
  else pass("3.0", "stop 收场 exit 0");
  const g0 = readGuardianPid();
  if (g0 !== null && pidAlive(g0)) {
    try {
      process.kill(g0, "SIGTERM");
      const goneAt = await waitForTrue(() => !pidAlive(g0), 8_000, 200, 2);
      goneAt
        ? pass("3.0", "旧 guardian SIGTERM 优雅退场（为压缩 tick 新 guardian 让位；兼验 respawn 面）", `pid=${g0}`)
        : fail("3.0", "旧 guardian 8s 内退场", `pid=${g0} 仍在`);
    } catch (e) {
      fail("3.0", "旧 guardian SIGTERM", String(e));
    }
  } else {
    pass("3.0", "无在世旧 guardian（pidfile 缺席/进程已退）", `pidfile pid=${g0}`);
  }

  // 3.1 压缩 idle ensure（fresh）
  const t0 = Date.now();
  const r = runCli(["render-chrome", "--ensure"], {
    env: { LASSO_RENDER_IDLE_MS: "30000", LASSO_RENDER_REAPER_INTERVAL_MS: "1000" },
  });
  let j3 = null;
  try {
    j3 = r.status === 0 ? parseEnsureOut(r.stdout) : null;
  } catch (e) {
    fail("3.1", "压缩 ensure stdout 单行 JSON", String(e));
  }
  if (!j3) fail("3.1", "压缩 ensure exit 0", `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
  else {
    ensure3Pid = j3.pid;
    ensure3ProfileDir = readLedger().find((rec) => rec.port === RENDER_PORT)?.profileDir ?? null;
    const profileOk = !!ensure3ProfileDir && existsSync(ensure3ProfileDir);
    j3.reused === false && profileOk
      ? pass("3.1", "fresh ensure + 台账 profileDir 在盘", `pid=${j3.pid} idleMs 压 30s guardian tick 1s`)
      : fail("3.1", "fresh ensure / profileDir", `reused=${j3.reused} profileDir=${ensure3ProfileDir}`);
  }

  // 3.2 真实 attach 消费方（CDP WebSocket）→ kill -9
  if (j3) {
    const consumer = spawnAttachConsumer(j3.wsEndpoint);
    const attached = await consumer.attached; // resolve pid 或 null（超时）
    if (attached) {
      process.kill(attached, "SIGKILL");
      await sleep(5_000);
      const alive = pidAlive(ensure3Pid);
      const c = await fingerprintAlive();
      alive && c >= 1
        ? pass("3.2", "kill -9 消费方后渲染档存活（SIGKILL 免疫）", `consumer=${attached} 被杀 5s 后 chrome pid=${ensure3Pid} 活 / 指纹=${c}`)
        : fail("3.2", "SIGKILL 免疫", `chrome pid=${ensure3Pid} alive=${alive} 指纹=${c}`);
    } else {
      fail("3.2", "attach 消费方上线", consumer.error ?? "5s 内未见 attached 行");
    }

    // 3.3 idle 30s + 宽限 → 回收（guardian 1s tick；75s 帽 = 30s idle + 旧 server 15s
    //     reaper 最坏竞速 + 机器慢启余量——正常 ~31s 即收）。
    //     🔴 死亡判定 = 权威三信号（chrome pid 死 + 台账记录清 + 指纹连续 2 读 0）——
    //     首轮真机验收实锤过「单次 ps 空读把活 Chrome 误判已收割」（3.4 profile 残留
    //     与 item4 同 pid reused 双证据回溯），单读指纹绝不可当死亡信号。
    const reapedAt = await waitForTrue(
      () => !pidAlive(ensure3Pid) && !readLedger().some((rec) => rec.port === RENDER_PORT),
      75_000,
      1_000,
      2,
    );
    if (reapedAt && (await fingerprintDeadConsecutive())) {
      pass("3.3", "压缩 idle 回收（pid 死 + 台账清 + 指纹连续 2 读 0）", `ensure 后 ${((reapedAt - t0) / 1000).toFixed(1)}s 收割（idle 30s + tick）`);
    } else {
      fail(
        "3.3",
        "75s 内 idle 回收",
        `chromeAlive=${pidAlive(ensure3Pid)} 台账N=${readLedger().filter((r) => r.port === RENDER_PORT).length} 指纹=${fingerprintCount().n}`,
      );
    }

    // 3.4 profile 随收割删除 + 无新残留
    const profilesNow = renderProfileDirs();
    const gone = ensure3ProfileDir ? !existsSync(ensure3ProfileDir) : false;
    const noNew = profilesNow.every((d) => baselineProfiles.includes(d));
    gone && noNew
      ? pass("3.4", "profile 随收割删除（chrome-stop render 连带 rmSync）", `基线 ${baselineProfiles.length} 目录无新增`)
      : fail("3.4", "profile 清零", `gone=${gone} 现存=${JSON.stringify(profilesNow)} 基线=${JSON.stringify(baselineProfiles)}`);

    // 3.5 guardian 账空自退（2 tick × 1s + 余量）
    const g3 = readGuardianPid();
    if (g3 !== null) {
      const exitedAt = await waitForTrue(() => !pidAlive(g3), 20_000, 500, 2);
      exitedAt
        ? pass("3.5", "guardian 账空 2 tick 自退", `pid=${g3}`)
        : fail("3.5", "guardian 20s 内自退", `pid=${g3} 仍在（不阻塞交付，render-guardian-process.spec 已钉死语义）`);
    } else {
      pass("3.5", "guardian 已不在（自退完成或未拉起）", `pidfile pid=${g3}`);
    }
  }
}

// ============================================================
// item 4 mode 过滤
// ============================================================
console.log("\n==== 4) mode 过滤：--modes hidden 不动 / --modes render 可收 ====");
{
  const r = runCli(["render-chrome", "--ensure"]);
  let j4 = null;
  try {
    j4 = r.status === 0 ? parseEnsureOut(r.stdout) : null;
  } catch {
    /* 下方统一判 */
  }
  if (!j4) {
    fail("4.1", "ensure exit 0", `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
  } else {
    if (j4.reused === false) pass("4.1", "ensure fresh（item 3 已收割 → 必是 fresh）", `pid=${j4.pid} reused=${j4.reused}`);
    else fail("4.1", "ensure fresh", `reused=${j4.reused} pid=${j4.pid}——item 3 的收割结论存疑（同 pid 复用 = 3.3 误判）`);
    // 防误伤：默认台账存在非 render 记录时，用 --port 9224 钉住（等价断言：render
    // 记录被 modes:hidden 过滤排除；不触碰他人 hidden 实例）
    const hasOtherRecords = readLedger().some((rec) => (rec.launchMode ?? "hidden") !== "render");
    const hiddenArgs = hasOtherRecords
      ? ["chrome-stop", "--port", String(RENDER_PORT), "--modes", "hidden"]
      : ["chrome-stop", "--modes", "hidden"];
    const rh = runCli(hiddenArgs);
    const fpH = await fingerprintAlive();
    const untouched =
      rh.status === 0 && pidAlive(j4.pid) && fpH >= 1 && readLedger().some((rec) => rec.port === RENDER_PORT);
    untouched
      ? pass("4.2", "chrome-stop --modes hidden 不动渲染档", `${hiddenArgs.join(" ")}${hasOtherRecords ? "（台账含他人记录，--port 钉住防误伤）" : ""} → 指纹=${fpH}`)
      : fail("4.2", "hidden 不动渲染档", `status=${rh.status} out=${rh.stdout.slice(0, 160)} pidAlive=${pidAlive(j4.pid)} 指纹=${fpH}`);

    const rr = runCli(["chrome-stop", "--modes", "render"]);
    const ledgerRenderGone = !readLedger().some((rec) => rec.launchMode === "render");
    const profilesNow = renderProfileDirs();
    const noNew = profilesNow.every((d) => baselineProfiles.includes(d));
    const fpDead = await fingerprintDeadConsecutive();
    const reaped = rr.status === 0 && fpDead && ledgerRenderGone && noNew;
    reaped
      ? pass("4.3", "chrome-stop --modes render 可收（含 profile 连带删除）", `指纹 0 / render 台账空 / profile 无新增`)
      : fail("4.3", "render 可收", `status=${rr.status} 指纹归零=${fpDead} 台账render空=${ledgerRenderGone} profiles=${JSON.stringify(profilesNow)}`);

    const st = runCli(["render-chrome", "--status"]);
    let running = null;
    try {
      running = JSON.parse(st.stdout.trim()).running;
    } catch {
      /* null */
    }
    st.status === 0 && running === false
      ? pass("4.4", "--status 自省 running:false（恒 exit 0）")
      : fail("4.4", "--status running:false", `status=${st.status} running=${running}`);
  }
}

// ============================================================
// item 5（opt-in）消费方旗标活对照（§一.4 导出 vs 渲染档实际命令行）
// ============================================================
if (CONSUMER_REPO) {
  console.log("\n==== 5) 消费方旗标活对照（--consumer-repo；§一.4 导出脚本活导出 + 渲染档 ps 实线 diff）====");
  await item5FlagDiff(CONSUMER_REPO);
}

// ============================================================
// 收场清理（真机实验的 Chrome 用后清理——无论成败都执行）
// ============================================================
console.log("\n==== cleanup ====");
{
  runCli(["render-chrome", "--stop"]);
  const g = readGuardianPid();
  if (g !== null && pidAlive(g)) {
    try {
      process.kill(g, "SIGTERM");
      await waitForTrue(() => !pidAlive(g), 8_000, 200, 2);
    } catch {
      /* best-effort */
    }
  }
  const deadOk = await fingerprintDeadConsecutive(500, 2);
  deadOk
    ? pass("C", "收场：指纹归零 / guardian 退场", "残留指纹连续 2 读 0")
    : fail("C", "收场指纹归零", `指纹=${fingerprintCount().n}——人工检查 ps`);
}

// ============================================================
// summary
// ============================================================
const failed = results.filter((r) => !r.ok);
console.log("\n==== render-tier acceptance summary ====");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  [${r.item}] ${r.label}`);
console.log(failed.length === 0 ? `\nALL PASS（${results.length} 项）` : `\n${failed.length}/${results.length} 项 FAIL：${failed.map((f) => f.item).join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);

// ============================================================
// attach 消费方（真实 CDP WebSocket；node<22 无全局 WebSocket 时降级 HTTP 轮询）
// ============================================================
function spawnAttachConsumer(wsEndpoint) {
  const httpUrl = wsEndpoint.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/version");
  const code = `
    const wsUrl = process.env.WS_URL, httpUrl = process.env.HTTP_URL;
    if (typeof WebSocket === "function") {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => console.log("attached-ws");
      ws.onerror = () => {};
      setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ id: 1, method: "Target.getBrowserContexts" })); }, 2000);
    } else {
      console.log("attached-http");
      const tick = () => fetch(httpUrl).catch(() => {});
      setInterval(tick, 1000); tick();
    }
  `;
  const child = spawn(process.execPath, ["-e", code], {
    env: { ...process.env, WS_URL: wsEndpoint, HTTP_URL: httpUrl },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buf = "";
  const attached = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5_000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("attached-ws") || buf.includes("attached-http")) {
        clearTimeout(timer);
        resolve(child.pid);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  return { child, attached, get error() { return buf.trim() ? `child out=${buf.trim().slice(0, 160)}` : null; } };
}

// ============================================================
// item 5 实现：活导出 + diff
// ============================================================
async function item5FlagDiff(consumerRepo) {
  const bpPath = path.join(consumerRepo, "src", "browser-pool.ts");
  const pkgPath = path.join(consumerRepo, "package.json");
  if (!existsSync(bpPath) || !existsSync(pkgPath)) {
    fail("5.0", "消费方仓路径有效（src/browser-pool.ts + package.json）", consumerRepo);
    return;
  }
  // 5.1 消费方真源 8 条（read-only 实读）
  let srcFlags = null;
  try {
    const m = readFileSync(bpPath, "utf8").match(/const DETERMINISTIC_FLAGS[^[]*\[([^\]]+)\]/);
    if (!m) throw new Error("browser-pool.ts 未匹配到 DETERMINISTIC_FLAGS");
    srcFlags = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  } catch (e) {
    fail("5.1", "实读消费方 DETERMINISTIC_FLAGS", String(e));
    return;
  }
  const frozen = (await import(path.join(REPO_ROOT, "dist", "render", "render-flags.js"))).RENDER_DETERMINISTIC_FLAGS;
  const frozenTail8 = frozen.slice(-8);
  const srcEqual = JSON.stringify(srcFlags) === JSON.stringify(frozenTail8) && JSON.stringify(srcFlags) === JSON.stringify(CONSUMER_FLAGS);
  srcEqual
    ? pass("5.1", "消费方 DETERMINISTIC_FLAGS 逐字同序 == 冻结尾段 8 条", `HEAD 实读 ${srcFlags.length} 条`)
    : fail("5.1", "消费方 8 条 == 冻结尾段", `src=${JSON.stringify(srcFlags)} frozenTail=${JSON.stringify(frozenTail8)}`);

  // 5.2 活导出（§一.4 脚本，/tmp 一次性临时脚本——勿入库）
  const tmpScript = path.join(os.tmpdir(), `lasso-acc-dump-flags-${Date.now()}.mjs`);
  const dumpProfile = path.join(os.tmpdir(), `lasso-acc-dump-profile-${Date.now()}`);
  writeFileSync(
    tmpScript,
    `import { createRequire } from "node:module";
const req = createRequire(${JSON.stringify(pkgPath)});
const mod = req("puppeteer-core");
const pup = mod.launch ? mod : (mod.default ?? mod);
const b = await pup.launch({ channel: "chrome", headless: true, args: ${JSON.stringify(CONSUMER_FLAGS)}, userDataDir: ${JSON.stringify(dumpProfile)} });
console.log("__BEGIN__");
console.log(b.process().spawnargs.join("\\n"));
console.log("__END__");
await b.close();
`,
    "utf8",
  );
  let exportTokens = null;
  try {
    const r = spawnSync(process.execPath, [tmpScript], { encoding: "utf8", timeout: 60_000 });
    const body = r.stdout.match(/__BEGIN__\n([\s\S]*?)\n__END__/);
    if (r.status !== 0 || !body) throw new Error(`status=${r.status} stderr=${(r.stderr ?? "").slice(0, 300)}`);
    exportTokens = body[1].split("\n").filter((l) => l.trim() !== "");
  } catch (e) {
    fail("5.2", "§一.4 导出脚本活导出（消费方 node_modules puppeteer-core）", String(e));
  } finally {
    rmSync(tmpScript, { force: true });
    rmSync(dumpProfile, { recursive: true, force: true });
  }
  if (!exportTokens) return;
  pass("5.2", `活导出成功（${exportTokens.length} tokens，puppeteer-core 25.x + channel:chrome）`, `二进制=${exportTokens[0]}`);

  // 5.3 渲染档实际命令行（ensure 幂等 fresh → ps -p <pid> 取实线）
  const r = runCli(["render-chrome", "--ensure"]);
  let j5 = null;
  try {
    j5 = r.status === 0 ? parseEnsureOut(r.stdout) : null;
  } catch {
    /* 下方统一判 */
  }
  let liveTokens = null;
  if (!j5) {
    fail("5.3", "渲染档 ensure（供 ps 实线）", `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
  } else {
    const cmd = psPidCommand(j5.pid);
    if (cmd.includes("--user-data-dir=")) {
      liveTokens = cmd.split(/\s+/).filter((t) => t.trim() !== "");
      pass("5.3", "渲染档实际命令行取得", `pid=${j5.pid} tokens=${liveTokens.length}`);
    } else {
      fail("5.3", "渲染档 ps 实线", `pid=${j5.pid} cmd=${cmd.slice(0, 160)}`);
    }
  }
  if (liveTokens) {
    // 5.4 归一化 diff（剥 per-instance 项：二进制/--user-data-dir/--remote-debugging-*/
    //     起始 URL；§一.4 路线 b 口径）。🔴 二进制路径含空格（Google Chrome.app）——
    //     ps 实线不能 slice(1) 剥头，改「从首个 -- 旗标 token 起」切（首轮真机验收
    //     实锤：slice(1) 把路径劈成两枚伪旗标）
    const perInstance = (t) =>
      t.startsWith("--user-data-dir=") || t.startsWith("--remote-debugging-port=") || t.startsWith("--remote-debugging-pipe") || t === "about:blank";
    const firstFlagIdx = (tokens) => tokens.findIndex((t) => t.startsWith("--"));
    const normExport = exportTokens.slice(firstFlagIdx(exportTokens)).filter((t) => !perInstance(t));
    const normLive = liveTokens.slice(firstFlagIdx(liveTokens)).filter((t) => !perInstance(t));
    const identical = JSON.stringify(normExport) === JSON.stringify(normLive);
    if (identical) {
      pass("5.4", `归一化旗标面零差（${normLive.length} 旗标逐字同序；per-instance 项已剥）`, `渲染档实线 ${normLive.length} == 活导出 ${normExport.length}`);
    } else {
      const onlyExport = normExport.filter((t) => !normLive.includes(t));
      const onlyLive = normLive.filter((t) => !normExport.includes(t));
      fail("5.4", "归一化旗标面零差", `仅导出有=${JSON.stringify(onlyExport)} 仅渲染档有=${JSON.stringify(onlyLive)}`);
    }
    // 5.5 冻结快照一致性（活线 vs dist 冻结集——fixture tripwire 的活体版）
    const frozenSet = JSON.stringify(frozen.filter((t) => !perInstance(t)));
    const liveSet = JSON.stringify(normLive);
    liveSet === frozenSet
      ? pass("5.5", "渲染档实线 == dist 冻结快照（RENDER_DETERMINISTIC_FLAGS）", `${frozen.length} 旗标`)
      : fail("5.5", "实线 == 冻结快照", `live=${liveSet.slice(0, 200)} frozen=${frozenSet.slice(0, 200)}`);
  }
  // 收场（ensure 的实例在此清掉；外层 cleanup 再兜底）
  runCli(["render-chrome", "--stop"]);
}
