/**
 * download-proxy.spec.ts（doc/bugs/12 D11 三级显式解析）+ units 字节/时长原语
 */
import { describe, it, expect } from "vitest";
import { resolveProxy, normalizeProxyUrl, stripProxyEnv } from "../../src/download/engines/proxy.js";
import { parseByteSize, parseSpeedBps, parseEtaToSec, formatSrtTimestamp } from "../../src/download/engines/units.js";

describe("resolveProxy（D11 三级）", () => {
  const E = (o: Record<string, string>): NodeJS.ProcessEnv => ({ ...o });

  it("explicit=off → null（即便 env 有代理配置）", () => {
    expect(resolveProxy("off", E({ HTTPS_PROXY: "http://10.0.0.1:7890" }))).toBeNull();
  });

  it("explicit 显式串透传+归一（裸 host:port 补 http://）", () => {
    expect(resolveProxy("127.0.0.1:7890", E({}))).toBe("http://127.0.0.1:7890");
    expect(resolveProxy("http://127.0.0.1:7890", E({}))).toBe("http://127.0.0.1:7890");
    expect(resolveProxy("socks5://127.0.0.1:1080", E({}))).toBe("socks5://127.0.0.1:1080");
  });

  it("auto：LASSO_PROXY 最优先", () => {
    expect(
      resolveProxy("auto", E({ LASSO_PROXY: "http://a:1", HTTPS_PROXY: "http://b:2" })),
    ).toBe("http://a:1");
  });

  it("auto：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy > null", () => {
    expect(resolveProxy("auto", E({ HTTPS_PROXY: "http://b:2", https_proxy: "http://c:3", HTTP_PROXY: "http://d:4" }))).toBe("http://b:2");
    expect(resolveProxy("auto", E({ https_proxy: "http://c:3", HTTP_PROXY: "http://d:4" }))).toBe("http://c:3");
    expect(resolveProxy("auto", E({ HTTP_PROXY: "http://d:4", http_proxy: "http://e:5" }))).toBe("http://d:4");
    expect(resolveProxy("auto", E({ http_proxy: "http://e:5" }))).toBe("http://e:5");
    expect(resolveProxy("auto", E({}))).toBeNull();
    expect(resolveProxy(undefined, E({}))).toBeNull();
  });

  it("normalize：空/空白/非法 → null；URL 规范化（默认端口折叠+尾斜杠剥除）", () => {
    expect(normalizeProxyUrl("")).toBeNull();
    expect(normalizeProxyUrl("   ")).toBeNull();
    // URL 规范化：:80 是 http 默认端口被 whatwg 折叠——产物仍可被
    // ProxyAgent/aria2/yt-dlp 三消费方解析，锁规范形态防漂移
    expect(normalizeProxyUrl("http://h:80/")).toBe("http://h");
    expect(normalizeProxyUrl("http://127.0.0.1:7890/")).toBe("http://127.0.0.1:7890");
  });

  it("stripProxyEnv：resolved=null 时剥六键（aria2/yt-dlp env 拾取面封死）", () => {
    const stripped = stripProxyEnv(
      E({
        http_proxy: "a",
        https_proxy: "b",
        HTTP_PROXY: "c",
        HTTPS_PROXY: "d",
        all_proxy: "e",
        ALL_PROXY: "f",
        PATH: "/usr/bin",
        HOME: "/Users/x",
      }),
    );
    expect(Object.keys(stripped).sort()).toEqual(["HOME", "PATH"]);
  });
});

describe("units（字节/速度/ETA/SRT 时间戳）", () => {
  it("parseByteSize：aria2 单位族", () => {
    expect(parseByteSize("0B")).toBe(0);
    expect(parseByteSize("100B")).toBe(100);
    expect(parseByteSize("31MiB")).toBe(31 * 1024 * 1024);
    expect(parseByteSize("1.1MiB")).toBe(Math.round(1.1 * 1024 * 1024));
    expect(parseByteSize("2KiB")).toBe(2048);
    expect(parseByteSize("1GiB")).toBe(1024 ** 3);
    expect(parseByteSize("Unknown")).toBeNull();
    expect(parseByteSize("NA")).toBeNull();
    expect(parseByteSize("")).toBeNull();
  });

  it("parseSpeedBps：yt-dlp /s 后缀 + Unknown；0B/s=真实零速（BT 诊断信号）", () => {
    expect(parseSpeedBps("2.5MiB/s")).toBe(Math.round(2.5 * 1024 * 1024));
    expect(parseSpeedBps("1B/s")).toBe(1);
    expect(parseSpeedBps("Unknown B/s")).toBeNull();
    expect(parseSpeedBps("Unknown")).toBeNull();
    expect(parseSpeedBps("0B/s")).toBe(0);
  });

  it("parseEtaToSec：两族形态", () => {
    expect(parseEtaToSec("30s")).toBe(30);
    expect(parseEtaToSec("1m30s")).toBe(90);
    expect(parseEtaToSec("1h2m3s")).toBe(3723);
    expect(parseEtaToSec("00:30")).toBe(30);
    expect(parseEtaToSec("01:00:30")).toBe(3630);
    expect(parseEtaToSec("unknown")).toBeNull();
    expect(parseEtaToSec("Unknown")).toBeNull();
    expect(parseEtaToSec("--:--:--")).toBeNull();
    expect(parseEtaToSec("NA")).toBeNull();
    expect(parseEtaToSec("42")).toBe(42); // 裸秒数容错
  });

  it("formatSrtTimestamp", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(1500)).toBe("00:00:01,500");
    expect(formatSrtTimestamp(3_661_500)).toBe("01:01:01,500");
  });
});
