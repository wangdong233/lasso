/**
 * login-bridge-tool.spec.ts（v1.31 F4——方案 §六-5/6/7/8：工具行为+守卫）
 *
 * 全 DI 注入（不 spawn/不 listen）：start 幂等与字段契约 / host 解析失败的
 * didnt 教学 / status 的 cookieDelta+touch 语义 / stop 与 wipe / 负向守卫
 * （源码锚：无模块级监听、env-先行、披露句在场）。
 *
 * 注意：模块级 bridge state 跨用例存续——本文件按「单流程顺序」组织（bug13
 * 惰性 attach spec 同款纪律）；重置经 stop 完成。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { handleLoginBridgeAction, type LoginBridgeDeps } from "../../src/tools/login-bridge.js";
import type { LoginRelayHandle } from "../../src/login-bridge/relay.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function fakeRelay(): LoginRelayHandle & { stopped: boolean } {
  return {
    stopped: false,
    state: () => ({ active: true, connections: 1, host: "100.1.2.3", port: 9226, cdpPort: 9225, lastActivityAt: Date.now() }),
    stop: async function (this: { stopped: boolean }) {
      this.stopped = true;
    },
  } as never;
}

interface Calls {
  touched: number;
  stopped: number;
  removed: string[];
  cookies: Array<{ name: string; domain: string }>;
}

function makeDeps(calls: Calls, relay?: LoginRelayHandle): LoginBridgeDeps {
  return {
    ensureChrome: async () => ({
      ok: true as const,
      reused: false,
      port: 9225,
      pid: 4242,
      wsEndpoint: "ws://127.0.0.1:9225/devtools/browser/x",
      profileDir: "/tmp/x/login-chrome-profile/default",
      startedAt: Date.now(),
    }),
    createRelay: async () => relay ?? fakeRelay(),
    resolveHost: async () => null as never, // 默认桩——单测内覆盖
    getCookies: async () => calls.cookies,
    touch: async () => {
      calls.touched += 1;
    },
    stopChromes: async () => {
      calls.stopped += 1;
    },
    removeProfile: (dir: string) => {
      calls.removed.push(dir);
    },
  };
}

/** resolveHost 成功桩（三序皆可，这里直给 tailscale 形态）。⚠️ async 函数——
 * P31 移交2（2026-10-26）起 resolveBridgeHost 为 async：消费面 await 后 async 桩
 * 是唯一类型正确形态（同步裸对象桩不再通过 LoginBridgeDeps.resolveHost 类型）。 */
function hostOk() {
  return async () => ({ host: "100.1.2.3", origin: "http://100.1.2.3:9226", allowOrigins: ["http://100.1.2.3:9226"], source: "tailscale" as const });
}

describe("单流程：start → status → stop（模块状态生命周期）", () => {
  const calls: Calls = { touched: 0, stopped: 0, removed: [], cookies: [] };
  const relay = fakeRelay();
  const deps = { ...makeDeps(calls, relay), resolveHost: hostOk() };

  beforeAll(() => {
    // 环境钉（loginCdpPort/loginRelayPort/loginProfileNs 读真 env——本机无覆盖时即默认）
    delete process.env.LASSO_LOGIN_BRIDGE_CDP_PORT;
    delete process.env.LASSO_LOGIN_BRIDGE_PORT;
    delete process.env.LASSO_LOGIN_BRIDGE_NS;
    // R1（提案 v2）：start 处理段经 mergedEnv 读 LASSO_LAUNCH_*（file→env 合并）——
    // 清 env 键 + 把 config 文件指到不存在路径，防开发机 ~/.lasso/config.json 污染
    delete process.env.LASSO_LAUNCH_LOCALE;
    delete process.env.LASSO_LAUNCH_EXTRA_ARGS;
    process.env.LASSO_CONFIG_PATH = path.join(HERE, "nonexistent-r1-isolation.json");
  });

  it("start：worked + url/指引/attachHint 契约字段齐备", async () => {
    const r = await handleLoginBridgeAction({ action: "start" }, deps);
    expect(r.outcome).toBe("worked");
    const d = r.data as Record<string, unknown>;
    expect(d.url).toBe("http://100.1.2.3:9226/");
    expect(d.cdpPort).toBe(9225);
    expect(d.attachHint).toContain("LASSO_CDP_PORT=9225");
    expect(String(d.guidance)).toContain("screencast");
    expect(String(d.caveats)).toContain("明文");
    expect(String(d.caveats)).toContain("无鉴权");
  });

  it("start 幂等：重复 start 返回当前桥（reused:true，不再起 Chrome/relay）", async () => {
    const r = await handleLoginBridgeAction({ action: "start" }, deps);
    expect(r.outcome).toBe("worked");
    expect((r.data as Record<string, unknown>).reused).toBe(true);
  });

  it("status：cookieDelta 报增量事实 + touch 打点（轮询=touch 唯一源）", async () => {
    const before = calls.touched;
    calls.cookies = [
      { name: "sid", domain: ".example.com" },
      { name: "token", domain: ".app.example.com" },
    ];
    const r = await handleLoginBridgeAction({ action: "status" }, deps);
    expect(r.outcome).toBe("worked");
    const d = r.data as Record<string, unknown>;
    const delta = d.cookieDelta as { domains: Record<string, number>; totalNew: number };
    expect(delta.totalNew).toBe(2);
    expect(delta.domains["example.com"]).toBe(1);
    expect(delta.domains["app.example.com"]).toBe(1);
    expect(calls.touched).toBeGreaterThan(before);
    expect(String(d.note)).toContain("agent");
  });

  it("stop：relay 关+state 清+Chrome 留守（wipe 缺省 false）", async () => {
    const r = await handleLoginBridgeAction({ action: "stop" }, deps);
    expect(r.outcome).toBe("worked");
    expect((r.data as Record<string, unknown>).wiped).toBe(false);
    expect(relay.stopped).toBe(true);
    expect(calls.stopped).toBe(0);
    expect(calls.removed).toEqual([]);
    // stop 后 status → not_started
    const s = await handleLoginBridgeAction({ action: "status" }, deps);
    expect(s.outcome).toBe("didnt");
  });
});

describe("错误路径与 wipe", () => {
  it("start 时 host 解析失败 → didnt + 可教学错误（env 名点名）", async () => {
    const calls: Calls = { touched: 0, stopped: 0, removed: [], cookies: [] };
    const deps = { ...makeDeps(calls), resolveHost: hostOk() };
    // 覆盖 resolveHost 返回 null（async 桩——P31 移交2 后联合类型下形态自洽）
    const nullHost = async () => null;
    const r = await handleLoginBridgeAction({ action: "start" }, { ...deps, resolveHost: nullHost });
    expect(r.outcome).toBe("didnt");
    expect((r.data as Record<string, unknown>).error).toContain("LASSO_LOGIN_BRIDGE_HOST");
  });

  it("start 时 Chrome 拉起失败 → didnt 透传 launcher 错误", async () => {
    const calls: Calls = { touched: 0, stopped: 0, removed: [], cookies: [] };
    const failing = { ...makeDeps(calls), resolveHost: hostOk() };
    const r = await handleLoginBridgeAction(
      { action: "start" },
      { ...failing, ensureChrome: async () => ({ ok: false as const, error: "login_chrome_not_found:no binary" }) },
    );
    expect(r.outcome).toBe("didnt");
    expect((r.data as Record<string, unknown>).error).toContain("login_chrome_not_found");
  });

  it("stop wipe：stopChromes+removeProfile 都被调用（登录资产清零）", async () => {
    const calls: Calls = { touched: 0, stopped: 0, removed: [], cookies: [] };
    const relay = fakeRelay();
    const deps = { ...makeDeps(calls, relay), resolveHost: hostOk() };
    await handleLoginBridgeAction({ action: "start" }, deps);
    const r = await handleLoginBridgeAction({ action: "stop", wipe: true }, deps);
    expect(r.outcome).toBe("worked");
    expect((r.data as Record<string, unknown>).wiped).toBe(true);
    expect(calls.stopped).toBe(1);
    expect(calls.removed).toEqual(["/tmp/x/login-chrome-profile/default"]);
  });

  it("未 start 的 status/stop → didnt 教学", async () => {
    const calls: Calls = { touched: 0, stopped: 0, removed: [], cookies: [] };
    const deps = { ...makeDeps(calls), resolveHost: hostOk() };
    const s = await handleLoginBridgeAction({ action: "status" }, deps);
    expect(s.outcome).toBe("didnt");
    const st = await handleLoginBridgeAction({ action: "stop" }, deps);
    expect(st.outcome).toBe("didnt");
  });
});

describe("负向守卫（源码锚——方案 §五 INV 红线）", () => {
  const relaySrc = readFileSync(`${HERE}/../../src/login-bridge/relay.ts`, "utf8");
  const hostSrc = readFileSync(`${HERE}/../../src/login-bridge/host.ts`, "utf8");
  const descSrc = readFileSync(`${HERE}/../../src/tools/descriptions.ts`, "utf8");

  it("INV：relay 无模块级监听（createServer 只在函数体内，posture：start 后才存在）", () => {
    const occurrences = [...relaySrc.matchAll(/createServer\(/g)].length;
    expect(occurrences).toBe(1);
    // 顶层（第 0 列）无 createServer 调用
    expect(/^createServer\(/m.test(relaySrc)).toBe(false);
  });

  it("INV：host 解析 env 先行（LASSO_LOGIN_BRIDGE_HOST 判定先于 tailscale CLI）", () => {
    expect(hostSrc.indexOf("LASSO_LOGIN_BRIDGE_HOST")).toBeGreaterThan(-1);
    expect(hostSrc.indexOf("LASSO_LOGIN_BRIDGE_HOST")).toBeLessThan(hostSrc.indexOf('["ip", "-4"]'));
  });

  it("契约：LOGIN_BRIDGE_DESCRIPTION 披露句在场（PLAINTEXT/UNAUTHENTICATED/ASCII-only）", () => {
    expect(descSrc).toContain("PLAINTEXT");
    expect(descSrc).toContain("UNAUTHENTICATED");
    expect(descSrc).toContain("ASCII-only");
  });

  it("契约：doctor #43 名称与清单一致（descriptions ↔ doctor.ts 双锚）", () => {
    const doctorSrc = readFileSync(`${HERE}/../../src/doctor/doctor.ts`, "utf8");
    expect(doctorSrc).toContain('name: "login_bridge"');
    expect(descSrc).toContain("login_bridge (v1.31");
  });
});

// ============================================================
// R1（2026-10-26 需求单，提案 v2 Task 3）：start 透传跨档键到 ensureChrome
// ============================================================
describe("R1 · start 透传 LASSO_LAUNCH_LOCALE / EXTRA_ARGS（跨档单键，mergedEnv）", () => {
  it("env 两键 → ensureChrome 收到 locale + extraArgs（空白拆分，window-size 逗号保真）", async () => {
    // 模块级 bridge state 复位（stop 幂等——未激活时也 worked）
    await handleLoginBridgeAction({ action: "stop" });
    process.env.LASSO_LAUNCH_LOCALE = "zh-CN";
    process.env.LASSO_LAUNCH_EXTRA_ARGS = "--window-size=1920,1080 --proxy-server=127.0.0.1:7897";
    const calls: Calls = { touched: 0, stopped: 0, removed: [], cookies: [] };
    let captured: { locale?: string; extraArgs?: string[] } | null = null;
    const base = makeDeps(calls);
    const baseEnsure = base.ensureChrome;
    const d = {
      ...base,
      resolveHost: hostOk(),
      ensureChrome: async (opts: never) => {
        captured = opts as { locale?: string; extraArgs?: string[] };
        return baseEnsure(opts as never);
      },
    };
    try {
      const r = await handleLoginBridgeAction({ action: "start" }, d);
      expect(r.outcome).toBe("worked");
      expect(captured?.locale).toBe("zh-CN");
      expect(captured?.extraArgs).toEqual([
        "--window-size=1920,1080",
        "--proxy-server=127.0.0.1:7897",
      ]);
    } finally {
      delete process.env.LASSO_LAUNCH_LOCALE;
      delete process.env.LASSO_LAUNCH_EXTRA_ARGS;
      await handleLoginBridgeAction({ action: "stop" });
    }
  });

  it("白盒：start 处理段经 mergedEnv 读两键（跨档单键消费点登记锚）", () => {
    const src2 = readFileSync(`${HERE}/../../src/tools/login-bridge.ts`, "utf8");
    expect(src2).toContain("mergedEnv()");
    expect(src2).toContain("LASSO_LAUNCH_LOCALE");
    expect(src2).toContain("parseExtraArgsEnvValue");
  });
});
