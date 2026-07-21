/**
 * content-type-router 单测（parse6 §5.5 v0.5 M0.5a，10+ cases）
 *
 * 守护 routeContentType 的 4 路分流（html / json / text / binary）。
 * 测试策略：纯函数无副作用，直接表驱动。
 */
import { describe, it, expect } from "vitest";
import { routeContentType } from "../../src/browse/content-type-router.js";

describe("routeContentType — html 分流", () => {
  it("text/html → html", () => {
    expect(routeContentType("text/html")).toEqual({ kind: "html" });
  });

  it("text/html; charset=utf-8 → html（charset 不影响）", () => {
    expect(routeContentType("text/html; charset=utf-8")).toEqual({ kind: "html" });
  });

  it("application/xhtml+xml → html", () => {
    expect(routeContentType("application/xhtml+xml")).toEqual({ kind: "html" });
  });
});

describe("routeContentType — json 分流", () => {
  it("application/json → json", () => {
    expect(routeContentType("application/json")).toEqual({ kind: "json" });
  });

  it("application/json; charset=utf-8 → json（charset 不影响）", () => {
    expect(routeContentType("application/json; charset=utf-8")).toEqual({
      kind: "json",
    });
  });

  it("application/vnd.api+json → json（+json 后缀）", () => {
    expect(routeContentType("application/vnd.api+json")).toEqual({
      kind: "json",
    });
  });

  it("application/hal+json → json（HAL 媒体类型）", () => {
    expect(routeContentType("application/hal+json")).toEqual({ kind: "json" });
  });
});

describe("routeContentType — text 分流", () => {
  it("text/plain → text", () => {
    expect(routeContentType("text/plain")).toEqual({ kind: "text" });
  });

  it("text/css → text", () => {
    expect(routeContentType("text/css")).toEqual({ kind: "text" });
  });

  it("text/csv → text", () => {
    expect(routeContentType("text/csv")).toEqual({ kind: "text" });
  });

  it("text/xml → text", () => {
    expect(routeContentType("text/xml")).toEqual({ kind: "text" });
  });

  it("application/xml → text", () => {
    expect(routeContentType("application/xml")).toEqual({ kind: "text" });
  });

  it("application/javascript → text", () => {
    expect(routeContentType("application/javascript")).toEqual({ kind: "text" });
  });

  it("application/x-www-form-urlencoded → text", () => {
    expect(routeContentType("application/x-www-form-urlencoded")).toEqual({
      kind: "text",
    });
  });
});

describe("routeContentType — binary 分流", () => {
  it("image/png → binary:png", () => {
    expect(routeContentType("image/png")).toEqual({
      kind: "binary",
      subtype: "png",
    });
  });

  it("image/jpeg → binary:jpeg", () => {
    expect(routeContentType("image/jpeg")).toEqual({
      kind: "binary",
      subtype: "jpeg",
    });
  });

  it("application/pdf → binary:pdf", () => {
    expect(routeContentType("application/pdf")).toEqual({
      kind: "binary",
      subtype: "pdf",
    });
  });

  it("application/octet-stream → binary:octet-stream", () => {
    expect(routeContentType("application/octet-stream")).toEqual({
      kind: "binary",
      subtype: "octet-stream",
    });
  });

  it("video/mp4 → binary:mp4", () => {
    expect(routeContentType("video/mp4")).toEqual({
      kind: "binary",
      subtype: "mp4",
    });
  });

  it("font/woff2 → binary:woff2", () => {
    expect(routeContentType("font/woff2")).toEqual({
      kind: "binary",
      subtype: "woff2",
    });
  });

  it("application/zip → binary:zip", () => {
    expect(routeContentType("application/zip")).toEqual({
      kind: "binary",
      subtype: "zip",
    });
  });
});

describe("routeContentType — 边界", () => {
  it("空串 → binary:octet-stream（默认）", () => {
    expect(routeContentType("")).toEqual({
      kind: "binary",
      subtype: "octet-stream",
    });
  });

  it("null → binary:octet-stream", () => {
    expect(routeContentType(null)).toEqual({
      kind: "binary",
      subtype: "octet-stream",
    });
  });

  it("undefined → binary:octet-stream", () => {
    expect(routeContentType(undefined)).toEqual({
      kind: "binary",
      subtype: "octet-stream",
    });
  });

  it("大写 content-type 不敏感（自动小写）", () => {
    expect(routeContentType("TEXT/HTML")).toEqual({ kind: "html" });
    expect(routeContentType("Application/JSON")).toEqual({ kind: "json" });
  });

  it("未知主类型 → binary:<subtype>", () => {
    expect(routeContentType("application/vnd.custom")).toEqual({
      kind: "binary",
      subtype: "vnd.custom",
    });
  });
});
