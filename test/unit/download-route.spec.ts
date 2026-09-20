/**
 * download-route.spec.ts（doc/bugs/12 §四路由表——纯函数表驱动）
 *
 * 守护面：magnet/.torrent→torrent；冻结域名特征表→stream（主站/短链/CDN/
 * 子域/www 前缀）；其余→http；explicit 透传+非法值 fail-closed；引擎映射
 * （http/torrent→aria2c、stream→yt-dlp；降级不在路由层——start.ts 事）。
 */
import { describe, it, expect } from "vitest";
import { routeKind, classifySourceKind, isStreamExtractorHost, STREAM_EXTRACTOR_DOMAINS } from "../../src/download/engines/route.js";

describe("classifySourceKind", () => {
  it.each([
    ["magnet:?xt=urn:btih:abcdef0123456789", "torrent"],
    ["MAGNET:?xt=urn:btih:XYZ", "torrent"], // 大小写不敏感前缀
    ["/Users/x/Downloads/ubuntu-24.04.torrent", "torrent"], // 本地路径
    ["/Users/x/Downloads/ubuntu-24.04.TORRENT", "torrent"], // 后缀大小写
    ["https://example.com/some.torrent", "torrent"], // URL 形态同样命中
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "stream"],
    ["https://youtu.be/dQw4w9WgXcQ", "stream"],
    ["https://m.youtube.com/watch?v=x", "stream"], // m. 子域
    ["https://i.ytimg.com/vi/x/hqdefault.jpg", "stream"], // CDN 域
    ["https://www.bilibili.com/video/BV1xx411c7mD", "stream"],
    ["https://b23.tv/abc123", "stream"], // B 站短链
    ["https://x.com/user/status/123456", "stream"],
    ["https://twitter.com/user/status/123456", "stream"],
    ["https://www.tiktok.com/@user/video/123", "stream"],
    ["https://www.instagram.com/reel/xyz/", "stream"],
    ["https://vimeo.com/123456789", "stream"],
    ["https://www.twitch.tv/videos/123456789", "stream"],
    ["https://soundcloud.com/artist/track", "stream"],
    ["https://v.qq.com/x/cover/m/m00abcdef.html", "stream"],
    ["https://example.com/file.zip", "http"],
    ["https://cdn.example-host.com/video.mp4", "http"], // 相似域不误报
    ["http://192.168.1.1:8080/firmware.bin", "http"],
  ])("%s → %s", (source, expected) => {
    expect(classifySourceKind(source)).toBe(expected);
  });

  it("非 URL 非 .torrent 的裸串归 http（路由层不猜——后续校验报错）", () => {
    expect(classifySourceKind("not a url at all")).toBe("http");
  });

  it("域名特征表冻结 ≥20 域（决议下限）", () => {
    expect(STREAM_EXTRACTOR_DOMAINS.length).toBeGreaterThanOrEqual(20);
  });

  it("evil-youtube.com 不得命中（朴素后缀匹配的伪造面）", () => {
    expect(isStreamExtractorHost("evil-youtube.com")).toBe(false);
    expect(isStreamExtractorHost("youtube.com.evil.io")).toBe(false);
  });
});

describe("routeKind（RouteKindFn 契约）", () => {
  it("explicit=auto 展开", () => {
    expect(routeKind("https://youtu.be/x", "auto")).toEqual({ kind: "stream", engine: "yt-dlp" });
    expect(routeKind("magnet:?xt=urn:btih:x", "auto")).toEqual({ kind: "torrent", engine: "aria2c" });
    expect(routeKind("https://example.com/a.zip", "auto")).toEqual({ kind: "http", engine: "aria2c" });
  });

  it("explicit 非 auto 透传（auto 会被 URL 特征推翻、显式不推翻——用户意志优先）", () => {
    expect(routeKind("https://youtu.be/x", "http")).toEqual({ kind: "http", engine: "aria2c" });
    expect(routeKind("https://example.com/a.zip", "stream")).toEqual({ kind: "stream", engine: "yt-dlp" });
    expect(routeKind("magnet:?xt=urn:btih:x", "http")).toEqual({ kind: "http", engine: "aria2c" });
  });

  it("非法 explicit fail-closed 抛错（zod 之外第二道闸）", () => {
    expect(() => routeKind("https://example.com/a", "ftp" as never)).toThrow(
      /invalid_download_kind/,
    );
  });
});
