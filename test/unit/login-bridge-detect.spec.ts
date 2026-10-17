/**
 * login-bridge-detect.spec.ts（v1.31 F4——方案 §六-4）
 *
 * 1. 噪声过滤（Cloudflare/GA 家族 + _ga_/_gat_ 测量族变体前缀）
 * 2. 域名归一（前导点）
 * 3. 增量语义：基线已有不计数（「登录前就有 cookie 的站」不误报）；SSO 多域分账；
 *    同名跨域计两键
 */
import { describe, it, expect } from "vitest";
import {
  isNoiseCookie,
  normalizeDomain,
  snapshotCookieKeys,
  cookieDelta,
  NOISE_COOKIE_NAMES,
} from "../../src/login-bridge/detect.js";

const ck = (name: string, domain: string) => ({ name, domain });

describe("噪声过滤", () => {
  it("名单精确匹配：__cf_bm/cf_clearance/_ga/_gid 等", () => {
    for (const n of ["__cf_bm", "cf_clearance", "_ga", "_gid", "_gat", "_fbp", "__utma"]) {
      expect(isNoiseCookie(ck(n, "example.com"))).toBe(true);
    }
    expect(NOISE_COOKIE_NAMES.has("__cf_bm")).toBe(true);
  });
  it("GA 测量族变体前缀：_ga_XXXX / _gat_XXXX", () => {
    expect(isNoiseCookie(ck("_ga_ABC123DEF", "example.com"))).toBe(true);
    expect(isNoiseCookie(ck("_gat_UA-123456-7", "example.com"))).toBe(true);
    expect(isNoiseCookie(ck("session_id", "example.com"))).toBe(false);
  });
});

describe("域名归一与键", () => {
  it("前导点剥除 + 小写化", () => {
    expect(normalizeDomain(".Example.COM")).toBe("example.com");
  });
  it("同名跨域计两键（SSO 语义前提）", () => {
    const s = snapshotCookieKeys([ck("sid", "a.com"), ck("sid", ".b.com")]);
    expect(s.size).toBe(2);
  });
});

describe("cookieDelta 增量语义（方案 F2 #4 裁决的行为钉）", () => {
  it("基线已有的 cookie 不计新增（登录前存量不误报）", () => {
    const baseline = snapshotCookieKeys([ck("pre_existing", "example.com"), ck("__cf_bm", "example.com")]);
    const delta = cookieDelta(baseline, [ck("pre_existing", "example.com"), ck("new_session", "example.com")]);
    expect(delta.totalNew).toBe(1);
    expect(delta.domains).toEqual({ "example.com": 1 });
  });
  it("噪声 cookie 的新增也不计（cf 轮换不制造假信号）", () => {
    const baseline = snapshotCookieKeys([]);
    const delta = cookieDelta(baseline, [ck("__cf_bm", "example.com"), ck("cf_clearance", "example.com"), ck("token", "example.com")]);
    expect(delta.totalNew).toBe(1);
  });
  it("SSO 多跳：多域新增分账呈现（agent 自行关联）", () => {
    const baseline = snapshotCookieKeys([]);
    const delta = cookieDelta(baseline, [
      ck("sso", "accounts.example-sso.com"),
      ck("app_session", ".app.example.com"),
      ck("lo", "linkedin.com"),
    ]);
    expect(delta.totalNew).toBe(3);
    expect(delta.domains["accounts.example-sso.com"]).toBe(1);
    expect(delta.domains["app.example.com"]).toBe(1);
    expect(delta.domains["linkedin.com"]).toBe(1);
  });
  it("重复出现只计一次（seen 去重）", () => {
    const delta = cookieDelta(new Set(), [ck("a", "x.com"), ck("a", ".x.com"), ck("a", "x.com")]);
    expect(delta.totalNew).toBe(1);
  });
  it("空 after → 零 delta（Chrome 死时 status 不误报）", () => {
    const delta = cookieDelta(new Set(["old@x.com"]), []);
    expect(delta.totalNew).toBe(0);
    expect(delta.domains).toEqual({});
  });
});
