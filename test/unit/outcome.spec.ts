/**
 * outcome.ts 单测（parse1 §5.1）
 *
 * 覆盖：outcomeFromHttp 全状态码、isEmptyBody 各形状、
 * outcomeAfterCheck 三态、isFallbackWorthy 排除集。
 */
import { describe, it, expect } from "vitest";
import {
  outcomeFromHttp,
  outcomeAfterCheck,
  isEmptyBody,
  isFallbackWorthy,
} from "../../src/fallback/outcome.js";

// ============================================================
// outcomeFromHttp
// ============================================================
describe("outcomeFromHttp", () => {
  describe("2xx worked / 空 body 升 unknown", () => {
    it("200 + 非空 body → worked", () => {
      expect(outcomeFromHttp(200, { hi: 1 })).toBe("worked");
    });
    it("200 + null body → unknown", () => {
      expect(outcomeFromHttp(200, null)).toBe("unknown");
    });
    it("200 + 空数组 → unknown", () => {
      expect(outcomeFromHttp(200, [])).toBe("unknown");
    });
    it("200 + { results: [] } → unknown（关键：0 结果升级）", () => {
      expect(outcomeFromHttp(200, { results: [] })).toBe("unknown");
    });
    it("200 + { search_results: [] } → unknown", () => {
      expect(outcomeFromHttp(200, { search_results: [] })).toBe("unknown");
    });
    it("200 + { items: [] } → unknown", () => {
      expect(outcomeFromHttp(200, { items: [] })).toBe("unknown");
    });
    it("200 + { results: [1] } → worked", () => {
      expect(outcomeFromHttp(200, { results: [1] })).toBe("worked");
    });
    it("200 + 空字符串 → unknown", () => {
      expect(outcomeFromHttp(200, "")).toBe("unknown");
      expect(outcomeFromHttp(200, "   ")).toBe("unknown");
    });
    it("200 + 空对象 {} → unknown", () => {
      expect(outcomeFromHttp(200, {})).toBe("unknown");
    });
    it("204 No Content → unknown（无 body）", () => {
      expect(outcomeFromHttp(204, null)).toBe("unknown");
    });
  });

  describe("202 Accepted = unknown", () => {
    it("202 + null → unknown", () => {
      expect(outcomeFromHttp(202, null)).toBe("unknown");
    });
    it("202 + 非空 body 仍 → unknown（DDG [browser] 未装场景）", () => {
      expect(outcomeFromHttp(202, { whatever: 1 })).toBe("unknown");
    });
  });

  describe("3xx = unknown（异常重定向）", () => {
    it("302 → unknown", () => {
      expect(outcomeFromHttp(302, null)).toBe("unknown");
    });
    it("301 → unknown", () => {
      expect(outcomeFromHttp(301, {})).toBe("unknown");
    });
  });

  describe("4xx = didnt（非 429）", () => {
    it("400 → didnt", () => {
      expect(outcomeFromHttp(400, null)).toBe("didnt");
    });
    it("401 → didnt", () => {
      expect(outcomeFromHttp(401, null)).toBe("didnt");
    });
    it("403 → didnt", () => {
      expect(outcomeFromHttp(403, null)).toBe("didnt");
    });
    it("404 → didnt（关键：definitive negative）", () => {
      expect(outcomeFromHttp(404, null)).toBe("didnt");
    });
    it("418 → didnt", () => {
      expect(outcomeFromHttp(418, null)).toBe("didnt");
    });
  });

  describe("429 / 5xx = unknown（transient）", () => {
    it("429 → unknown（限流）", () => {
      expect(outcomeFromHttp(429, null)).toBe("unknown");
    });
    it("500 → unknown", () => {
      expect(outcomeFromHttp(500, null)).toBe("unknown");
    });
    it("502 → unknown", () => {
      expect(outcomeFromHttp(502, null)).toBe("unknown");
    });
    it("503 → unknown", () => {
      expect(outcomeFromHttp(503, null)).toBe("unknown");
    });
    it("599 → unknown", () => {
      expect(outcomeFromHttp(599, null)).toBe("unknown");
    });
  });

  describe("其他状态码", () => {
    it("100 信息响应 → unknown", () => {
      expect(outcomeFromHttp(100, null)).toBe("unknown");
    });
    it("199 → unknown", () => {
      expect(outcomeFromHttp(199, null)).toBe("unknown");
    });
  });
});

// ============================================================
// isEmptyBody（直接单测以便回归）
// ============================================================
describe("isEmptyBody", () => {
  it("null / undefined → true", () => {
    expect(isEmptyBody(null)).toBe(true);
    expect(isEmptyBody(undefined)).toBe(true);
  });
  it("空数组 → true", () => {
    expect(isEmptyBody([])).toBe(true);
  });
  it("非空数组 → false", () => {
    expect(isEmptyBody([1, 2])).toBe(false);
  });
  it("空串 / 纯空白 → true", () => {
    expect(isEmptyBody("")).toBe(true);
    expect(isEmptyBody("  ")).toBe(true);
  });
  it("非空字符串 → false", () => {
    expect(isEmptyBody("data")).toBe(false);
  });
  it("{ results: [] } → true", () => {
    expect(isEmptyBody({ results: [] })).toBe(true);
  });
  it("{ search_results: [1] } → false", () => {
    expect(isEmptyBody({ search_results: [1] })).toBe(false);
  });
  it("{} → true", () => {
    expect(isEmptyBody({})).toBe(true);
  });
  it("{ foo: 'bar' } → false", () => {
    expect(isEmptyBody({ foo: "bar" })).toBe(false);
  });
  it("number / boolean → false（非空原值）", () => {
    expect(isEmptyBody(0)).toBe(false);
    expect(isEmptyBody(false)).toBe(false);
  });
});

// ============================================================
// outcomeAfterCheck
// ============================================================
describe("outcomeAfterCheck", () => {
  it("verified=true → worked（无论 pre）", () => {
    expect(outcomeAfterCheck("unknown", true)).toBe("worked");
    expect(outcomeAfterCheck("didnt", true)).toBe("worked");
    expect(outcomeAfterCheck("worked", true)).toBe("worked");
  });
  it("verified=false → didnt", () => {
    expect(outcomeAfterCheck("unknown", false)).toBe("didnt");
    expect(outcomeAfterCheck("worked", false)).toBe("didnt");
  });
  it('verified="preexisting" → 透传 pre（不掠美）', () => {
    expect(outcomeAfterCheck("worked", "preexisting")).toBe("worked");
    expect(outcomeAfterCheck("unknown", "preexisting")).toBe("unknown");
    expect(outcomeAfterCheck("didnt", "preexisting")).toBe("didnt");
  });
});

// ============================================================
// isFallbackWorthy
// ============================================================
describe("isFallbackWorthy", () => {
  describe("worked / didnt → false（不该 fallback）", () => {
    it("worked → false", () => {
      expect(isFallbackWorthy("worked")).toBe(false);
      expect(isFallbackWorthy("worked", "anything")).toBe(false);
    });
    it("didnt → false", () => {
      expect(isFallbackWorthy("didnt")).toBe(false);
      expect(isFallbackWorthy("didnt", "whatever")).toBe(false);
    });
  });

  describe("unknown + 无 error → true（200 空响应值得试 fallback）", () => {
    it("unknown 无 error → true", () => {
      expect(isFallbackWorthy("unknown")).toBe(true);
      expect(isFallbackWorthy("unknown", "")).toBe(true);
    });
  });

  describe("unknown + 排除集 → false（误把信号当故障）", () => {
    it("404 → false", () => {
      expect(isFallbackWorthy("unknown", "HTTP 404 Not Found")).toBe(false);
    });
    it("not_found → false", () => {
      expect(isFallbackWorthy("unknown", "Error: not_found")).toBe(false);
    });
    it("403 → false", () => {
      expect(isFallbackWorthy("unknown", "403 Forbidden")).toBe(false);
    });
    it("forbidden → false", () => {
      expect(isFallbackWorthy("unknown", "forbidden by ACL")).toBe(false);
    });
    it("nxdomain → false", () => {
      expect(isFallbackWorthy("unknown", "ENOTFOUND nxdomain")).toBe(false);
    });
    it("enotfound → false", () => {
      expect(isFallbackWorthy("unknown", "getaddrinfo ENOTFOUND")).toBe(false);
    });
    it("needs_manual_2fa → false（明确需人，不 fallback）", () => {
      expect(isFallbackWorthy("unknown", "NEEDS_MANUAL_2FA")).toBe(false);
    });
    it("大小写不敏感", () => {
      expect(isFallbackWorthy("unknown", "NeedS_Manual_2FA")).toBe(false);
      expect(isFallbackWorthy("unknown", "FORBIDDEN")).toBe(false);
    });
  });

  describe("unknown + transient error → true", () => {
    it("timeout → true", () => {
      expect(isFallbackWorthy("unknown", "request timeout")).toBe(true);
    });
    it("429 → true（虽然 outcomeFromHttp 已把 429 判成 unknown）", () => {
      expect(isFallbackWorthy("unknown", "HTTP 429 Too Many Requests")).toBe(true);
    });
    it("500 → true", () => {
      expect(isFallbackWorthy("unknown", "HTTP 500 Internal Server Error")).toBe(true);
    });
    it("ECONNREFUSED → true", () => {
      expect(isFallbackWorthy("unknown", "connect ECONNREFUSED")).toBe(true);
    });
    it("network 字样 → true", () => {
      expect(isFallbackWorthy("unknown", "network error")).toBe(true);
    });
    it("partial render → true", () => {
      expect(isFallbackWorthy("unknown", "partial render detected")).toBe(true);
    });
  });
});
