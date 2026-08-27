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
 *      · needs_manual_2fa
 *  - 其他 unknown + error → true（transient：timeout / 429 / 5xx / DNS / ECONNREFUSED / network）
 *
 * v1.18.2（doc/governance/10 Y2）：nxdomain / enotfound 移出排除集——DNS 错在代理/TUN
 * 环境高频瞬态（fake-ip 拦截、断网恢复期），且下一 channel（真实 Chrome 走
 * 系统栈/DoH，解析路径不同）可能成功；DNS 失败 ≠ 页面语义否定。
 */
const NOT_FALLBACK_WORTHY_PATTERNS = [
  "404",
  "not_found",
  "403",
  "forbidden",
  "needs_manual_2fa",
] as const;

export function isFallbackWorthy(outcome: Outcome, error?: string): boolean {
  if (outcome === "worked" || outcome === "didnt") return false;
  // outcome === "unknown"
  if (!error) return true;
  const msg = error.toLowerCase();
  return !NOT_FALLBACK_WORTHY_PATTERNS.some((pat) => msg.includes(pat));
}

// ============================================================
// v1.18.2（doc/governance/10 F2）：长熔断喂入分类 —— 持续故障类 vs 环境瞬态类
// ============================================================
/**
 * 判定一条失败 error 是否「持续故障类」（sustained）——只有这类才喂 LongCircuitBreaker。
 *
 * 设计反转背景（doc/governance/10 F2）：长熔断文件头自述的部署想象是「月配额耗尽类持续故障」，
 * 但 recordFailure 从不看成因，实际捕获的是用户自己的断网（TUN 断 10 分钟 = 10 次
 * unknown within 1h → 60min disable + 杀子进程 + 手工恢复）。错配子型②。
 *
 * 分类原则（白名单，宁缺勿滥）：
 *  - 429 / rate limit / quota / billing / credit —— provider 配额与账户态（真持续）
 *  - api key / unauthorized / authentication —— 凭据失效（人须修配置，真持续）
 *  - upstream_unsupported —— 锁定上游版本缺工具（确定性不兼容，真持续）
 *  - 其余（DNS/timeout/ECONNREFUSED/空响应/裸 unknown…）—— 环境瞬态，只归
 *    60s 短熔断管（自愈快），**永不**进长熔断。
 *
 * error=undefined/null → true（无信号按持续计，保持既有 no-arg recordFailure
 * 调用方与单测语义不变；decider 侧总会传 error 字符串）。
 */
const SUSTAINED_FAILURE_PATTERNS = [
  "429",
  "rate_limit",
  "rate limit",
  "ratelimit",
  "too many requests",
  "quota",
  "billing",
  "credit",
  "api_key",
  "apikey",
  "api key",
  "unauthorized",
  "invalid_token",
  "authentication",
  "upstream_unsupported",
] as const;

export function isSustainedFailureError(error?: string | null): boolean {
  if (error == null) return true;
  const msg = error.toLowerCase();
  return SUSTAINED_FAILURE_PATTERNS.some((pat) => msg.includes(pat));
}
