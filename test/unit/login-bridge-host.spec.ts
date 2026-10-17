/**
 * login-bridge-host.spec.ts（v1.31 F4——方案 §六-3）
 *
 * 1. tailscale CGNAT 段判定与 stdout 解析（纯函数）
 * 2. 私网 IPv4 判定
 * 3. resolveBridgeHost 三序：env 显式（含 0.0.0.0=多 origins）/ tailscale /
 *    interface 兜底 / 全 miss null
 * 4. INV 红线行为面：非 env 路径永不产 0.0.0.0
 */
import { describe, it, expect } from "vitest";
import {
  isTailscaleCgnatIPv4,
  parseTailscaleIps,
  isPrivateIPv4,
  resolveBridgeHost,
} from "../../src/login-bridge/host.js";

describe("纯函数：CGNAT/私网判定", () => {
  it("100.64.0.0/10 段：100.64-127.x ✓；100.0/100.128+/101+ ✗", () => {
    expect(isTailscaleCgnatIPv4("100.64.1.2")).toBe(true);
    expect(isTailscaleCgnatIPv4("100.127.255.254")).toBe(true);
    expect(isTailscaleCgnatIPv4("100.63.1.2")).toBe(false);
    expect(isTailscaleCgnatIPv4("100.128.0.1")).toBe(false);
    expect(isTailscaleCgnatIPv4("101.1.1.1")).toBe(false);
    expect(isTailscaleCgnatIPv4("not-an-ip")).toBe(false);
  });
  it("parseTailscaleIps：多行取 CGNAT 段（噪声行/空行容忍）", () => {
    const out = parseTailscaleIps("100.120.87.40\n\n192.168.1.5\n100.64.0.1\n");
    expect(out).toEqual(["100.120.87.40", "100.64.0.1"]);
  });
  it("isPrivateIPv4：10/8、172.16/12、192.168/16 ✓；公网/loopback ✗", () => {
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("172.31.255.254")).toBe(true);
    expect(isPrivateIPv4("192.168.1.1")).toBe(true);
    expect(isPrivateIPv4("172.32.0.1")).toBe(false);
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("127.0.0.1")).toBe(false);
  });
});

describe("resolveBridgeHost 三序", () => {
  const ifaces = () => ({
    lo0: [{ family: "IPv4", address: "127.0.0.1", mac: "", internal: true, cidr: "", netmask: "", scopeid: 0 }] as never[],
    en0: [{ family: "IPv4", address: "192.168.1.5", mac: "", internal: false, cidr: "", netmask: "", scopeid: 0 }] as never[],
    en1: [{ family: "IPv4", address: "10.0.0.9", mac: "", internal: false, cidr: "", netmask: "", scopeid: 0 }] as never[],
  });
  const noTs = () => ({ status: 1, stdout: "" });

  it("env 显式优先（source=env；IP 字面量直用）", () => {
    const r = resolveBridgeHost({
      relayPort: 9226,
      env: { LASSO_LOGIN_BRIDGE_HOST: "100.120.87.40" },
      runFn: noTs,
      interfacesFn: ifaces,
    });
    expect(r).toMatchObject({ host: "100.120.87.40", source: "env", origin: "http://100.120.87.40:9226" });
    expect(r!.allowOrigins).toEqual(["http://100.120.87.40:9226"]);
  });

  it("env=0.0.0.0 合法化但 allowOrigins 枚举全部私网接口（用户自担形态）", () => {
    const r = resolveBridgeHost({
      relayPort: 9226,
      env: { LASSO_LOGIN_BRIDGE_HOST: "0.0.0.0" },
      runFn: noTs,
      interfacesFn: ifaces,
    });
    expect(r).toMatchObject({ host: "0.0.0.0", source: "env" });
    // 接口名排序后 en0(192.168.1.5) < en1(10.0.0.9)；loopback 不进（127 非私网段）
    expect(r!.allowOrigins).toEqual(["http://192.168.1.5:9226", "http://10.0.0.9:9226"]);
  });

  it("tailscale CLI 成功 → CGNAT 首个 IP（source=tailscale）", () => {
    const r = resolveBridgeHost({
      relayPort: 9226,
      env: {},
      runFn: (_cmd, args) => (args[0] === "ip" ? { status: 0, stdout: "100.120.87.40\n" } : { status: 1, stdout: "" }),
      interfacesFn: ifaces,
    });
    expect(r).toMatchObject({ host: "100.120.87.40", source: "tailscale" });
  });

  it("tailscale 失败 → interface 兜底（source=interface 如实标注，不冒充）", () => {
    const r = resolveBridgeHost({
      relayPort: 9226,
      env: {},
      runFn: noTs,
      interfacesFn: ifaces,
    });
    expect(r).toMatchObject({ host: "192.168.1.5", source: "interface" });
  });

  it("全 miss → null（调用方给可教学错误）", () => {
    const r = resolveBridgeHost({
      relayPort: 9226,
      env: {},
      runFn: noTs,
      interfacesFn: () => ({}),
    });
    expect(r).toBeNull();
  });

  it("INV：tailscale/interface 路径永不产 0.0.0.0（仅 env 显式可）", () => {
    const r = resolveBridgeHost({
      relayPort: 9226,
      env: {},
      runFn: () => ({ status: 0, stdout: "100.64.0.1\n" }),
      interfacesFn: ifaces,
    });
    expect(r!.host).not.toBe("0.0.0.0");
    const r2 = resolveBridgeHost({ relayPort: 9226, env: {}, runFn: noTs, interfacesFn: ifaces });
    expect(r2!.host).not.toBe("0.0.0.0");
  });
});
