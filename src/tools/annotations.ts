/**
 * MCP ToolAnnotations 注册表（parse1 §3.12 + F3.3.13）
 *
 * 不变量 INV-5：每个 server.tool 注册必须携带 annotations，至少含 readOnlyHint
 * 和 openWorldHint。这是 MCP 客户端（CC）做权限提示、UI 分组、自动批准决策的
 * 关键元数据——漏写会让客户端退化到「都问一次」的最保守策略。
 *
 * 四象限（按 Lasso v0.3.5 工具映射）：
 *
 *   |  tool             | readOnly | openWorld | 含义                                |
 *   |  ---------------- | -------- | --------- | ----------------------------------- |
 *   |  search           |   true   |   true    | 只读不副作用；触外网；世界开放      |
 *   |  browse_headless  |   false  |   true    | 可点击/填表（副作用）；触外网        |
 *   |  browse_logged_in |   false  |   true    | 可副作用 + 用你的登录态；触外网      |
 *   |  desktop          |   false  |   false   | 可 click/type（副作用）；本机非外网   |
 *   |  doctor           |   true   |   false   | 只读自检；不触外网（部分探测例外）   |
 *   |  fetch_url (v0.5) |   true   |   true    | 只读 GET/HEAD；触外网（parse6 §1.4） |
 *   |  screenshot(v0.5) |   true   |   true    | 只读截图；触外网（parse6 §3.2）      |
 *   |  pdf      (v0.5) |   true   |   true    | 只读生成 PDF；触外网（parse6 §3.3）   |
 *   |  network  (v0.5) |   true   |   true    | 只读抓资源列表；触外网（parse6 §3.4） |
 *
 * 关键：browse_headless/browse_logged_in 的 readOnly=false 是因为它们的
 * click/fill/evaluate action 能改变页面状态（甚至触发后端写入），不能等价于
 * read-only 检索。即使 v0.1 大多数调用是 snapshot，annotations 按**能力上限**
 * 标注，让 CC 给出 permission 提示而不是直接自动批准。
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const searchAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

export const browseHeadlessAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  openWorldHint: true,
};

export const browseLoggedInAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  openWorldHint: true,
};

export const doctorAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

/**
 * desktop tool annotations（parse4 §3.3.2，v0.3.5 新增）。
 *
 * 四象限归属：
 *   |  tool     | readOnly | openWorld | 含义                                |
 *   |  -------- | -------- | --------- | ----------------------------------- |
 *   |  desktop  |   false  |   false   | 可 click/type/press（副作用）；本机非外网 |
 *
 * - readOnlyHint=false：act 能 click / type / press / hotkey / scroll，
 *   可改变 native app 状态（finder 重命名、mail 发邮件、system settings 切 WiFi）。
 *   即使 v0.3.5 大多数调用是 snapshot，annotations 按能力上限标注，让 CC
 *   给出 permission 提示而不是自动批准。
 * - openWorldHint=false：操作本机 macOS 应用，非"开放外网"。helper 经
 *   stdin/stdout JSON-lines 与 Lasso 通信，所有 AXAPI 调用都在本机进程边界内。
 */
export const desktopAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
};

/**
 * interact_* tools annotations（parse5 §3.1.5，v0.4 新增）。
 *
 * 四象限归属：
 *   |  tool             | readOnly | openWorld | 含义                                |
 *   |  ---------------- | -------- | --------- | ----------------------------------- |
 *   |  interact_roots   |   true   |   false   | 列举可控 UI 根；本机只读枚举         |
 *   |  interact_observe |   true   |   *       | 取决于 dispatch 到 browse(openWorld) |
 *   |                   |          |           |   还是 desktop(¬openWorld)           |
 *   |  interact_act     |   false  |   *       | 可副作用（click/type/...）           |
 *
 * forest 调度层把 browse（openWorld=true）与 desktop（openWorld=false）混合；
 * 用最保守档：interact_observe 走 readOnly=true（observe 是只读，跨两 surface 都不副作用），
 * interact_act 走 readOnly=false（可副作用）。
 *
 * openWorld 取 false（保守）：dispatch 到 browse_headless 时实际 openWorld，
 * 但 model 已知 interact_act 可达 desktop（非开放外网），保守档让 CC 给 permission 提示。
 */
export const interactAnnotations: ToolAnnotations = {
  readOnlyHint: true, // interact_roots + interact_observe 都是只读；interact_act override 下面
  openWorldHint: false, // 保守：dispatch 可能进 desktop
};

/**
 * interact_act 专用 annotations（覆盖 interactAnnotations 的 readOnlyHint）。
 * 注册时直接传 interactAnnotations（让 server.tool 同一 annotations；model 据
 * 工具名 + description 路由）。如需更细，可在 registerInteractTools 内单独传。
 */
export const interactActAnnotations: ToolAnnotations = {
  readOnlyHint: false, // act 可副作用（click/type/press/...）
  openWorldHint: false, // 保守
};

/**
 * browserbase tool annotations（v0.4 M0.4c 新增，parse5 §3.2 + §3.4）。
 *
 * 四象限归属：
 *   |  tool        | readOnly | openWorld | 含义                                |
 *   |  ----------- | -------- | --------- | ----------------------------------- |
 *   |  browserbase |   false  |   true    | 可 click/fill（副作用）；云 Chrome 外网 |
 *
 * 与 browse_headless / browse_logged_in 同档（都是可副作用的 openWorld browse 通道），
 * 但 description 明确标 policy_risk=watched + 付费 manual-switch —— model 应优先选
 * browse_headless / browse_logged_in，仅反爬站点才升 browserbase。
 *
 * - readOnlyHint=false：与 browse_headless 同 —— navigate/click/fill 可副作用。
 * - openWorldHint=true：云 Chrome 经 browserbase.com 走外网。
 */
export const browserbaseAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  openWorldHint: true,
};

/**
 * fetch_url tool annotations（v0.5 M0.5a 新增，parse6 §1.4 + §6.5）。
 *
 * 四象限归属：
 *   |  tool       | readOnly | openWorld | 含义                                |
 *   |  ---------- | -------- | --------- | ----------------------------------- |
 *   |  fetch_url  |   true   |   true    | 只读不副作用；触外网；世界开放      |
 *
 * - readOnlyHint=true：fetch_url 只支持 GET / HEAD（v0.5），不改任何远端状态。
 *   与 browse_headless（readOnly=false，因可 click/fill）形成对比，CC 可据此自动批准。
 * - openWorldHint=true：经 undici 触任意公网 host（SSRF 守门后）。
 *
 * parse6 §6.5 边界审计：fetch_url 是 caller-tier 工具（与 browse 平行，不 fallback），
 * annotations 反映「能力上限」——v0.5 method enum 只含 GET/HEAD（POST/PUT 推 v0.6）。
 */
export const fetchUrlAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/**
 * screenshot tool annotations（v0.5 M0.5b 新增，parse6 §3.2 + §6.5）。
 *
 * 四象限归属：
 *   |  tool       | readOnly | openWorld | 含义                                |
 *   |  ---------- | -------- | --------- | ----------------------------------- |
 *   |  screenshot |   true   |   true    | 只读截图（无副作用）；触外网         |
 *
 * - readOnlyHint=true：screenshot 只调 navigate + take_screenshot，不改页面状态
 *   （navigate 是被动加载，不点不填；与 browse_headless readOnly=false 因可 click/fill
 *   形成对比）。CC 可据此自动批准 screenshot。
 * - openWorldHint=true：经 chrome-devtools-mcp 触任意公网 host（SSRF 守门后）。
 *
 * 守 INV-23 衍生：screenshot 不挂 fallback 链（经 BrowseChannel.browse() 入口隐式
 *                 享受 headless→logged_in fallback 是 channel 内部决策，非工具层 fallback）。
 */
export const screenshotAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/**
 * pdf tool annotations（v0.5 M0.5b 新增，parse6 §3.3 + §6.5）。
 *
 * 四象限归属：
 *   |  tool | readOnly | openWorld | 含义                                |
 *   |  ---- | -------- | --------- | ----------------------------------- |
 *   |  pdf  |   true   |   true    | 只读生成 PDF（无副作用）；触外网     |
 *
 * - readOnlyHint=true：pdf 只调 navigate + CDP Page.printToPDF，不改页面状态。
 * - openWorldHint=true：经 chrome-devtools-mcp 触任意公网 host（SSRF 守门后）。
 *
 * Go/No-Go F1（parse6 §4.4）：上游不支持时返 outcome=didnt + upstream_unsupported:pdf，
 *                            annotations 不变（能力上限是「读 PDF」，不支持是运行时降级）。
 */
export const pdfAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/**
 * network tool annotations（v0.5 M0.5c 新增，parse6 §3.4 + §6.5）。
 *
 * 四象限归属：
 *   |  tool    | readOnly | openWorld | 含义                                |
 *   |  ------- | -------- | --------- | ----------------------------------- |
 *   |  network |   true   |   true    | 只读抓资源列表（无副作用）；触外网   |
 *
 * - readOnlyHint=true：network 只调 navigate + PerformanceObserver 注入读取
 *   `performance.getEntriesByType("resource")`，不发请求、不改页面状态。
 *   PerformanceObserver 是 read-only 浏览器 API；与 browse_headless readOnly=false
 *   因可 click/fill 形成对比。CC 可据此自动批准 network。
 * - openWorldHint=true：经 chrome-devtools-mcp 触任意公网 host（SSRF 守门后）。
 *
 * Go/No-Go F2（parse6 §4.4 + §7.1）：fake-ip TUN 下 PerformanceObserver 可能抓不全，
 *                                  annotations 不变（能力上限是「读资源列表」，抓不全是运行时降级）。
 */
export const networkAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/**
 * admin tool annotations（v0.6 M0.6 新增，parse7 §3.5 + §6.2）。
 *
 * 四象限归属：
 *   |  tool  | readOnly | destructive | openWorld | idempotent | 含义                          |
 *   |  ----- | -------- | ----------- | --------- | ---------- | ----------------------------- |
 *   |  admin |   false  |   true      |   false   |   false    | 改运行时状态；副作用；本机     |
 *
 * - readOnlyHint=false（parse7 §3.5 红线）：capability_disable / provider_remove /
 *   caller_cap_set 改变 MCP server 运行时能力集合（下架 tool、停子进程、限速），
 *   与 browse_logged_in / desktop 同级风险。即使 capability_list / tool_list 只读，
 *   annotations 按**能力上限**标注（v0.5 既定原则），让 CC 给 permission 提示而非自动批准。
 * - destructiveHint=true（parse7 §3.5）：与 desktop_act 同档 —— 关闭通道会停子进程、
 *   影响其他正在进行的调用，且重启才能恢复默认状态（INV-40 衍生：进程内状态）。
 * - openWorldHint=false：admin 操作 Lasso 本机 MCP server runtime（非触外网）。
 *   provider_add 的 endpoint 字段虽可能指外网，但 admin 本身不发请求（仅写 registry）。
 * - idempotentHint=false：disable→enable 不返原状态（已 in-flight 调用不可恢复）；
 *   provider_remove 不可逆（重启才能恢复）。
 *
 * 风险缓解（parse7 §7.1 R-RT-8）：
 *  - destructiveHint=true + description 明确「ONLY when user explicitly asks」
 *  - admin capability_disable / provider_remove 必须传 reason 字段（强制思考）
 *  - 所有 mutation 写 audit log（callerId + reason + timestamp）
 */
export const adminAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
  idempotentHint: false,
};

/**
 * wayback_lookup tool annotations（v0.9 Phase B 新增，parse10 §3.3 + §6 M3）。
 *
 * 四象限归属：
 *   |  tool           | readOnly | openWorld | 含义                                |
 *   |  -------------- | -------- | --------- | ----------------------------------- |
 *   |  wayback_lookup |   true   |   true    | 只读不副作用；触外网（archive.org） |
 *
 * - readOnlyHint=true：wayback_lookup 只查 archive.org availability API + 解析 metadata，
 *   不写任何远端状态（不发 POST/PUT/DELETE；与 fetch_url GET/HEAD 同档）。
 *   archive.org availability API 是只读 GET；caller 二次调 fetch_url 才取 snapshot 内容。
 * - openWorldHint=true：经 undici 触 archive.org（公网已知 host，SSRF 守门后）。
 *
 * 与 fetch_url 同档（都是 caller-tier 只读 HTTP 工具）；annotations 反映「能力上限」——
 * 即便本 tool 永远只 GET，也按规范显式标注，让 CC 据此自动批准（parse10 §3.3 INV-56）。
 *
 * 守 INV-56：必经 ssrfGuard + doFetchUrl（与 fetch_url 同函数同 config）。
 * 守 INV-58：是独立 tool，不在 search 主路径里自动调（CC 显式 opt-in）。
 */
export const waybackAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};
