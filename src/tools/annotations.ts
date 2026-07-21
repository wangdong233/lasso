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
