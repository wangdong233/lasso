/**
 * cidr.ts 单测（parse1 §5.1）
 *
 * 覆盖点：
 *  - cidrContains: boundary（首末 IP）、跨族、非法 IP、非法 CIDR
 *  - isPrivateIp: 默认表覆盖私网 + 公网 + IPv6 ULA/loopback
 */
import { describe, it, expect } from "vitest";
import { cidrContains, isPrivateIp } from "../../src/ssrf/cidr.js";
import { PRIVATE_RANGES, DEFAULT_ALLOW_RANGES } from "../../src/ssrf/defaults.js";

describe("cidrContains", () => {
  describe("IPv4 边界", () => {
    it("10.0.0.0/8 含首 IP 10.0.0.0", () => {
      expect(cidrContains("10.0.0.0/8", "10.0.0.0")).toBe(true);
    });
    it("10.0.0.0/8 含末 IP 10.255.255.255", () => {
      expect(cidrContains("10.0.0.0/8", "10.255.255.255")).toBe(true);
    });
    it("10.0.0.0/8 含中间 IP 10.1.2.3", () => {
      expect(cidrContains("10.0.0.0/8", "10.1.2.3")).toBe(true);
    });
    it("10.0.0.0/8 不含 11.0.0.1（刚出段）", () => {
      expect(cidrContains("10.0.0.0/8", "11.0.0.1")).toBe(false);
    });
    it("10.0.0.0/8 不含 9.255.255.255（刚出段）", () => {
      expect(cidrContains("10.0.0.0/8", "9.255.255.255")).toBe(false);
    });
    it("127.0.0.1/32 仅含 127.0.0.1（不含 127.0.0.2）", () => {
      expect(cidrContains("127.0.0.1/32", "127.0.0.1")).toBe(true);
      expect(cidrContains("127.0.0.1/32", "127.0.0.2")).toBe(false);
    });
    it("198.18.0.0/15 含 198.18.0.0 / 198.19.255.255 / 198.18.x.x", () => {
      expect(cidrContains("198.18.0.0/15", "198.18.0.0")).toBe(true);
      expect(cidrContains("198.18.0.0/15", "198.19.255.255")).toBe(true);
      expect(cidrContains("198.18.0.0/15", "198.18.100.5")).toBe(true);
    });
    it("198.18.0.0/15 不含 198.17.x.x / 198.20.x.x", () => {
      expect(cidrContains("198.18.0.0/15", "198.17.255.255")).toBe(false);
      expect(cidrContains("198.18.0.0/15", "198.20.0.0")).toBe(false);
    });
  });

  describe("跨族 / 非法输入", () => {
    it("IPv4 CIDR 对 IPv6 IP 返回 false", () => {
      expect(cidrContains("10.0.0.0/8", "::1")).toBe(false);
    });
    it("IPv6 CIDR 对 IPv4 IP 返回 false", () => {
      expect(cidrContains("::1/128", "127.0.0.1")).toBe(false);
    });
    it("非法 IP 字符串 → false", () => {
      expect(cidrContains("10.0.0.0/8", "not-an-ip")).toBe(false);
      expect(cidrContains("10.0.0.0/8", "")).toBe(false);
      expect(cidrContains("10.0.0.0/8", "999.999.999.999")).toBe(false);
    });
    it("非法 CIDR → false（不抛错）", () => {
      expect(cidrContains("garbage", "10.0.0.1")).toBe(false);
      expect(cidrContains("10.0.0.0", "10.0.0.1")).toBe(false); // 缺掩码
      expect(cidrContains("", "10.0.0.1")).toBe(false);
    });
  });

  describe("IPv6 边界", () => {
    it("fc00::/7 含 fc00:: 和 fdff:ffff:...", () => {
      expect(cidrContains("fc00::/7", "fc00::")).toBe(true);
      expect(cidrContains("fc00::/7", "fd00::1")).toBe(true);
    });
    it("fc00::/7 不含 fe00::", () => {
      expect(cidrContains("fc00::/7", "fe00::")).toBe(false);
    });
    it("::1/128 仅含 ::1", () => {
      expect(cidrContains("::1/128", "::1")).toBe(true);
      expect(cidrContains("::1/128", "::2")).toBe(false);
    });
  });
});

describe("isPrivateIp", () => {
  it("私网 IPv4 命中", () => {
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.1.2.3")).toBe(true);
    expect(isPrivateIp("169.254.1.1")).toBe(true); // link-local
    expect(isPrivateIp("100.64.0.1")).toBe(true); // CGNAT
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });
  it("172.32.x.x 不是私网（出 /12）", () => {
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });
  it("公网 IPv4 不命中", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("198.18.0.5")).toBe(false); // RFC 2544 不在 PRIVATE_RANGES
  });
  it("IPv6 ULA / loopback / link-local 命中", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
  });
  it("IPv6 公网不命中", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false); // Google DNS
  });
  it("自定义私网表生效", () => {
    // 198.18.0.0/15 默认不算私网，若把它加入私网表则命中
    expect(isPrivateIp("198.18.0.5", [...PRIVATE_RANGES, "198.18.0.0/15"])).toBe(true);
  });
  it("DEFAULT_ALLOW_RANGES 与 PRIVATE_RANGES 的 127.0.0.1/32 vs /8 边界", () => {
    // /32 是 DEFAULT_ALLOW 的，/8 是 PRIVATE 的——两个 cidr 都能 match 127.0.0.1
    expect(cidrContains("127.0.0.0/8", "127.0.0.1")).toBe(true);
    expect(cidrContains("127.0.0.1/32", "127.0.0.1")).toBe(true);
    // 但 127.0.0.2 只 match /8（私网），不 match /32（allow）→ 这正是 9222 只放 127.0.0.1 的关键
    expect(cidrContains("127.0.0.0/8", "127.0.0.2")).toBe(true);
    expect(cidrContains("127.0.0.1/32", "127.0.0.2")).toBe(false);
  });
  it("DEFAULT_ALLOW_RANGES 常量形状", () => {
    expect(DEFAULT_ALLOW_RANGES).toContain("198.18.0.0/15");
    expect(DEFAULT_ALLOW_RANGES).toContain("127.0.0.1/32");
  });
});
