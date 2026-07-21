/**
 * tri-state outcome 工具（parse1 §3.8 + §4.4 + 10 §D.1 + 12 F.1）
 *
 * 三态语义：
 *  - worked  : 语义成功（已验证交付，有数据）
 *  - didnt   : 语义否定（404 / 403 / NXDOMAIN / NEEDS_MANUAL_2FA 等明确"否"）
 *  - unknown : 不确定（限流 / 超时 / 5xx / 空响应 / 网络错）→ fallback 引擎的真正触发器
 *
 * 关键扩展（10 §D.1）：二元 bool 把 "200 但 0 结果" 这个关键信号丢了——
 * outcomeFromHttp 必须把这个场景判成 unknown 而非 worked。
 */
import type { Outcome } from "../types.js";

// ============================================================
// HTTP 状态 → Outcome
// ============================================================
/**
 * HTTP 响应状态码 + body → Outcome（10 §D.1 isFallbackWorthy 扩展集）。
 *
 *  - 202 + 任意 body     → unknown（Accepted but empty；DDG [browser] 未装场景）
 *  - 429 / ≥500          → unknown（transient：限流 / 服务器错）
 *  - 2xx + 空 body       → unknown（200 但 0 结果是关键信号）
 *  - 2xx + 非空 body     → worked
 *  - 3xx                 → unknown（重定向处理失败 / 上游异常）
 *  - 4xx（非 429）       → didnt（definitive negative）
 *  - 其他 < 200          → unknown（信息响应，不正常）
 */
export function outcomeFromHttp(status: number, body: unknown): Outcome {
  if (status === 202) return "unknown";
  if (status === 429 || status >= 500) return "unknown";
  if (status >= 200 && status < 300) {
    return isEmptyBody(body) ? "unknown" : "worked";
  }
  if (status >= 300 && status < 400) return "unknown";
  if (status >= 400 && status < 500) return "didnt";
  return "unknown";
}

// ============================================================
// 空 body 判定
// ============================================================
/**
 * 判定 body 是否"语义空"——触发 200→unknown 升级。
 * 识别三种常见形状：
 *  - null / undefined            → 空
 *  - 空数组 / 空字符串            → 空
 *  - { search_results|results|items: [] } → 空（search / list 响应）
 *  - 其他非空对象                 → 非空
 */
export function isEmptyBody(body: unknown): boolean {
  if (body == null) return true;
  if (typeof body === "string") return body.trim() === "";
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const arr = obj.search_results ?? obj.results ?? obj.items;
    if (Array.isArray(arr)) return arr.length === 0;
    // 空对象 {} 也算空
    return Object.keys(obj).length === 0;
  }
  return false;
}

// ============================================================
// expect 后置条件 tri-state（12 F.1，v0.1 仅类型，v0.3 实装）
// ============================================================
/**
 * 把 channel 自报的 outcome 用 expect 后置条件结果重判。
 *
 *  - verified === true           → worked（验证通过）
 *  - verified === "preexisting"  → pre（不掠美：承认 channel 没造成它但成立）
 *  - verified === false          → didnt（条件未达成）
 */
export function outcomeAfterCheck(
  pre: Outcome,
  verified: boolean | "preexisting",
): Outcome {
  if (verified === true) return "worked";
  if (verified === "preexisting") return pre;
  return "didnt";
}

// ============================================================
// isFallbackWorthy（parse1 §3.9 + §4.4）
// ============================================================
/**
 * 判定一个 unknown 结果是否"值得"触发 fallback。
 *
 * 不是所有 unknown 都该 fallback——有些 unknown 其实是 channel
 * 给出的明确"需要人介入"信号（如 NEEDS_MANUAL_2FA），fallback 到下一个
 * channel 也不会变好，反而会绕开这个关键信号。把这些误当故障处理会
 * 把信号当噪声（12 F.1 明确警告）。
 *
 * 规则：
 *  - worked / didnt → 永远 false（这两态都是 definitive，不该 fallback）
 *  - unknown + 无 error → true（200 空响应 / 202 等，值得试下一个 channel）
 *  - unknown + error 命中排除集 → false（明确"否"信号被误报成 unknown）
 *      · 404 / not_found
 *      · 403 / forbidden
 *      · nxdomain / enotfound
 *      · needs_manual_2fa
 *  - 其他 unknown + error → true（transient：timeout / 429 / 5xx / ECONNREFUSED / network）
 */
const NOT_FALLBACK_WORTHY_PATTERNS = [
  "404",
  "not_found",
  "403",
  "forbidden",
  "nxdomain",
  "enotfound",
  "needs_manual_2fa",
] as const;

export function isFallbackWorthy(outcome: Outcome, error?: string): boolean {
  if (outcome === "worked" || outcome === "didnt") return false;
  // outcome === "unknown"
  if (!error) return true;
  const msg = error.toLowerCase();
  return !NOT_FALLBACK_WORTHY_PATTERNS.some((pat) => msg.includes(pat));
}
