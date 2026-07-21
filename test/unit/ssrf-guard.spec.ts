/**
 * ssrf-guard.ts 单测（parse1 §5.1：20+ cases）
 *
 * 覆盖点：
 *  - URL 解析失败 / userinfo / 协议白名单（不触发 DNS）
 *  - DNS 失败 / DNS 空
 *  - 私网拒（10.x / 192.168.x / 127.x / IPv6 ULA）
 *  - 公网放行
 *  - DEFAULT_ALLOW_RANGES 放行（127.0.0.1/32；198.18.x 走"非私网"路径）
 *  - 127.0.0.1 放行 vs 127.0.0.2 拒
 *  - 用户 env allowRanges 扩展（放行 192.168.x）
 *  - denyRanges 优先级（deny 一个 allow 过的段）
 *  - 多记录：一公一私 → 拒
 *  - loadSsrfConfig 从 env 解析 CSV
 *
 * DNS 通过 vi.mock("node:dns/promises") 注入；每测试设置 dnsState。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted 让 mock factory 能引用可变状态
const { dnsState } = vi.hoisted(() => ({
  dnsState: {
    ips: [] as string[],
    err: null as string | null,
  },
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (_host: string, _opts?: unknown) => {
    if (dnsState.err) throw new Error(dnsState.err);
    return dnsState.ips.map((address) => ({ address }));
  }),
}));

// 在 mock 设置好后才 import SUT（vi.mock 会被 hoist 到此条 import 之前）
import { ssrfGuard, loadSsrfConfig } from "../../src/ssrf/ssrf-guard.js";

const EMPTY_CONFIG = { allowRanges: [], denyRanges: [] };

function setDns(ips: string[], err: string | null = null): void {
  dnsState.ips = ips;
  dnsState.err = err;
}

beforeEach(() => {
  setDns([]);
});

// ============================================================
// 不触发 DNS 的快速失败路径
// ============================================================
describe("ssrfGuard — URL 解析阶段", () => {
  it("非法 URL → invalid_url（无 DNS）", async () => {
    const r = await ssrfGuard("not-a-url", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("invalid_url");
    expect(r.resolvedIps).toEqual([]);
  });

  it("空串 → invalid_url", async () => {
    const r = await ssrfGuard("", EMPTY_CONFIG);
    expect(r.reason).toBe("invalid_url");
  });

  it("含 userinfo → userinfo_present（防 evil.com@trusted.com 伪装）", async () => {
    const r = await ssrfGuard("https://evil.com@trusted.com/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("userinfo_present");
  });

  it("含 password → userinfo_present", async () => {
    const r = await ssrfGuard("https://user:pass@trusted.com/x", EMPTY_CONFIG);
    expect(r.reason).toBe("userinfo_present");
  });

  it("非 http/https 协议 → protocol_not_allowed", async () => {
    const r1 = await ssrfGuard("file:///etc/passwd", EMPTY_CONFIG);
    expect(r1.allowed).toBe(false);
    expect(r1.reason).toBe("protocol_not_allowed:file:");

    const r2 = await ssrfGuard("ftp://example.com/x", EMPTY_CONFIG);
    expect(r2.reason).toBe("protocol_not_allowed:ftp:");
  });

  it("javascript: 协议被拒", async () => {
    const r = await ssrfGuard("javascript:alert(1)", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
  });
});

// ============================================================
// DNS 阶段
// ============================================================
describe("ssrfGuard — DNS 阶段", () => {
  it("DNS 失败 → dns_failed:...", async () => {
    setDns([], "getaddrinfo ENOTFOUND nope.test");
    const r = await ssrfGuard("https://nope.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason.startsWith("dns_failed:")).toBe(true);
    expect(r.resolvedIps).toEqual([]);
  });

  it("DNS 返回空数组 → dns_empty（兜底拒）", async () => {
    setDns([]);
    const r = await ssrfGuard("https://empty.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("dns_empty");
  });
});

// ============================================================
// 私网拒
// ============================================================
describe("ssrfGuard — 私网默认拒", () => {
  it("10.x 私网 → private_ip", async () => {
    setDns(["10.1.2.3"]);
    const r = await ssrfGuard("https://intranet.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:10.1.2.3");
    expect(r.resolvedIps).toEqual(["10.1.2.3"]);
  });

  it("192.168.x 私网 → private_ip", async () => {
    setDns(["192.168.1.1"]);
    const r = await ssrfGuard("https://router.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:192.168.1.1");
  });

  it("169.254.x link-local → private_ip（AWS metadata 防护）", async () => {
    setDns(["169.254.169.254"]);
    const r = await ssrfGuard("http://metadata.test/latest/meta-data/", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:169.254.169.254");
  });

  it("127.0.0.2 → private_ip（/8 私网，不在 /32 allow）", async () => {
    setDns(["127.0.0.2"]);
    const r = await ssrfGuard("https://loopback2.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:127.0.0.2");
  });

  it("IPv6 ULA fc00:: → private_ip", async () => {
    setDns(["fc00::1"]);
    const r = await ssrfGuard("https://ula.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:fc00::1");
  });

  it("IPv6 loopback ::1 → private_ip", async () => {
    setDns(["::1"]);
    const r = await ssrfGuard("https://v6loopback.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:::1");
  });
});

// ============================================================
// 放行
// ============================================================
describe("ssrfGuard — 公网 & allow 放行", () => {
  it("公网 IP 放行", async () => {
    setDns(["93.184.216.34"]); // example.com
    const r = await ssrfGuard("https://example.com/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.resolvedIps).toEqual(["93.184.216.34"]);
  });

  it("127.0.0.1 放行（DEFAULT_ALLOW_RANGES 的 /32）", async () => {
    setDns(["127.0.0.1"]);
    const r = await ssrfGuard("http://localhost:9222/json", EMPTY_CONFIG);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("公网 IPv6 放行", async () => {
    setDns(["2606:4700:4700::1111"]); // Cloudflare DNS
    const r = await ssrfGuard("https://v6.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(true);
  });

  it("公网多记录全部放行", async () => {
    setDns(["93.184.216.34", "93.184.216.35"]);
    const r = await ssrfGuard("https://multi.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(true);
    expect(r.resolvedIps).toHaveLength(2);
  });
});

// ============================================================
// 用户 env allowRanges 扩展
// ============================================================
describe("ssrfGuard — 用户 allowRanges", () => {
  it("用户 allow 192.168.0.0/16 → 192.168.1.1 放行", async () => {
    setDns(["192.168.1.1"]);
    const r = await ssrfGuard("https://intranet.test/x", {
      allowRanges: ["192.168.0.0/16"],
      denyRanges: [],
    });
    expect(r.allowed).toBe(true);
  });

  it("用户 allow 段不含的私网仍拒", async () => {
    setDns(["10.0.0.1"]);
    const r = await ssrfGuard("https://other.test/x", {
      allowRanges: ["192.168.0.0/16"],
      denyRanges: [],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:10.0.0.1");
  });
});

// ============================================================
// denyRanges 优先
// ============================================================
describe("ssrfGuard — deny 优先", () => {
  it("deny 命中公网 IP → 拒", async () => {
    setDns(["8.8.8.8"]);
    const r = await ssrfGuard("https://blocked.test/x", {
      allowRanges: [],
      denyRanges: ["8.8.8.0/24"],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("deny_range:8.8.8.8");
  });

  it("deny 覆盖 allow（同 IP 同时在两边 → deny 赢）", async () => {
    setDns(["127.0.0.1"]);
    const r = await ssrfGuard("http://localhost:9222/x", {
      allowRanges: ["127.0.0.1/32"],
      denyRanges: ["127.0.0.0/8"],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("deny_range:127.0.0.1");
  });
});

// ============================================================
// 多记录（一公一私）
// ============================================================
describe("ssrfGuard — 多记录", () => {
  it("DNS 返回一公一私 → 拒（私网那条触发）", async () => {
    setDns(["93.184.216.34", "10.0.0.1"]);
    const r = await ssrfGuard("https://mixed.test/x", EMPTY_CONFIG);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:10.0.0.1");
    expect(r.resolvedIps).toEqual(["93.184.216.34", "10.0.0.1"]);
  });
});

// ============================================================
// loadSsrfConfig env 解析
// ============================================================
describe("loadSsrfConfig", () => {
  it("无 env → 空表（DEFAULT_ALLOW_RANGES 在 ssrfGuard 内部合并，不在此处）", () => {
    const cfg = loadSsrfConfig({});
    expect(cfg.allowRanges).toEqual([]);
    expect(cfg.denyRanges).toEqual([]);
  });

  it("单个 allow 段", () => {
    const cfg = loadSsrfConfig({ LASSO_SSRF_ALLOW_RANGES: "10.0.0.0/8" });
    expect(cfg.allowRanges).toEqual(["10.0.0.0/8"]);
  });

  it("CSV allow + deny（带空格）", () => {
    const cfg = loadSsrfConfig({
      LASSO_SSRF_ALLOW_RANGES: "10.0.0.0/8, 172.16.0.0/12 ,192.168.0.0/16",
      LASSO_SSRF_DENY_RANGES: "8.8.8.8, 1.1.1.1",
    });
    expect(cfg.allowRanges).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]);
    expect(cfg.denyRanges).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("空串 / 纯空白 → 空表", () => {
    const cfg = loadSsrfConfig({
      LASSO_SSRF_ALLOW_RANGES: "   ,  ,",
      LASSO_SSRF_DENY_RANGES: "",
    });
    expect(cfg.allowRanges).toEqual([]);
    expect(cfg.denyRanges).toEqual([]);
  });

  it("非法 CIDR 不在加载时校验（留给 cidrContains 兜底）", () => {
    const cfg = loadSsrfConfig({ LASSO_SSRF_ALLOW_RANGES: "garbage,10.0.0.0/8" });
    expect(cfg.allowRanges).toEqual(["garbage", "10.0.0.0/8"]);
    // 运行时 ssrfGuard 对 "garbage" 的 cidrContains 会返回 false，不抛错
  });
});
