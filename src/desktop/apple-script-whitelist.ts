/**
 * AppleScript 白名单（parse5 §3.5.1 + §4.4 注入防御层 1 + INV-27）
 *
 * ## 本文件在 3 层纵深防御中的角色
 *
 *   层 1（TS，本文件 + AppleScriptProvider）：
 *      - typed action enum（AppleScriptActionName）入口
 *      - arg 形状校验：params 的 key 必须是 allowedParams 的子集
 *      - **不内联任何 AppleScript 脚本字符串**（脚本字面量只在 Rust 端）
 *   层 2（Rust, applescript.rs）：二次校验 action 在白名单 + params key 在 allowedParams
 *   层 3（编译期, rust-helper/src/applescript_whitelist.rs）：顶级 const manifest，
 *      编译进 binary；运行时不可改（INV-27 anti-gaming，类比 INV-14）
 *
 * ## 为什么 TS 端不内联脚本
 *
 *   若 TS 端持有脚本字面量，则 LLM 通过 channel 改 env / config / runtime 配置
 *   就能间接改脚本（INV-14 anti-gaming 衍生）。把脚本字面量**只**放在 Rust 端的
 *   顶级 const（编译进 binary），TS 端只镜像 action_name → allowedParams 形状，
 *   是 F3.10.8 typed action enum 红线的可执行形式。
 *
 *   镜像纪律：本文件 `APPLE_SCRIPT_WHITELIST` 与
 *   `rust-helper/src/applescript_whitelist.rs::WHITELIST_STATIC` 字段对齐
 *   （action 名 + allowedParams 名）；新加 action 两边各加一行（≤2 处改动守 02 §4）。
 *
 * ## INV-27 红线（本文件 TS 侧）
 *
 *   - 顶级 const，不从 config / env 读（grep `process.env.APPLE_SCRIPT` 命中即🔴）
 *   - 不导入任何 config / provider-registry / env-reader 模块
 *   - 与 INV-14 同范式：anti-gaming —— LLM 不能通过运行时配置绕过白名单
 *
 * 借鉴：parse5 §3.5.1 + §4.4；F3.10.8 typed action enum；mac-mcp OSAKit 安全路径。
 */
// INV-26 守护：本文件不 import 任何 channel internal / config / subprocess 模块。
// 纯类型 + 顶级 const，零运行时依赖（除 TypeScript 标准类型）。

// ============================================================
// typed action enum
// ============================================================
/**
 * AppleScript typed action 名（与 rust-helper applescript_whitelist.rs 镜像）。
 *
 * 命名规则：lowercase_snake_case（与 Rust 端 naming test 对齐）。
 * 加新 action = 加这里一行 + Rust 端镜像一行（≤2 处改动）。
 */
export type AppleScriptActionName =
  // Finder
  | "finder_new_folder"
  | "finder_empty_trash"
  | "finder_count_windows"
  // Mail
  | "mail_new_message"
  // Safari
  | "safari_open_location"
  | "safari_get_url"
  // Notes
  | "notes_new_note"
  // System / shell（不依赖特定 app 的 AppleEvents）
  | "system_get_volume"
  | "system_get_uptime";

// ============================================================
// 白名单形状
// ============================================================
/**
 * 单条白名单形状（TS 端**只**校验形状，不持脚本）。
 *
 * - `allowedParams`：允许的参数名只读集合；运行时传入的 params 的 key 必须是
 *   它的子集，否则 AppleScriptProvider 直接 outcome=didnt + 拒绝下传 Rust
 *   （层 1 防御；层 2 Rust 端再独立校验，纵深防御）
 *
 * 注：脚本字面量（`script` 字段）**只在** rust-helper/src/applescript_whitelist.rs
 * 出现；本接口刻意不含 `script` 字段（grep 锚点，INV-27 anti-gaming 衍生）。
 */
export interface AppleScriptWhitelistEntry {
  readonly allowedParams: readonly string[];
}

/**
 * 顶级 const 白名单（INV-27 anchor）。
 *
 * 与 `rust-helper/src/applescript_whitelist.rs::WHITELIST_STATIC` 字段镜像：
 * 每条 action 的 allowedParams 与 Rust 端 allowed_params 完全一致。
 *
 * 修改纪律：改这里必须同步改 Rust 端；CI 单测 apple-script-whitelist.spec.ts
 * + Rust applescript_whitelist.rs tests 双向守护形状不漂移。
 */
export const APPLE_SCRIPT_WHITELIST: Record<
  AppleScriptActionName,
  AppleScriptWhitelistEntry
> = {
  // ------------------------------------------------------------------
  // Finder
  // ------------------------------------------------------------------
  finder_new_folder: { allowedParams: [] },
  finder_empty_trash: { allowedParams: [] },
  finder_count_windows: { allowedParams: [] },
  // ------------------------------------------------------------------
  // Mail
  // ------------------------------------------------------------------
  mail_new_message: { allowedParams: ["subject", "content"] },
  // ------------------------------------------------------------------
  // Safari
  // ------------------------------------------------------------------
  safari_open_location: { allowedParams: ["url"] },
  safari_get_url: { allowedParams: [] },
  // ------------------------------------------------------------------
  // Notes
  // ------------------------------------------------------------------
  notes_new_note: { allowedParams: ["name", "body"] },
  // ------------------------------------------------------------------
  // System / shell
  // ------------------------------------------------------------------
  system_get_volume: { allowedParams: [] },
  system_get_uptime: { allowedParams: [] },
};

// ============================================================
// 公共查询 API（AppleScriptProvider + 单测用）
// ============================================================
/**
 * 是否为已知 typed action（层 1 入口校验）。
 *
 * 用 `name in APPLE_SCRIPT_WHITELIST` 而非 Object.hasOwn 是为了兼容性 +
 * 让 TypeScript narrowed 到对应的 whitelist entry。
 */
export function isKnownAction(name: string): name is AppleScriptActionName {
  return Object.prototype.hasOwnProperty.call(APPLE_SCRIPT_WHITELIST, name);
}

/**
 * 校验 params 的所有 key 是否都是 allowedParams 的子集。
 *
 * @returns 第一次违规的 key（caller 写入 error 信息）；全部合规返 null。
 */
export function findDisallowedParamKey(
  action: AppleScriptActionName,
  params: Record<string, unknown>,
): string | null {
  const allowed = APPLE_SCRIPT_WHITELIST[action].allowedParams;
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) return k;
  }
  return null;
}

/**
 * 白名单全部 action 名（单测覆盖用 + doctor 自检用）。
 *
 * 返只读数组；不允许调用方修改（INV-27 anti-gaming 衍生）。
 */
export function allWhitelistActions(): readonly AppleScriptActionName[] {
  return Object.keys(APPLE_SCRIPT_WHITELIST) as AppleScriptActionName[];
}
