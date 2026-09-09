/**
 * bug04-chrome-status.spec.ts（BUG-04 决议 A，doc/bugs/04 §4，2026-09-08）
 *
 * 归属鉴定单一真源 classifyPortOccupier + 输出契约（INV-88）回归：
 *  - 动机（09-08 误杀事故直接教训）：端口占用时 agent 自行跑 lsof/curl/osascript/ps
 *    三重误判（空输出≠空属性/确认偏误）。本模块把归属鉴定收走：证据集全只读，
 *    永不给 agent kill 能力。
 *  - 覆盖：分类矩阵 10 枚举逐分支（DI）/ R1 失效安全 / R2 pid 一致性 /
 *    R3 慢启动守卫（chrome-status + launch-chrome A2 门回补）/ 无 kill tripwire /
 *    allowed_commands 门槛变体纪律 / paste pack 形状 / --zombie-gate 行为面 /
 *    admin action 接线 / CLI parse。
 *
 * 全 DI 注入——零真机、零真 lsof/ps、台账经 env 隔离。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyPortOccupier,
  parseChromeStatusArgs,
  buildUserPastePack,
  AGENT_DIRECTIVES,
  type ClassifyPortOccupierDeps,
  type PortOccupierClassification,
} from "../../src/doctor/chrome-status.js";
import { recordLaunch, type LaunchedChromeRecord, LAUNCH_GRACE_MS, isLaunchingRecord } from "../../src/launcher/chrome-ledger.js";
import { stopLaunchedChromes, parseChromeStopArgs } from "../../src/launcher/chrome-stop.js";
import { launchChrome } from "../../src/launcher/launch-chrome.js";

// 真实形态 profile 路径（指纹 ".cache/lasso/chrome-profile-" 命中——测试不落真盘，
// 只作 cmdline marker + 指纹子串）
const PROFILE = `${os.homedir()}/.cache/lasso/chrome-profile-default`;
const CHROME_CMD = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222`;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-bug04-cs-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "launched-chromes.json");
  process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(tmpDir, "desired-hidden.json");
  process.env.LASSO_CHROME_TOUCH_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_DESIRED_HIDDEN_PATH;
  delete process.env.LASSO_CHROME_TOUCH_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 66111,
    profileDir: PROFILE,
    // 缺省陈年记录（R3 守卫外的「老僵尸」形态；年轻记录专门测）
    launchedAt: Date.now() - LAUNCH_GRACE_MS * 10,
    status: "ready",
    launchMode: "hidden",
    ...overrides,
  };
}

/** 全证据链齐备的 DI 集（override 各探针改变分支）。 */
function baseDeps(overrides: Partial<ClassifyPortOccupierDeps> = {}): ClassifyPortOccupierDeps {
  return {
    tcpFn: async () => true,
    cdpVersionFn: async () => ({ ok: false }),
    cdpListFn: async () => null,
    lsofFn: async () => 66111,
    psFn: (pid: number) => ({ command: CHROME_CMD, etimeS: 900 }),
    aliveFn: () => true,
    ...overrides,
  };
}

// ============================================================
// 1. 分类矩阵逐分支
// ============================================================
describe("BUG-04A · 分类矩阵", () => {
  it("1a. TCP 主动拒连 + 无台账 → free（唯一 free 认定形态）", async () => {
    const r = await classifyPortOccupier(9222, baseDeps({ tcpFn: async () => false }));
    expect(r.classification).toBe("free");
    expect(r.agent_directive.allowed_commands).toEqual(["lasso-mcp launch-chrome --port 9222"]);
    expect(r.agent_directive.must_report).toBe(false);
  });

  it("1b. TCP 拒连 + 台账陈留 → ledger_stale（陈旧条目如实标注，非 free）", async () => {
    await recordLaunch(makeRec());
    const r = await classifyPortOccupier(9222, baseDeps({ tcpFn: async () => false }));
    expect(r.classification).toBe("ledger_stale");
    expect(r.evidence.pid_match).toBe(false);
  });

  it("1c. 台账 + pid 一致 + 归属 + CDP ok + 非用户拥有 → lasso_live", async () => {
    await recordLaunch(makeRec());
    const r = await classifyPortOccupier(9222, baseDeps({ cdpVersionFn: async () => ({ ok: true, browser: "Chrome/150" }) }));
    expect(r.classification).toBe("lasso_live");
    expect(r.evidence.cdp.reachable).toBe(true);
    expect(r.evidence.cdp.browser_field).toBe("Chrome/150");
    expect(r.agent_directive.must_report).toBe(false);
  });

  it("1d. 台账 + pid 一致 + 归属 + CDP 死 + 陈年 + 非用户拥有/非 render → ledger_zombie_collectible（唯一给门槛清账指引的分支）", async () => {
    await recordLaunch(makeRec());
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("ledger_zombie_collectible");
    expect(r.evidence.ownership_verified).toBe(true);
    expect(r.evidence.pid_match).toBe(true);
    expect(r.agent_directive.allowed_commands).toEqual([
      "lasso-mcp chrome-stop --zombie-gate --port 9222",
    ]);
    expect(r.agent_directive.must_report).toBe(false);
  });

  it("1e. 台账 + userTakenAt 已认领 → ledger_user_owned（优先于 live/zombie）", async () => {
    await recordLaunch(makeRec({ userTakenAt: Date.now() }));
    const r = await classifyPortOccupier(
      9222,
      baseDeps({ cdpVersionFn: async () => ({ ok: true }) }),
    );
    expect(r.classification).toBe("ledger_user_owned");
    expect(r.evidence.ledger_record?.userTakenAt).toBeDefined();
    expect(r.agent_directive.must_report).toBe(true);
    expect(r.agent_directive.never_kill_user_asset).toBe(true);
  });

  it("1f. visible 档记录 → ledger_user_owned 同面（v1.17.3 P1 红线）", async () => {
    await recordLaunch(makeRec({ launchMode: "visible" }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("ledger_user_owned");
  });

  it("1g. render 档 CDP 死 → lasso_profile_orphan_suspected（guardian 自管域，只上报不越权）", async () => {
    await recordLaunch(makeRec({ launchMode: "render" }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("lasso_profile_orphan_suspected");
    expect(r.agent_directive.allowed_commands).toEqual([]);
  });

  it("1h. 无台账 + 占口者 cmdline 含 lasso profile 指纹 → lasso_profile_orphan_suspected", async () => {
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("lasso_profile_orphan_suspected");
  });

  it("1i. 无台账 + Chrome 无 lasso 指纹 → user_asset_suspected（事故正形态）", async () => {
    const r = await classifyPortOccupier(9222, baseDeps({
      psFn: () => ({
        command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222",
        etimeS: 939, // 事故时间线：用户 Chrome 仅运行 15 分钟
      }),
    }));
    expect(r.classification).toBe("user_asset_suspected");
    expect(r.evidence.etime_s).toBe(939);
    expect(r.evidence.pname).toBe("Google Chrome");
  });

  it("1j. 无台账 + 非 Chrome 进程 → external_occupier", async () => {
    const r = await classifyPortOccupier(9222, baseDeps({
      lsofFn: async () => 777,
      psFn: () => ({ command: "/usr/sbin/syslogd", etimeS: 5000 }),
    }));
    expect(r.classification).toBe("external_occupier");
  });
});

// ============================================================
// 2. R1 失效安全（空输出≠空属性——事故四根因之首的结构化排除）
// ============================================================
describe("BUG-04A · R1 失效安全", () => {
  it("2a. TCP 探测不可判（timeout/工具级异常）→ probe_failed（≠ free）", async () => {
    const r = await classifyPortOccupier(9222, baseDeps({ tcpFn: async () => null }));
    expect(r.classification).toBe("probe_failed");
    expect(r.agent_directive.allowed_commands).toEqual([]);
    expect(r.agent_directive.must_report).toBe(true);
  });

  it("2b. lsof 空输出 → probe_failed（绝不推断「无占用者」）", async () => {
    const r = await classifyPortOccupier(9222, baseDeps({ lsofFn: async () => null }));
    expect(r.classification).toBe("probe_failed");
  });

  it("2c. ps 空输出 → probe_failed（事故「空输出当零窗口」正形态）", async () => {
    const r = await classifyPortOccupier(9222, baseDeps({ psFn: () => null }));
    expect(r.classification).toBe("probe_failed");
  });

  it("2d. CDP fetch 工具级异常 ≠ free ≠ 死——身份链完好时按身份分类（事故 curl 空响应正形态）", async () => {
    const r = await classifyPortOccupier(9222, baseDeps({
      cdpVersionFn: async () => {
        throw new Error("fetch failed (connection accepted, empty body)");
      },
    }));
    // 占口者是 lasso 指纹 Chrome + 无台账 → orphan（不因 CDP 探测异常落 probe_failed）
    expect(r.classification).toBe("lasso_profile_orphan_suspected");
    expect(r.evidence.cdp.reachable).toBe(false);
  });
});

// ============================================================
// 3. R2 pid 一致性
// ============================================================
describe("BUG-04A · R2 pid 一致性", () => {
  it("3a. lsof 实测 pid ≠ 台账 rec.pid → 永不 lasso_live/zombie：按实际占口者身份分类 + pid_match:false + 台账标注陈留", async () => {
    await recordLaunch(makeRec({ pid: 5555 }));
    const r = await classifyPortOccupier(9222, baseDeps({
      lsofFn: async () => 66111, // 实际占口者 ≠ 台账记录的 pid
      cdpVersionFn: async () => ({ ok: true }),
    }));
    expect(r.evidence.pid_match).toBe(false);
    expect(r.classification).not.toBe("lasso_live");
    expect(r.classification).not.toBe("ledger_zombie_collectible");
    // 实际占口者 = lasso 指纹 Chrome → orphan（台账那只已不在该端口）
    expect(r.classification).toBe("lasso_profile_orphan_suspected");
    expect(r.evidence.ledger_record?.pid).toBe(5555);
  });

  it("3b. pid 等值但 cmdline 无归属 marker（三档同串也救不了 pid 复用场景）→ 按身份分类", async () => {
    await recordLaunch(makeRec());
    const r = await classifyPortOccupier(9222, baseDeps({
      psFn: () => ({ command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", etimeS: 10 }),
    }));
    expect(r.evidence.ownership_verified).toBe(false);
    expect(r.classification).toBe("user_asset_suspected");
  });
});

// ============================================================
// 4. R3 慢启动守卫
// ============================================================
describe("BUG-04A · R3 慢启动守卫", () => {
  it("4a. 年轻记录（< LAUNCH_GRACE_MS）+ CDP 死 → lasso_launching（永不给 kill 指引）", async () => {
    await recordLaunch(makeRec({ launchedAt: Date.now() - 5_000, status: "cdp_not_ready" }));
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.classification).toBe("lasso_launching");
    expect(r.agent_directive.allowed_commands).toEqual([]);
    expect(r.agent_directive.must_report).toBe(true);
  });

  it("4b. 年轻记录 + CDP ok → lasso_live（宽限窗不吞健康实例）", async () => {
    await recordLaunch(makeRec({ launchedAt: Date.now() - 5_000 }));
    const r = await classifyPortOccupier(9222, baseDeps({ cdpVersionFn: async () => ({ ok: true }) }));
    expect(r.classification).toBe("lasso_live");
  });

  it("4c. isLaunchingRecord 单一真源边界（<60s 真 / ≥60s 假 / 非 finite 防御真）", () => {
    // 🔴 固定 now 注入（2026-09-09 flake 收口）：原写法 launchedAt=Date.now()-59_999
    // 后不传 now——构造与判定间墙钟跨 1ms 即越 60s 窗 → false（确定性竞态：全量
    // 并发同 tick 绿、调度抖动跨 ms 红，gate 亲跑两次 1 failed 实锤）。实现本就
    // 支持注入（chrome-ledger.ts:111 now 参数）——边界语义（59_999/60_000/NaN）
    // 用固定时钟精确钉死，不再赌墙钟。
    const NOW = 1_800_000_000_000;
    expect(isLaunchingRecord(makeRec({ launchedAt: NOW - 59_999 }), NOW)).toBe(true);
    expect(isLaunchingRecord(makeRec({ launchedAt: NOW - 60_000 }), NOW)).toBe(false);
    expect(isLaunchingRecord({ ...makeRec(), launchedAt: Number.NaN } as LaunchedChromeRecord)).toBe(true);
    expect(LAUNCH_GRACE_MS).toBe(60_000);
  });

  it("4d. A2 门回补：年轻 cdp_not_ready 记录不被 zombieCollectible 收割（诚实拒绝 + 打点）", async () => {
    await recordLaunch(makeRec({ launchedAt: Date.now() - 3_000, status: "cdp_not_ready" }));
    const stopCalls: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const r = await launchChrome({
      platform: "mac" as const,
      probeExists: async () => true,
      spawnFn: (() => ({ unref() {}, on() {}, pid: 42 })) as never,
      fetchFn: async () => ({ ok: false }),
      probeIntervalMs: 1,
      probeAttempts: 1,
      defaultProfileDir: "/tmp/x",
      hideFn: () => ({ ok: false }),
      ensureEnforcerFn: async () => {},
      tcpProbeFn: async () => true,
      stopZombieFn: async (o) => {
        stopCalls.push(o.port);
      },
      aliveFn: () => true,
      psFn: () => `${CHROME_CMD}\n`,
      logFn: (p: Record<string, unknown>) => logs.push(p),
    });
    expect(r.ok).toBe(false);
    expect(stopCalls).toHaveLength(0); // 慢启动窗内绝不收割
    expect(r.error).toMatch(/may still be STARTING/);
    expect(r.error).toMatch(/never_kill_user_asset/);
    expect(logs.some((p) => p.evt === "ledger_launching_not_collected")).toBe(true);
  });

  it("4e. A2 门对照：陈年记录仍收尸重拉（R3 不误伤真僵尸）", async () => {
    await recordLaunch(makeRec()); // 缺省陈年
    const stopCalls: number[] = [];
    let fetchCalls = 0;
    const r = await launchChrome({
      platform: "mac" as const,
      probeExists: async () => true,
      spawnFn: (() => ({ unref() {}, on() {}, pid: 42 })) as never,
      fetchFn: async () => ({ ok: ++fetchCalls >= 2 }),
      probeIntervalMs: 1,
      probeAttempts: 1,
      defaultProfileDir: "/tmp/x",
      hideFn: () => ({ ok: false }),
      ensureEnforcerFn: async () => {},
      tcpProbeFn: async () => true,
      stopZombieFn: async (o) => {
        stopCalls.push(o.port);
      },
      aliveFn: () => true,
      psFn: () => `${CHROME_CMD}\n`,
    });
    expect(stopCalls).toEqual([9222]);
    expect(r.ok).toBe(true);
  });
});

// ============================================================
// 5. 输出契约（无 kill tripwire + 门槛变体纪律 + paste pack）
// ============================================================
describe("BUG-04A · 输出契约（INV-88 运行面）", () => {
  const ALL: PortOccupierClassification[] = [
    "free",
    "lasso_launching",
    "lasso_live",
    "ledger_zombie_collectible",
    "ledger_user_owned",
    "ledger_stale",
    "lasso_profile_orphan_suspected",
    "user_asset_suspected",
    "external_occupier",
    "probe_failed",
  ];

  it("5a. 全分类 allowed_commands 永不含 kill/pkill/killall 形态命令", () => {
    for (const c of ALL) {
      for (const cmd of AGENT_DIRECTIVES[c]!.allowed_commands) {
        expect(cmd).not.toMatch(/\b(p?kill|killall|kill -\d|osascript)\b/);
      }
    }
  });

  it("5b. chrome-stop 只出现在 zombie/stale 两分支且恒为 --zombie-gate 门槛变体", () => {
    for (const c of ALL) {
      const cmds = AGENT_DIRECTIVES[c]!.allowed_commands;
      const withStop = cmds.filter((x) => x.includes("chrome-stop"));
      if (c === "ledger_zombie_collectible" || c === "ledger_stale") {
        expect(withStop).toHaveLength(1);
        expect(withStop[0]).toMatch(/^lasso-mcp chrome-stop --zombie-gate --port \{PORT\}$/);
      } else {
        expect(withStop).toHaveLength(0);
      }
    }
  });

  it("5c. 其余占用分支必含 must_report + never_kill_user_asset token", () => {
    const reportBranches: PortOccupierClassification[] = [
      "lasso_launching",
      "ledger_user_owned",
      "ledger_stale",
      "lasso_profile_orphan_suspected",
      "user_asset_suspected",
      "external_occupier",
      "probe_failed",
    ];
    for (const c of reportBranches) {
      expect(AGENT_DIRECTIVES[c]!.must_report).toBe(true);
      expect(AGENT_DIRECTIVES[c]!.never_kill_user_asset).toBe(true);
    }
    // free/lasso_live/zombie 非 report 分支
    expect(AGENT_DIRECTIVES.free!.must_report).toBe(false);
    expect(AGENT_DIRECTIVES.lasso_live!.must_report).toBe(false);
    expect(AGENT_DIRECTIVES.ledger_zombie_collectible!.must_report).toBe(false);
  });

  it("5d. user_paste_pack 形状：fenced + 端口/pid 证据 + never_kill + 用户专属出口（裸 chrome-stop 只在此面允许）", async () => {
    const r = await classifyPortOccupier(9222, baseDeps());
    expect(r.user_paste_pack.startsWith("```text")).toBe(true);
    expect(r.user_paste_pack.endsWith("```")).toBe(true);
    expect(r.user_paste_pack).toContain("port 9222");
    expect(r.user_paste_pack).toContain("pid=66111");
    expect(r.user_paste_pack).toContain("never_kill_user_asset");
    expect(r.user_paste_pack).toContain("chrome-stop --port 9222"); // 用户本人出口
    expect(r.user_paste_pack).not.toMatch(/pkill|killall|kill -9/); // 但也绝不给 shell kill
  });
});

// ============================================================
// 6. CLI parse
// ============================================================
describe("BUG-04A · CLI parse", () => {
  it("6a. --port N / --json / --help 解析", () => {
    expect(parseChromeStatusArgs(["--port", "9333", "--json"])).toEqual({
      port: 9333,
      json: true,
      help: false,
    });
    expect(parseChromeStatusArgs(["--help"])).toEqual({ port: undefined, json: false, help: true });
    expect(parseChromeStatusArgs([])).toEqual({ port: undefined, json: false, help: false });
  });
});

// ============================================================
// 7. chrome-stop --zombie-gate（A2b 门槛变体）
// ============================================================
describe("BUG-04A · chrome-stop --zombie-gate", () => {
  it("7a. parse：无 --port 拒绝（agent 永不 all-stop）", () => {
    expect(() => parseChromeStopArgs(["--zombie-gate"])).toThrow(
      /--zombie-gate requires an explicit --port/,
    );
  });

  it("7b. parse：与 --modes 组合拒绝（防反向放宽）", () => {
    expect(() =>
      parseChromeStopArgs(["--zombie-gate", "--port", "9222", "--modes", "visible"]),
    ).toThrow(/cannot be combined with --modes/);
  });

  it("7c. parse：合法形态 --zombie-gate --port 9222", () => {
    const opts = parseChromeStopArgs(["--zombie-gate", "--port", "9222"]);
    expect(opts.zombieGate).toBe(true);
    expect(opts.port).toBe(9222);
  });

  it("7d. 行为：豁免 userTakenAt 记录（kill 时刻重估）→ 不杀 + gated_skipped 标注 never_kill token", async () => {
    await recordLaunch(makeRec({ pid: 7001, userTakenAt: Date.now() }));
    const killCalls: number[] = [];
    const r = await stopLaunchedChromes({
      port: 9222,
      zombieGate: true,
      aliveFn: () => true,
      psFn: (pid) => (pid === 7001 ? `${CHROME_CMD}\n` : ""),
      killTreeFn: (pid) => {
        killCalls.push(pid);
      },
      sleepFn: async () => {},
    });
    expect(killCalls).toHaveLength(0); // 已认领记录 kill 时刻被门拦下
    expect(r.gated_skipped).toHaveLength(1);
    expect(r.gated_skipped![0]!.reason).toMatch(/user_taken_asset.*never_kill_user_asset/);
  });

  it("7e. 行为：豁免 visible/render 档（modes 门）；未认领 hidden 记录正常收割", async () => {
    await recordLaunch(makeRec({ pid: 7002, launchMode: "visible", port: 9223 }));
    await recordLaunch(makeRec({ pid: 7003, launchMode: "hidden", port: 9222 }));
    const killCalls: number[] = [];
    const r = await stopLaunchedChromes({
      zombieGate: true,
      port: 9222,
      aliveFn: () => true,
      psFn: (pid) => (pid === 7003 ? `${CHROME_CMD}\n` : ""),
      killTreeFn: (pid) => {
        killCalls.push(pid);
      },
      sleepFn: async () => {},
    });
    expect(killCalls).toEqual([7003]); // 仅 hidden 记录
    expect(r.gated_skipped).toBeUndefined(); // 9222 端口无被门排除记录（visible 在 9223）
    const r2 = await stopLaunchedChromes({
      zombieGate: true,
      port: 9223,
      aliveFn: () => true,
      psFn: () => "",
      sleepFn: async () => {},
    });
    expect(r2.gated_skipped![0]!.reason).toMatch(/launch_mode_visible_gated_never_kill_user_asset/);
    expect(r2.stopped).toEqual([]); // visible 被门排除 → 零收割（台账条目保留，交用户/guardian 出口）
  });

  it("7f. 直调违反契约也拦：stopLaunchedChromes({zombieGate:true}) 无 port → throw", async () => {
    await expect(stopLaunchedChromes({ zombieGate: true })).rejects.toThrow(
      /requires an explicit --port/,
    );
  });
});

// ============================================================
// 8. admin action 接线（chrome_status）
// ============================================================
describe("BUG-04A · admin chrome_status action", () => {
  it("8a. deps 注入 → 返回分类结果（只读，免 reason）", async () => {
    const { registerAdminTool } = await import("../../src/tools/admin.js");
    let handler: ((a: unknown) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    const toolManager = {
      register: (name: string, def: { handler: (a: unknown) => Promise<unknown> }) => {
        expect(name).toBe("admin");
        handler = def.handler as typeof handler;
      },
    };
    registerAdminTool({
      bag: {} as never,
      toolManager: toolManager as never,
      callerTier: {} as never,
      registry: {} as never,
      chromeStatus: async (port?: number) =>
        classifyPortOccupier(port ?? 9222, baseDeps()),
    });
    const r = await handler!({ action: "chrome_status" });
    const parsed = JSON.parse(r.content[0]!.text) as {
      ok: boolean;
      action: string;
      classification: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("chrome_status");
    expect(parsed.classification).toBe("lasso_profile_orphan_suspected");
  });

  it("8b. 未注入 → configured:false（零回归形态）", async () => {
    const { registerAdminTool } = await import("../../src/tools/admin.js");
    let handler: ((a: unknown) => Promise<unknown>) | undefined;
    registerAdminTool({
      bag: {} as never,
      toolManager: {
        register: (_n: string, def: { handler: (a: unknown) => Promise<unknown> }) => {
          handler = def.handler;
        },
      } as never,
      callerTier: {} as never,
      registry: {} as never,
    });
    const r = (await handler!({ action: "chrome_status" })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(r.content[0]!.text).configured).toBe(false);
  });
});

// ============================================================
// 9. paste pack 单元（独立函数）
// ============================================================
describe("BUG-04A · buildUserPastePack", () => {
  it("9a. lsof/ps 失败时证据占位如实（不伪造）", () => {
    const pack = buildUserPastePack(9333, "probe_failed", {
      cdp: { reachable: false },
      cmdline_excerpt: "(lsof returned no listener pid)",
    });
    expect(pack).toContain("(lsof returned no listener pid)");
    expect(pack).toContain("never_kill_user_asset");
  });
});

// ============================================================
// 10. 默认探针源码锚（真机实证回锚）
// ============================================================
describe("BUG-04A · 默认探针源码锚", () => {
  it("10a. defaultPsFn 两次独立 ps 探测——单 spawnSync 合并 -o 列会把 command 截断到 16 字符（2026-09-08 真机实证：用户 Chrome 被截成 /Applications/Go → external_occupier 误分类）", () => {
    const src = readFileSync("src/doctor/chrome-status.ts", "utf8");
    const body = src.match(new RegExp("function defaultPsFn\\([\\s\\S]*?\\n\\}"))![0];
    expect(body).not.toMatch(/"command=",\s*"etime="/); // 合并列禁令（truncation bug 形态）
    expect((body.match(/spawnSync\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// 11. CLI 路由接线（index.ts 白盒；09-09 adversarial 回炉 F-adv-2 补）
// ============================================================
// 缺口实锤：BUG-04 决议 A / README 双语用户面已承诺 `lasso chrome-status
// [--port N] [--json]` 出口，但 index.ts 的 dispatch 块此前零守卫——删掉该块
//（或注入错形）后子命令沸进 F-CLI-01 unknown-subcommand 兜底（exit 1 + usage），
// 全量测试仍绿。守三件事：dispatch 在、注入形状对、排序先于兜底（idiom 同
// chrome-hideshow G1-8 白盒锚）。
describe("BUG-04A · CLI 路由接线（index.ts 白盒）", () => {
  const indexSrc = readFileSync("src/index.ts", "utf8");

  it("11a. dispatch 在位 + 注入形状：slice(3) 透传 + defaultPort 走 config cdpPort（README 承诺）+ helpText 单一真源", () => {
    expect(indexSrc).toMatch(/process\.argv\[2\] === "chrome-status"/);
    expect(indexSrc).toMatch(
      /runChromeStatusCli\(process\.argv\.slice\(3\), \{\s*defaultPort: csCfg\.cdpPort,\s*helpText: CLI_USAGE,/,
    );
    // defaultPort 取值链：loadConfig → csCfg.cdpPort（非硬编码 9222——多口用户面）
    expect(indexSrc).toMatch(/const csCfg = loadConfig\(\{ runId: "chrome-status-cli" \}\);/);
  });

  it("11b. 排序守卫：dispatch 必须先于 F-CLI-01 unknown-subcommand 兜底（否则 chrome-status 被 exit 1 沸掉、承诺出口不可达）", () => {
    const dispatchIdx = indexSrc.indexOf('process.argv[2] === "chrome-status"');
    const unknownIdx = indexSrc.indexOf("process.argv[2] !== undefined");
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(unknownIdx).toBeGreaterThan(dispatchIdx);
  });
});
