/**
 * C2（v1.18，doc/28-静默守则审计 D-2）测试：
 * visible 台账 Chrome「登录完成 → 自动 hide 转后台静默」（opt-in，默认 off）。
 *
 * 守护四重防误判护栏（audit C2 裁决条件 + fix-2 补第三护栏）：
 *  ① 从未观测到登录墙 → 永不 hide（用户可能只是开着看）
 *  ② 墙消失后须过延迟窗（窗内再见墙重新计时——多步登录）
 *  ③ agent 近期有活动（touch）→ 等（in-flight 粗近似）
 *  ④ 探测失败 / hide 失败 → 降级不 hide（后者本进程内永久降级）
 * 结构性红线：只动台账 visible 记录、hide 按 PID（非 kill；visible 永不进 stopFn）；
 * 默认 off（不配置时 hideFn 零调用）。
 *
 * 全注入（readLedgerFn / nowFn / tabUrlsFn / hideFn / stopFn / fake timers）——
 * 零真机、零真实 CDP、零真实 osascript。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startChromeIdleReaper,
  CHROME_IDLE_REAPER_INTERVAL_MS,
  LOGIN_WALL_URL_RE,
  AUTO_HIDE_AFTER_LOGIN_DELAY_MS,
} from "../../src/launcher/chrome-idle-reaper.js";
import type { LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 111,
    profileDir: "/tmp/lasso-profile-autohide",
    launchedAt: 0,
    status: "ready",
    launchMode: "visible",
    ...overrides,
  };
}

/** C2 测试装配：可控时钟 + 可控 tab URL 序列 + 记录型 hideFn/stopFn/logFn。 */
function makeAutoHideReaper(
  ledger: LaunchedChromeRecord[],
  urlsByTick: Array<string[] | Error>,
  opts: {
    delayMs?: number;
    touchAt?: number;
    hideOk?: boolean;
  } = {},
) {
  let now = 1_000_000;
  let tickNo = 0;
  const hideCalls: number[] = [];
  const stopCalls: number[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const reaper = startChromeIdleReaper({
    defaultIdleMs: 60_000,
    autoHideAfterLogin: true,
    autoHideDelayMs: opts.delayMs ?? 10_000,
    readLedgerFn: () => ledger,
    nowFn: () => now,
    tabUrlsFn: async () => {
      const v = urlsByTick[Math.min(tickNo, urlsByTick.length - 1)];
      tickNo++;
      if (v instanceof Error) throw v;
      return v;
    },
    hideFn: (pid) => {
      hideCalls.push(pid ?? -1);
      return opts.hideOk === false ? { ok: false, reason: "osascript_exit_1743" } : { ok: true };
    },
    stopFn: async (o) => {
      stopCalls.push(o.port);
    },
    logFn: (p) => logs.push(p),
    intervalMs: CHROME_IDLE_REAPER_INTERVAL_MS,
  });
  return {
    reaper,
    hideCalls,
    stopCalls,
    logs,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
    get tickNo() {
      return tickNo;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("C2 · 登录墙 URL 判据（LOGIN_WALL_URL_RE）", () => {
  it("命中：常见登录/鉴权 URL 形态", () => {
    for (const u of [
      "https://github.com/login",
      "https://example.com/log-in",
      "https://example.com/signin?next=/",
      "https://example.com/auth/callback",
      "https://sso.corp.example.com/home",
      "https://accounts.example.com/oauth/authorize",
      "https://example.com/session/2fa",
      "https://login.dedao.cn/welcome",
      "https://example.com/verify",
    ]) {
      expect(LOGIN_WALL_URL_RE.test(u), u).toBe(true);
    }
  });
  it("不命中：词边界内嵌（authorizations / login-tips）与普通页面", () => {
    for (const u of [
      "https://github.com/settings/authorizations/123",
      "https://example.com/posts/login-tips",
      "https://example.com/dashboard",
      "https://example.com/articles/oAuthless-world", // 词中内嵌（前字符字母）
      "https://www.example.com/",
    ]) {
      expect(LOGIN_WALL_URL_RE.test(u), u).toBe(false);
    }
  });
});

describe("C2 · 登录完成自动 hide（四重护栏）", () => {
  it("1. 默认 off：未开 autoHideAfterLogin → 见墙+消失+超窗也绝不 hide", async () => {
    const hideCalls: number[] = [];
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 60_000,
      readLedgerFn: () => [makeRec()],
      nowFn: () => 1_000_000,
      tabUrlsFn: async () => ["https://example.com/dashboard"],
      hideFn: (pid) => {
        hideCalls.push(pid ?? -1);
        return { ok: true };
      },
      stopFn: async () => {},
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 3);
    expect(hideCalls).toEqual([]);
    reaper!.stop();
  });

  it("2. 全护栏通过 → hide 一次；stopFn 永不收 visible；不重复 hide", async () => {
    // tick1：墙在；tick2：墙刚消失（起表）；tick3+11s：过窗 → hide
    const t = makeAutoHideReaper(
      [makeRec()],
      [["https://github.com/login"], ["https://github.com/dashboard"], ["https://github.com/dashboard"]],
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick1
    expect(t.hideCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick2 起表
    expect(t.hideCalls).toEqual([]);
    t.now += 11_000; // 过延迟窗（agent idle：launchedAt=0，touch 无）
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick3 hide
    expect(t.hideCalls).toEqual([111]);
    expect(t.stopCalls).toEqual([]); // visible 永不进 kill 路径（N4）
    expect(t.logs.some((p) => p.evt === "chrome_auto_hidden_after_login")).toBe(true);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 2); // 不重复
    expect(t.hideCalls).toEqual([111]);
    t.reaper?.stop();
  });

  it("3. 护栏①：从未见墙（一直普通页）→ 永不 hide", async () => {
    const t = makeAutoHideReaper([makeRec()], [["https://example.com/dashboard"]]);
    t.now += 10 * 60_000;
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 4);
    expect(t.hideCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("4. 护栏②：延迟窗内再进墙 → 重新计时（窗内不 hide）", async () => {
    const t = makeAutoHideReaper(
      [makeRec()],
      [
        ["https://github.com/login"], // tick1 见墙
        ["https://github.com/dashboard"], // tick2 墙消失起表
        ["https://github.com/login"], // tick3 窗内又进墙（多步登录）→ 重置
        ["https://github.com/dashboard"], // tick4 再起表
      ],
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick1
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick2
    t.now += 11_000; // 第一个窗过——但 tick3 墙又出现
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick3：见墙重置，不 hide
    expect(t.hideCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick4：再起表
    t.now += 9_000; // 第二个窗未过
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.hideCalls).toEqual([]);
    t.now += 2_000; // 过第二个窗
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.hideCalls).toEqual([111]);
    t.reaper?.stop();
  });

  it("5. 护栏③：agent 近期 touch（browse 活动）→ 等安静下来才 hide", async () => {
    const t = makeAutoHideReaper(
      [makeRec()],
      [["https://github.com/login"], ["https://github.com/dashboard"]],
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick1 见墙
    const clearAt = t.now;
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick2 墙消失起表（since=clearAt）
    t.now = clearAt + 15_000;
    t.reaper!.touch(9222); // agent 在墙消失 15s 后 browse 了一次（touch 晚于起表）
    t.now = clearAt + 20_000; // ② 墙消失窗 20s ≥ 10s 已过，但距 touch 仅 5s < 10s
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick3 ③拦截不 hide
    expect(t.hideCalls).toEqual([]);
    t.now = clearAt + 30_000; // 距 touch 15s ≥ 10s → ③ 也过
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick4 hide
    expect(t.hideCalls).toEqual([111]);
    t.reaper?.stop();
  });

  it("6. 护栏④a：CDP 探测失败（throw）→ 降级不 hide，下轮重探恢复", async () => {
    const t = makeAutoHideReaper(
      [makeRec()],
      [
        ["https://github.com/login"], // tick1 见墙
        new Error("fetch failed"), // tick2 探测失败 → 重置延迟窗
        ["https://github.com/dashboard"], // tick3 起表
        ["https://github.com/dashboard"], // tick4 过窗 → hide
      ],
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick1
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick2 失败
    expect(t.hideCalls).toEqual([]);
    expect(t.logs.some((p) => p.evt === "chrome_auto_hide_probe_error")).toBe(true);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick3 起表
    t.now += 11_000;
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick4 hide
    expect(t.hideCalls).toEqual([111]);
    t.reaper?.stop();
  });

  it("7. 护栏④b：hide 失败（TCC 缺失 1743）→ 本进程永久降级，不重试", async () => {
    const t = makeAutoHideReaper(
      [makeRec()],
      [["https://github.com/login"], ["https://github.com/dashboard"]],
      { hideOk: false },
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick1 见墙
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick2 起表
    t.now += 11_000;
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // tick3 hide 失败
    expect(t.hideCalls).toEqual([111]);
    expect(t.logs.some((p) => p.evt === "chrome_auto_hide_failed")).toBe(true);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 3); // 不重试
    expect(t.hideCalls).toEqual([111]);
    t.reaper?.stop();
  });

  it("8. 边界：hidden 记录不受 autoHide 影响（仍走 idle 收割，不走 hide）", async () => {
    const t = makeAutoHideReaper(
      [makeRec({ launchMode: "hidden", launchedAt: 0 })],
      [["https://github.com/login"]],
    );
    t.now += 75_000; // 过 60s idle
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([9222]); // hidden 照旧收割
    expect(t.hideCalls).toEqual([]); // hide 只服务 visible
    t.reaper?.stop();
  });

  it("9. idle 全局禁用 + autoHide 开 → reaper 仍运行（visible 自动 hide 照常）", async () => {
    let now = 1_000_000;
    const hideCalls: number[] = [];
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 0,
      autoHideAfterLogin: true,
      readLedgerFn: () => [makeRec()],
      nowFn: () => now,
      tabUrlsFn: async () => ["https://github.com/login"],
      hideFn: (pid) => {
        hideCalls.push(pid ?? -1);
        return { ok: true };
      },
      stopFn: async () => {},
    });
    expect(reaper).not.toBeNull(); // 0=禁用 idle 收割，但 autoHide 仍需调度器
    now += 5_000;
    reaper!.touch(9222);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(hideCalls).toEqual([]); // 墙还在
    reaper!.stop();
  });

  it("10. 默认延迟窗 = 10s（AUTO_HIDE_AFTER_LOGIN_DELAY_MS 单一真源）", () => {
    expect(AUTO_HIDE_AFTER_LOGIN_DELAY_MS).toBe(10_000);
  });
});

describe("C2 · config 配置面（LASSO_AUTO_HIDE_AFTER_LOGIN*）", () => {
  /** 隔离真实 ~/.lasso/config.json（file→env 合并会读它）。 */
  const isoEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    LASSO_CONFIG_PATH: "/nonexistent/lasso-c2-config-isolation.json",
    ...extra,
  });

  it("默认 off + delay 10s；显式真值开启；非法 delay 回退默认", async () => {
    const { loadConfig } = await import("../../src/config/config.js");
    const cfg0 = loadConfig({ runId: "t", env: isoEnv() });
    expect(cfg0.autoHideAfterLogin).toBe(false);
    expect(cfg0.autoHideAfterLoginDelayMs).toBe(10_000);
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      expect(
        loadConfig({ runId: "t", env: isoEnv({ LASSO_AUTO_HIDE_AFTER_LOGIN: v }) })
          .autoHideAfterLogin,
        v,
      ).toBe(true);
    }
    for (const v of ["", "0", "false", "off", "bogus"]) {
      expect(
        loadConfig({ runId: "t", env: isoEnv({ LASSO_AUTO_HIDE_AFTER_LOGIN: v }) })
          .autoHideAfterLogin,
        v,
      ).toBe(false);
    }
    expect(
      loadConfig({
        runId: "t",
        env: isoEnv({ LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS: "30000" }),
      }).autoHideAfterLoginDelayMs,
    ).toBe(30_000);
    expect(
      loadConfig({
        runId: "t",
        env: isoEnv({ LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS: "abc" }),
      }).autoHideAfterLoginDelayMs,
    ).toBe(10_000);
  });

  it("CONFIG_TEMPLATE 含两新键（默认 off / 10s——opt-in 裁决的模板面）", async () => {
    const { CONFIG_TEMPLATE } = await import("../../src/config/config.js");
    expect(CONFIG_TEMPLATE.LASSO_AUTO_HIDE_AFTER_LOGIN).toBe(false);
    expect(CONFIG_TEMPLATE.LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS).toBe(10000);
  });
});
