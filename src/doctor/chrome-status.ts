/**
 * chrome-status.ts（BUG-04 决议 A，doc/bugs/04 §4，2026-09-08）
 *
 * 归属鉴定单一真源：`classifyPortOccupier()`——回答一个问题：
 * 「这个端口的占用者是谁、归谁管、我能做什么」。
 *
 * 设计动机（09-08 误杀事故的直接教训，报告第一部分 Q2）：事故四根因之首
 * 「agent 自行推断归属」——此前端口占用时 lasso 只查台账（不解析真实占口 pid），
 * 非台账占口者零证据面，agent 只能自己跑 lsof/curl/osascript/ps 然后三重误判
 * （空输出≠空属性/确认偏误）。本模块把归属鉴定从 agent 手里收走：证据集全只读、
 * 全仓库内既有组件，**永远不给 agent 任何 kill 能力**。
 *
 * 🔴 铁律（INV-88）：
 *  - agent_directive.allowed_commands **永不包含** kill/pkill/killall/osascript-quit
 *    形态命令；
 *  - `chrome-stop` 指引只允许门槛变体 `chrome-stop --zombie-gate --port N`，且仅
 *    允许出现在 `ledger_zombie_collectible` 分支（其余一切占用分支必含
 *    never_kill_user_asset token + must_report:true）；
 *  - R1 失效安全：任何探针失败/空输出/证据断链 → probe_failed（只上报，
 *    allowed_commands 恒空）；free 仅认 TCP 主动拒连；
 *  - R2 pid 一致性：lsof 实测监听 pid ≠ 台账 rec.pid 时永不进 lasso_live /
 *    ledger_zombie_collectible——按实际占口者 cmdline 身份落分支；
 *  - R3 慢启动守卫：launchedAt 距今 < LAUNCH_GRACE_MS → lasso_launching
 *    （等待/上报，永不给 kill 指引）。
 *
 * user_paste_pack（给人看的粘贴块）不受 allowed_commands 约束——用户专属出口
 * 仍可提裸 `chrome-stop --port N`（用户 = 同意通道本体，chrome-stop.ts:71-73
 * 既有契约）。
 *
 * 消费方（三处分类收敛，单一真源）：
 *  - CLI：`lasso-mcp chrome-status [--port N] [--json]`（index.ts dispatch）；
 *  - MCP：admin tool 只读 action `chrome_status`（INV-17 action-enum 折叠范式）；
 *  - doctor：checkCdp9222 的 catch/!ok 分支经 classifyPortOccupierNextStep
 *    渲染 next_step（本模块补齐非台账占口的真实 pid 证据面）。
 *
 * INV-64 衍生：doctor/ 目录模块——只 import node:* 内置 + 仓库内模块；
 * launcher 侧依赖走既有 doctor→launcher import 面（readLedgerSync /
 * verifyOwnership，doctor.ts 先例）。
 */
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import process from "node:process";
import {
  readLedgerSync,
  isUserOwnedRecord,
  isLaunchingRecord,
  type LaunchedChromeRecord,
} from "../launcher/chrome-ledger.js";
import { verifyOwnership } from "../launcher/chrome-stop.js";

// ============================================================
// 类型
// ============================================================
/**
 * 分类矩阵（BUG-04 §4 A1，r1 修订 10 枚举）。机器可读（CLI --json /
 * admin chrome_status 直接序列化）；渲染人话由消费方（doctor/CLI 缺省输出）做。
 */
export type PortOccupierClassification =
  | "free" // TCP 主动拒连（ECONNREFUSED）——可 launch-chrome
  | "lasso_launching" // 台账在案 + 距今 < LAUNCH_GRACE_MS——等待，永不 kill
  | "lasso_live" // CDP ok + 台账 + lsofPid===rec.pid + 归属通过——正常使用
  | "ledger_zombie_collectible" // CDP 死 + 台账 + pid 一致 + 归属 + 非用户拥有/非 render/非 launching——唯一给门槛清账指引
  | "ledger_user_owned" // 台账 + isUserOwnedRecord——换口 + 上报
  | "ledger_stale" // 台账记录与实际占口者不符（pid 不一致/归属失败）——按实际占口者另行分类，本分类=台账面陈留
  | "lasso_profile_orphan_suspected" // 无台账 + 占口者 cmdline 含 lasso profileDir 指纹（含 render 档遗留——guardian 自管域）——只上报
  | "user_asset_suspected" // 无台账 + Chrome 进程无 lasso 指纹——只上报
  | "external_occupier" // 无台账 + 非 Chrome 进程——只上报
  | "probe_failed"; // 任何探针失败/空输出/证据断链——只上报，allowed_commands 恒空

export interface PortOccupierEvidence {
  /** lsof 实测监听 pid（R2：与台账 rec.pid 的等值是唯一实例级凭据）。 */
  pid?: number;
  /** 进程名（ps command 首 token 的 basename）。 */
  pname?: string;
  /** 进程已运行秒数（ps etime）。 */
  etime_s?: number;
  /** cmdline 摘录（≤200 字符；给人看的证据面）。 */
  cmdline_excerpt?: string;
  /** lsof 实测 pid 与台账 rec.pid 是否等值（台账在案才有意义）。 */
  pid_match?: boolean;
  /** 台账记录（脱敏副本；无记录省略）。 */
  ledger_record?: {
    pid: number;
    port: number;
    launchedAt: number;
    status: LaunchedChromeRecord["status"];
    launchMode?: LaunchedChromeRecord["launchMode"];
    userTakenAt?: number;
  };
  cdp: {
    /** /json/version 是否返回 200 且可解析。 */
    reachable: boolean;
    browser_field?: string;
    /** /json/list 页 target 数（探测失败省略）。 */
    pages?: number;
  };
  /** 台账记录的 cmdline 归属验证是否通过（verifyOwnership）。 */
  ownership_verified?: boolean;
}

export interface PortOccupierDirective {
  /**
   * agent 的合法下一步（机器可读）。铁律：永不包含 kill 形态；chrome-stop
   * 只允许 `chrome-stop --zombie-gate --port N` 门槛变体且仅 zombie 分支。
   */
  allowed_commands: string[];
  /** true = agent 必须把 user_paste_pack 粘给用户裁决（唯一合法下一步）。 */
  must_report: boolean;
  /** never_kill_user_asset 语义标注（一切占用分支必含——除 free/lasso_live/zombie）。 */
  never_kill_user_asset?: boolean;
}

export interface ChromeStatusResult {
  port: number;
  classification: PortOccupierClassification;
  evidence: PortOccupierEvidence;
  agent_directive: PortOccupierDirective;
  /** 给人看的粘贴块（fenced text；含用户专属出口）。 */
  user_paste_pack: string;
}

// ============================================================
// 依赖注入（repo 既有惯例：全探针可注入，单测零真机）
// ============================================================
export interface ClassifyPortOccupierDeps {
  /** TCP 探测：true=端口被占（connect 成功）；false=主动拒连；null=探测不可判（R1 → probe_failed 路径输入）。 */
  tcpFn?: (port: number) => Promise<boolean | null>;
  /** CDP /json/version（200+JSON 才算 reachable；抛错/非 200 → unreachable）。 */
  cdpVersionFn?: (port: number) => Promise<{ ok: boolean; browser?: string }>;
  /** CDP /json/list 页 target 数（失败可返 null——best-effort 证据）。 */
  cdpListFn?: (port: number) => Promise<number | null>;
  /** lsof 取真实监听 pid（null = lsof 失败/空输出——R1 证据断链）。 */
  lsofFn?: (port: number) => Promise<number | null>;
  /** ps -p <pid> -o command=,etime=（null = ps 失败/空输出——R1 证据断链）。 */
  psFn?: (pid: number) => { command: string; etimeS: number } | null;
  /** 台账读（默认 readLedgerSync）。 */
  readLedgerFn?: () => LaunchedChromeRecord[];
  /** pid 探活（默认 process.kill(pid,0)）。 */
  aliveFn?: (pid: number) => boolean;
  /** 时钟注入（R3 单测）。 */
  now?: () => number;
}

// ============================================================
// 默认探针（全只读）
// ============================================================
/**
 * TCP 三态探测（区别 launch-chrome.tcpConnectable 的二态——R1 要求把
 * 「主动拒连」与「探测不可判」分开：timeout/其他错误 ≠ free）。
 */
export function tcpProbeTri(port: number): Promise<boolean | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1_000);
    let settled = false;
    const done = (v: boolean | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(null));
    socket.once("error", (e: NodeJS.ErrnoException) => {
      // ECONNREFUSED = 明确拒连（free 的唯一认定形态）；其余（超时前异常）不可判
      done(e.code === "ECONNREFUSED" ? false : null);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function defaultCdpVersionFn(port: number): Promise<{ ok: boolean; browser?: string }> {
  const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!resp.ok) return { ok: false };
  const v = (await resp.json()) as { Browser?: string };
  return { ok: true, browser: v.Browser };
}

async function defaultCdpListFn(port: number): Promise<number | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!resp.ok) return null;
    const list = (await resp.json()) as unknown[];
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
}

async function defaultLsofFn(port: number): Promise<number | null> {
  try {
    const r = spawnSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 2_000 },
    );
    const out = (r.stdout ?? "").trim();
    if (!out) return null; // R1：空输出 ≠ 无占用者——证据断链
    const pid = parseInt(out.split("\n")[0]!, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function defaultPsFn(pid: number): { command: string; etimeS: number } | null {
  try {
    // 🔴 两次独立探测（真机实证 2026-09-08）：macOS BSD ps 把多个 -o 列并到一行时
    // 会把 command 列**截断**到 16 字符（`-o command= -o etime=` → "/Applications/Go
    // 02:09:02"——真机 Chrome 被截成 external_occupier 误分类）。command= 单列
    // 输出完整命令行；etime= 单列解析 [[dd-]hh:]mm:ss。
    const cmdR = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const command = (cmdR.stdout ?? "").replace(/[\r\n]+$/, "").trim();
    if (!command) return null; // R1：ps 空输出 ≠ 进程无属性
    let etimeS = -1;
    const etR = spawnSync("ps", ["-p", String(pid), "-o", "etime="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    // etime 形态：mm:ss / hh:mm:ss / dd-hh:mm:ss（两段 = 分:秒，无小时位）
    const m = (etR.stdout ?? "").trim().match(/^(?:(\d+)-)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const days = m[1] ? parseInt(m[1], 10) : 0;
      if (m[4] !== undefined) {
        etimeS = days * 86_400 + parseInt(m[2]!, 10) * 3_600 + parseInt(m[3]!, 10) * 60 + parseInt(m[4], 10);
      } else {
        etimeS = days * 86_400 + parseInt(m[2]!, 10) * 60 + parseInt(m[3]!, 10);
      }
    }
    return { command, etimeS };
  } catch {
    return null;
  }
}

function defaultAliveFn(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// agent_directive 单一真源（INV-88 断言面）
// ============================================================
/**
 * 各分类的 agent 指引（allowed_commands 白名单）。铁律锚：
 *  - 全表**唯一**含 chrome-stop 的条目 = ledger_zombie_collectible，且是
 *    `--zombie-gate` 门槛变体（agent 永不裸 chrome-stop / 永不 all-stop）；
 *  - 除 free / lasso_live / ledger_zombie_collectible 外全部 must_report:true
 *    + never_kill_user_asset:true。
 */
export const AGENT_DIRECTIVES: Record<
  PortOccupierClassification,
  PortOccupierDirective
> = {
  free: {
    allowed_commands: ["lasso-mcp launch-chrome --port {PORT}"],
    must_report: false,
  },
  lasso_launching: {
    allowed_commands: [],
    must_report: true,
    never_kill_user_asset: true,
  },
  lasso_live: {
    allowed_commands: [],
    must_report: false,
  },
  ledger_zombie_collectible: {
    allowed_commands: ["lasso-mcp chrome-stop --zombie-gate --port {PORT}"],
    must_report: false,
  },
  ledger_user_owned: {
    allowed_commands: [],
    must_report: true,
    never_kill_user_asset: true,
  },
  ledger_stale: {
    // 台账面陈留（实际占口者另行标注）——清账走门槛变体（already_dead /
    // pid_reused_skipped 路径本身 kill-free）
    allowed_commands: ["lasso-mcp chrome-stop --zombie-gate --port {PORT}"],
    must_report: true,
    never_kill_user_asset: true,
  },
  lasso_profile_orphan_suspected: {
    allowed_commands: [],
    must_report: true,
    never_kill_user_asset: true,
  },
  user_asset_suspected: {
    allowed_commands: [],
    must_report: true,
    never_kill_user_asset: true,
  },
  external_occupier: {
    allowed_commands: [],
    must_report: true,
    never_kill_user_asset: true,
  },
  probe_failed: {
    allowed_commands: [],
    must_report: true,
    never_kill_user_asset: true,
  },
};

// ============================================================
// lasso profile 指纹（R2/孤儿判定的共享常量）
// ============================================================
/**
 * 占口者 cmdline 的 lasso profile 指纹：hidden/visible/headless 三档共用固定
 * ~/.cache/lasso/chrome-profile-default（launch-chrome.ts:233），render 档用
 * render-chrome-profile- 前缀临时目录。指纹只证明「跑着 lasso profile 的
 * Chrome」，**证明不了台账记录的那只**（三档同串）——实例级凭据只有 pid 等值
 * （R2）。
 */
const LASSO_PROFILE_FINGERPRINTS = [
  ".cache/lasso/chrome-profile-",
  "render-chrome-profile-",
];

function hasLassoProfileFingerprint(cmdline: string): boolean {
  return LASSO_PROFILE_FINGERPRINTS.some((f) => cmdline.includes(f));
}

function isChromeProcess(cmdline: string): boolean {
  return /Google Chrome|Chromium|chrome-devtools|Microsoft Edge/i.test(cmdline);
}

// ============================================================
// 核心分类器
// ============================================================
/**
 * 归属鉴定单一真源（全只读）。判定序（r1 矩阵 + R1-R3）：
 *  1. TCP 拒连 → free；TCP 不可判 → probe_failed；
 *  2. 证据链（lsof pid / ps cmdline）断链 → probe_failed（R1：空输出≠空属性）；
 *  3. 台账在案 + pid 等值 + 归属验证通过：
 *     user_owned > live（CDP ok）> launching（R3）> render（guardian 域）>
 *     zombie_collectible；
 *  4. 台账在案但 pid 不等值/归属失败 → 按实际占口者身份分类 + pid_match:false
 *     （R2——台账记录另行标注 stale，不随实际占口者混判）；
 *  5. 无台账 → 实际占口者身份：lasso 指纹（含 render 遗留）→ orphan；
 *     Chrome → user_asset_suspected；其余 → external_occupier。
 */
export async function classifyPortOccupier(
  port: number,
  deps: ClassifyPortOccupierDeps = {},
): Promise<ChromeStatusResult> {
  const tcpFn = deps.tcpFn ?? tcpProbeTri;
  const cdpVersionFn = deps.cdpVersionFn ?? defaultCdpVersionFn;
  const cdpListFn = deps.cdpListFn ?? defaultCdpListFn;
  const lsofFn = deps.lsofFn ?? defaultLsofFn;
  const psFn = deps.psFn ?? defaultPsFn;
  const readLedgerFn = deps.readLedgerFn ?? readLedgerSync;
  const aliveFn = deps.aliveFn ?? defaultAliveFn;
  const now = deps.now ?? Date.now;

  const evidence: PortOccupierEvidence = { cdp: { reachable: false } };
  const finalize = (
    classification: PortOccupierClassification,
    extraLedger?: LaunchedChromeRecord,
  ): ChromeStatusResult => {
    if (extraLedger) {
      evidence.ledger_record = {
        pid: extraLedger.pid,
        port: extraLedger.port,
        launchedAt: extraLedger.launchedAt,
        status: extraLedger.status,
        ...(extraLedger.launchMode ? { launchMode: extraLedger.launchMode } : {}),
        ...(extraLedger.userTakenAt !== undefined
          ? { userTakenAt: extraLedger.userTakenAt }
          : {}),
      };
    }
    return {
      port,
      classification,
      evidence,
      agent_directive: {
        ...AGENT_DIRECTIVES[classification],
        allowed_commands: AGENT_DIRECTIVES[classification].allowed_commands.map((c) =>
          c.replace("{PORT}", String(port)),
        ),
      },
      user_paste_pack: buildUserPastePack(port, classification, evidence),
    };
  };

  // 1. TCP 三态
  const tcp = await tcpFn(port);
  if (tcp === null) {
    evidence.cmdline_excerpt = "(tcp probe inconclusive)";
    return finalize("probe_failed");
  }
  if (tcp === false) {
    // 主动拒连 = 空闲（唯一 free 认定形态；连接工具级异常已在上面分流）
    const rec = readLedgerFn().find((r) => r.port === port);
    if (rec) {
      // 空闲 + 台账陈留（pid 已死/端口已释）——如实标注（清账走门槛变体，kill-free）
      evidence.pid_match = false;
      return finalize("ledger_stale", rec);
    }
    return finalize("free");
  }

  // 2. 实际占口者证据链（R1：断链一律 probe_failed——事故「空输出≠空属性」的
  //    结构化排除）
  const lsofPid = await lsofFn(port);
  if (lsofPid === null) {
    evidence.cmdline_excerpt = "(lsof returned no listener pid)";
    return finalize("probe_failed");
  }
  evidence.pid = lsofPid;
  const ps = psFn(lsofPid);
  if (ps === null) {
    evidence.cmdline_excerpt = "(ps returned no cmdline for listener pid)";
    return finalize("probe_failed");
  }
  evidence.etime_s = ps.etimeS;
  evidence.cmdline_excerpt = ps.command.slice(0, 200);
  // macOS .app bundle 路径含空格（"Google Chrome.app"）——首 token 只取到
  // "/Applications/Google"。先认 .app bundle 名，认不出退回首 token basename。
  const appM = ps.command.match(/([^\/\s][^\/]*\.app)\//); // 路径段可含空格（Google Chrome.app）
  evidence.pname = appM
    ? appM[1]!.replace(/\.app$/, "")
    : ps.command.split(/\s+/)[0]?.split("/").pop();

  // 3. CDP 证据（best-effort：不可达不阻断身份判定）
  try {
    const v = await cdpVersionFn(port);
    evidence.cdp.reachable = v.ok;
    if (v.browser) evidence.cdp.browser_field = v.browser;
  } catch {
    evidence.cdp.reachable = false;
  }
  const pages = await cdpListFn(port);
  if (pages !== null) evidence.cdp.pages = pages;

  // 4. 台账判定
  const rec = readLedgerFn().find((r) => r.port === port);
  if (rec) {
    evidence.pid_match = lsofPid === rec.pid;
    const ownedAlive = aliveFn(rec.pid);
    if (evidence.pid_match && ownedAlive) {
      // verifyOwnership 用真实监听 pid 的 cmdline（R2：pid 等值 + marker 才是
      // 实例级凭据——三档共用 profileDir，marker 单独证明不了「台账那只」）
      evidence.ownership_verified = verifyOwnership(
        lsofPid,
        rec.profileDir,
        (pid) => (pid === lsofPid ? `${ps.command}\n` : ""),
      );
      if (evidence.ownership_verified) {
        if (isUserOwnedRecord(rec)) return finalize("ledger_user_owned", rec);
        if (evidence.cdp.reachable) return finalize("lasso_live", rec);
        if (isLaunchingRecord(rec, now())) return finalize("lasso_launching", rec);
        if (rec.launchMode === "render") {
          // render 档 = render-guardian 自管域（日常档入口不越权，A2 门同款排除）；
          // 分类面如实归「疑似 lasso 实例」+ 只上报（agent 的合法下一步=上报，
          // 用户/guardian 出口在 paste pack）
          return finalize("lasso_profile_orphan_suspected", rec);
        }
        return finalize("ledger_zombie_collectible", rec);
      }
    }
    // pid 不等值 / pid 已死 / 归属失败 → 台账面陈留；实际占口者按身份另行分类
    const byIdentity = classifyByOccupierIdentity(ps.command);
    return finalize(byIdentity, rec);
  }

  // 5. 无台账 → 实际占口者身份
  return finalize(classifyByOccupierIdentity(ps.command));
}

/** 无（或不匹配）台账时按实际占口者 cmdline 身份分类。 */
function classifyByOccupierIdentity(cmdline: string): PortOccupierClassification {
  if (hasLassoProfileFingerprint(cmdline)) return "lasso_profile_orphan_suspected";
  if (isChromeProcess(cmdline)) return "user_asset_suspected";
  return "external_occupier";
}

// ============================================================
// 上报包（user_paste_pack——「零 kill 逃生口」的替代物）
// ============================================================
/**
 * 给人看的粘贴块（fenced text）。agent 的合法下一步被收敛为「把这个包粘给用户」。
 * 用户专属出口不受 allowed_commands 约束：自行关闭 / 自己跑
 * `chrome-stop --port N`（僵尸与已认领实例皆是用户的合法关闭出口——
 * chrome-stop.ts:71-73 既有契约）/ 让 agent 换口。
 */
export function buildUserPastePack(
  port: number,
  classification: PortOccupierClassification,
  ev: PortOccupierEvidence,
): string {
  const lines: string[] = [
    `[lasso chrome-status] port ${port} — ${classification}`,
    `occupier: pid=${ev.pid ?? "?"} name=${ev.pname ?? "?"} etime=${ev.etime_s ?? "?"}s`,
    `cmdline: ${ev.cmdline_excerpt ?? "(unavailable)"}`,
    `cdp: reachable=${ev.cdp.reachable}${ev.cdp.browser_field ? ` browser=${ev.cdp.browser_field}` : ""}${ev.cdp.pages !== undefined ? ` pages=${ev.cdp.pages}` : ""}`,
  ];
  if (ev.ledger_record) {
    const r = ev.ledger_record;
    lines.push(
      `ledger: pid=${r.pid} mode=${r.launchMode ?? "hidden"} status=${r.status} launchedAt=${new Date(r.launchedAt).toISOString()}${r.userTakenAt !== undefined ? ` userTakenAt=${new Date(r.userTakenAt).toISOString()}` : ""} pid_match=${ev.pid_match}`,
    );
  } else {
    lines.push("ledger: (no record for this port)");
  }
  lines.push("lasso will NEVER kill this process on its own (never_kill_user_asset).");
  lines.push("Your exits (user-only): close it yourself, or run it yourself:");
  lines.push(`  lasso-mcp chrome-stop --port ${port}`);
  lines.push("or tell the agent to use a different port: launch-chrome --port <N>");
  return ["```text", ...lines, "```"].join("\n");
}

// ============================================================
// CLI 入口（lasso-mcp chrome-status [--port N] [--json]）
// ============================================================
export interface ChromeStatusCliOptions {
  /** 缺省端口（config.cdpPort；index.ts 装配层注入）。 */
  defaultPort?: number;
  /** --help 时打印的 usage 单一真源（index.ts CLI_USAGE 经注入流入，INV-64 同款）。 */
  helpText?: string;
}

/** argv 解析（导出供单测）：--port N / --json / --help。 */
export function parseChromeStatusArgs(argv: string[]): {
  port?: number;
  json: boolean;
  help: boolean;
} {
  let port: number | undefined;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--json") json = true;
    else if (a === "--port") {
      const n = argv[i + 1] ? parseInt(argv[i + 1]!, 10) : NaN;
      if (!Number.isNaN(n)) port = n;
      i++;
    }
    // 未知 flag 忽略（forward-compat，chrome-stop 同款）
  }
  return { port, json, help };
}

/** 分类 → 人话一句话（CLI 缺省输出 / 测试锚）。 */
export function classificationSummary(res: ChromeStatusResult): string {
  const p = res.port;
  switch (res.classification) {
    case "free":
      return `端口 ${p} 空闲（TCP 主动拒连）——可 launch-chrome。`;
    case "lasso_launching":
      return `端口 ${p} 的 lasso Chrome 仍在慢启动宽限窗（<60s）——等待 ≥60s 后重跑 chrome-status；永不 kill（never_kill_user_asset）。`;
    case "lasso_live":
      return `端口 ${p} 是 lasso 在案且健康的 Chrome（pid ${res.evidence.pid}，CDP 可达）——正常使用。`;
    case "ledger_zombie_collectible":
      return `端口 ${p} 是 lasso 台账在案的自家僵尸 Chrome（pid ${res.evidence.pid}，CDP 死/归属验证通过/非用户拥有/非慢启动）——唯一允许的清账命令：lasso-mcp chrome-stop --zombie-gate --port ${p}（kill 时刻重估用户认领门）。`;
    case "ledger_user_owned":
      return `端口 ${p} 被 lasso 台账在案但已被用户拥有的 Chrome（pid ${res.evidence.pid}）占用——lasso 永不自动清理（never_kill_user_asset）；唯一出口=用户自行关闭或用户本人运行 chrome-stop --port ${p}；agent 请换口并上报用户裁决。`;
    case "ledger_stale":
      return `端口 ${p} 的台账记录与实际占口者不符（pid_match=${res.evidence.pid_match}）——台账陈留可经 lasso-mcp chrome-stop --zombie-gate --port ${p} 清账（already_dead/pid_reused 路径 kill-free）；实际占口者按下方分类处理。`;
    case "lasso_profile_orphan_suspected":
      return `端口 ${p} 的占用者疑似 lasso 无主实例（cmdline 含 lasso profile 指纹但台账无匹配记录；含 render 档 guardian 自管域）——lasso 不认领不杀（never_kill_user_asset），只上报。`;
    case "user_asset_suspected":
      return `端口 ${p} 被疑似用户资产（Chrome 进程、无 lasso 指纹）占用——lasso 永不 kill（never_kill_user_asset）：请用户裁决（手动关闭该进程）或换口 launch-chrome --port N。`;
    case "external_occupier":
      return `端口 ${p} 被外部非 Chrome 进程占用——lasso 永不 kill（never_kill_user_asset）：上报用户裁决或换口 launch-chrome --port N。`;
    case "probe_failed":
      return `端口 ${p} 占用者身份无法确证（探针失败/空输出——空输出≠空属性）——lasso 永不 kill（never_kill_user_asset）：上报用户裁决或换口 launch-chrome --port N。`;
  }
}

/** CLI 主入口：缺省人话 + paste pack；--json 全量结构化；只读，exit 0。 */
export async function runChromeStatusCli(
  argv: string[] = process.argv.slice(3),
  opts: ChromeStatusCliOptions = {},
): Promise<void> {
  const parsed = parseChromeStatusArgs(argv);
  if (parsed.help) {
    process.stdout.write((opts.helpText ?? "usage: lasso-mcp chrome-status [--port N] [--json]\n") + "\n");
    process.exit(0);
    return;
  }
  const port = parsed.port ?? opts.defaultPort ?? 9222;
  const res = await classifyPortOccupier(port);
  if (parsed.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else {
    process.stdout.write(
      `${classificationSummary(res)}\n\nagent_directive: allowed=${JSON.stringify(res.agent_directive.allowed_commands)} must_report=${res.agent_directive.must_report}\n\n${res.user_paste_pack}\n`,
    );
  }
  process.exit(0);
}
