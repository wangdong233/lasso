/**
 * upstream-wedge.ts（BUG-04 决议 B，doc/bugs/04 §5，2026-09-08）
 *
 * 上游 chrome-devtools-mcp@1.7.0「选中页死锁」签名单一真源。
 *
 * 根因（npm tarball 逐行复核，doc/bugs/04 §2）：上游 ToolHandler.js 的
 * `const targetPage = page ?? context.getSelectedMcpPage()`（:189）无条件执行——
 * 选中页被关（用户手关 / 页面 window.close / 会话收尾关自建 tab）后，**任何**
 * 工具调用（含 list_pages 自身）都在此处 throw 落入外层 catch，绕过唯一自愈点
 * `createPagesSnapshot()`——通道级死锁，MCP 进程重启才解。
 *
 * 本模块只放签名常量 + 判定函数（零依赖叶子，BrowseChannel / TabRegistry /
 * LoggedInChannel 三方共用——签名定义不允许第二处漂移）。
 *
 * INV-89 机械锚。
 */

/**
 * 上游 McpContext.getSelectedMcpPage() 的整串错误子串（build/src/McpContext.js:253）：
 *   `The selected page has been closed. Call list_pages to see open pages.`
 *
 * 窄匹配（只用前半句）防误伤：页面正文/标题正常场景不会以这个精确短语出现；
 * 若未来页面内容真含此串，被动检测面（错误文本）不受影响——只有主动
 * reconcile 面（list_pages 全响应）可能命中，而该响应在健康通道上恒为页列表。
 */
export const UPSTREAM_WEDGE_SIGNATURE = /The selected page has been closed/;

/** 判定错误/响应文本是否上游选中页死锁签名。 */
export function isUpstreamWedgeError(text: string): boolean {
  return UPSTREAM_WEDGE_SIGNATURE.test(text);
}

/**
 * reconcile 类型化信号前缀（doc/bugs/04 §5 主动接入点）：
 * `TabRegistry.reconcile` 命中签名 → throw `upstream_wedge:<原文摘录>`；
 * LoggedInChannel.getMcpClient 捕获该前缀 → 返回 client 前触发 heal。
 */
export const UPSTREAM_WEDGE_SIGNAL_PREFIX = "upstream_wedge:";

/** 判定是否 reconcile 抛出的类型化楔死信号（区别于普通 reconcile 失败）。 */
export function isUpstreamWedgeTypedSignal(msg: string): boolean {
  return msg.startsWith(UPSTREAM_WEDGE_SIGNAL_PREFIX);
}
