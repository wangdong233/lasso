/**
 * Lasso v0.3 expect 后置条件（parse3 §3.2，F3.2.18）
 *
 * 架构铁律（08 §0 原则 5 / INV-13）：event delivery alone is never treated as
 * semantic success. expect failed → 调用方（StepEngine）必须强制 outcome=didnt
 * 并终止 chain。
 *
 * 三态返回：
 *  - verified    : poll 期间条件满足（gone=true 时即条件消失）
 *  - preexisting : preSnapshot 显示动作前条件已满足（保留原 outcome，12 §1.1B
 *                  「承认我没造成它但它现在对」）
 *  - failed      : 超时仍未满足 → 调用方强制 outcome=didnt
 *
 * 借鉴源（12 §1.1B 源码级）：
 *  - injaneity src/bridge.ts performBrowserTransaction:
 *      deadline = Date.now() + timeoutMs;
 *      do { snap = cdpSnapshotForContext();
 *           present = outlineConditionPresent(restoreOutline(snap.outline), cond);
 *           satisfied = present !== cond.gone;
 *           if (!satisfied) await sleep(100);
 *      } while (!satisfied && Date.now() < deadline);
 *  - injaneity src/actions.ts outcomeAfterCheck:
 *      verified → outcome=worked
 *      failed   → outcome=didnt
 *      preexisting → 保留原 outcome
 *  - injaneity src/contract.ts UiCondition:
 *      {ref?, scopeRef?, text?, role?, value?, until:'present'|'absent', timeoutMs?}
 *      validateCondition 强制 text/role/value 至少一项 → 我们 cond 至少
 *      text/selector/url_contains 之一
 *
 * 决策（parse3 §4.2）：走 evaluate_script 100ms poll，不依赖 CDP 原生事件回调
 * （Lasso 通过 chrome-devtools-mcp 工具层调用，拿不到 CDP 原生事件）。
 */
import type { ExpectCondition } from "../types.js";
import type { McpClient } from "../subprocess/McpClient.js";

// ============================================================
// 公共类型
// ============================================================
/** expect poll 的三态判定（parse3 §3.2）。 */
export type ExpectVerdict = "verified" | "preexisting" | "failed";

/**
 * 条件快照：act 前由 BrowseChannel.quickSnapshot() 抓取，用于 preexisting 判定。
 * 字段按需填充 —— 缺失字段在 conditionHolds 中按 false 处理（保守）。
 */
export interface ConditionSnapshot {
  /** window.location.href at snapshot time */
  url?: string;
  /** document.body.innerText at snapshot time（可截断到合理长度） */
  body_text?: string;
  /** 预计算好的 selector 命中表（key=selector 表达式，value=是否匹配） */
  selector_hits?: Record<string, boolean>;
  /** Date.now() at capture */
  captured_at?: number;
}

/** expectPoll 可选项（测试 / 调参用）。 */
export interface ExpectPollOptions {
  /** poll 间隔，默认 100ms（直抄 injaneity bridge.ts） */
  pollIntervalMs?: number;
  /** 默认 timeout，仅当 cond.timeout_ms 缺省时启用，默认 5000ms */
  defaultTimeoutMs?: number;
}

// ============================================================
// 常量
// ============================================================
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5000;

// ============================================================
// 核心 API
// ============================================================
/**
 * 100ms poll 等待条件成立。返回三态 verified/preexisting/failed。
 *
 * 流程（parse3 §3.2）：
 *  1. validateCondition（强制 text/selector/url_contains 至少一项）
 *  2. preSnapshot 预检 → preexisting 短路（仅当相关字段齐全时启用）
 *  3. 100ms poll 循环（gone=true 时反向语义）
 *  4. deadline 内未满足 → failed
 *
 * @throws cond 缺 text/selector/url_contains 时抛错（contract validateCondition）
 */
export async function expectPoll(
  client: McpClient,
  cond: ExpectCondition,
  preSnapshot?: ConditionSnapshot,
  opts?: ExpectPollOptions,
): Promise<ExpectVerdict> {
  validateCondition(cond);

  // 2. preexisting 预检（仅当 preSnapshot 提供且包含相关字段时）
  if (preSnapshot && isPreexisting(preSnapshot, cond)) {
    return "preexisting";
  }

  // 3. 100ms poll 循环
  const interval = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeout = cond.timeout_ms ?? opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(interval);
    const current = await snapshotCondition(client, cond);
    const satisfied = cond.gone ? !current.holds : current.holds;
    if (satisfied) return "verified";
  }
  return "failed";
}

// ============================================================
// validateCondition（contract.ts validateCondition 对应）
// ============================================================
/**
 * 强制 cond 至少含 text/selector/url_contains 之一。
 * 对应 injaneity contract.ts validateCondition「text/role/value 至少一项」。
 */
export function validateCondition(cond: ExpectCondition): void {
  if (!cond.text && !cond.selector && !cond.url_contains) {
    throw new Error(
      "expect: at least one of text/selector/url_contains required",
    );
  }
}

// ============================================================
// conditionHolds（纯函数：在 snapshot 上判定 cond 是否"present"）
// ============================================================
/**
 * 在给定 snapshot 上判定 cond 是否「成立」（present）。
 *  - OR 语义：多个字段任一命中即 true
 *  - snapshot 缺字段 → 该字段按 false（保守）
 *  - 不考虑 cond.gone（caller 自行处理反向语义）
 */
export function conditionHolds(
  snap: ConditionSnapshot,
  cond: ExpectCondition,
): boolean {
  if (cond.url_contains && (snap.url?.includes(cond.url_contains) ?? false)) {
    return true;
  }
  if (cond.text && (snap.body_text?.includes(cond.text) ?? false)) {
    return true;
  }
  if (cond.selector && (snap.selector_hits?.[cond.selector] ?? false)) {
    return true;
  }
  return false;
}

/**
 * 判定 preexisting：act 前是否已处于 desired state。
 *  - cond.gone=false : desired=present，preexisting = wasPresent
 *  - cond.gone=true  : desired=absent，preexisting = !wasPresent
 *
 * 安全边界：若 snapshot 缺相关字段（无法判定）→ 返回 false（不假设 preexisting）。
 */
export function isPreexisting(
  pre: ConditionSnapshot,
  cond: ExpectCondition,
): boolean {
  // 相关字段齐全性检查：缺任一相关字段 → 无法确信 → 不判 preexisting
  const hasUrl = cond.url_contains ? pre.url !== undefined : true;
  const hasText = cond.text ? pre.body_text !== undefined : true;
  const hasSel = cond.selector ? pre.selector_hits !== undefined : true;
  if (!hasUrl || !hasText || !hasSel) return false;

  const present = conditionHolds(pre, cond);
  return cond.gone ? !present : present;
}

// ============================================================
// snapshotCondition：跑一次 evaluate_script 检查当前页面是否满足条件
// ============================================================
/**
 * 走 evaluate_script 跑一次条件检查，避免 take_snapshot 全量开销。
 * 返回 { holds }：当前页面是否「present」（不考虑 gone）。
 *
 * 若 client.callTool 抛错（页面未就绪 / evaluate_script 不可用）：
 *  - 视为本次 holds=false（继续 poll，最终可能 failed）
 */
async function snapshotCondition(
  client: McpClient,
  cond: ExpectCondition,
): Promise<{ holds: boolean }> {
  const expr = buildConditionExpr(cond);
  try {
    const r = (await client.callTool("evaluate_script", {
      function: expr,
    })) as ContentResult;
    const text = firstText(r);
    return { holds: text === "true" };
  } catch {
    return { holds: false };
  }
}

/**
 * 构造 evaluate_script 用的 JS 表达式：返回 "true"/"false" 字符串。
 * 三条件 OR（任一命中即 holds=true）。
 * 导出供测试 / BrowseChannel.quickSnapshot 复用。
 */
export function buildConditionExpr(cond: ExpectCondition): string {
  const clauses: string[] = [];
  if (cond.url_contains) {
    clauses.push(
      `(window.location.href.indexOf(${JSON.stringify(cond.url_contains)}) !== -1)`,
    );
  }
  if (cond.selector) {
    clauses.push(`(!!document.querySelector(${JSON.stringify(cond.selector)}))`);
  }
  if (cond.text) {
    clauses.push(
      `((document.body && document.body.innerText || "").indexOf(${JSON.stringify(cond.text)}) !== -1)`,
    );
  }
  const expr = clauses.length > 0 ? clauses.join(" || ") : "false";
  return `(function(){ return (${expr}).toString(); })()`;
}

// ============================================================
// 内部 helper
// ============================================================
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// SDK 返回结构解析（与 BrowseChannel 内部解析同构；Phase C 再 DRY 到 util）
type TextBlock = { type: "text"; text?: string };
type ContentResult = { content?: TextBlock[]; isError?: boolean };

function firstText(r: ContentResult | undefined): string | undefined {
  if (!r?.content) return undefined;
  for (const b of r.content) {
    if (b.type === "text" && b.text) return b.text;
  }
  return undefined;
}
