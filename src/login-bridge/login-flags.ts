/**
 * login-flags.ts（v1.31 登录接力档——doc/方案-login_bridge-登录接力-v1-2026-10-17.md）
 *
 * 端口 / profile / env 契约单一真源（render-flags.ts 范式）。
 *
 * INV-64 精神：本文件只 import node:* 内置。
 *
 * 端口带查证（R-INT-08）：9222=lasso 日常档默认；9223=media-gen Flow 惯例；
 * 9224=渲染档——**9225（登录档 CDP）/9226（登录档 relay）= 空闲**。
 * relay 是 lasso 首个入站监听（方案 §四 posture 变化）——只在 login_bridge start
 * 后存在，无常开监听面。
 */
import process from "node:process";

// ============================================================
// 端口默认与 env 覆盖
// ============================================================
export const LOGIN_CDP_PORT_DEFAULT = 9225;
export const LOGIN_RELAY_PORT_DEFAULT = 9226;

/** 登录档 CDP 端口（env LASSO_LOGIN_BRIDGE_CDP_PORT 覆盖；非法值降级默认并诚实）。 */
export function loginCdpPort(): number {
  const n = parseInt(process.env.LASSO_LOGIN_BRIDGE_CDP_PORT ?? "", 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : LOGIN_CDP_PORT_DEFAULT;
}

/** 登录档 relay 端口（env LASSO_LOGIN_BRIDGE_PORT 覆盖；非法值降级默认并诚实）。 */
export function loginRelayPort(): number {
  const n = parseInt(process.env.LASSO_LOGIN_BRIDGE_PORT ?? "", 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : LOGIN_RELAY_PORT_DEFAULT;
}

// ============================================================
// profile / 命名空间
// ============================================================
/**
 * 登录档持久 profile 前缀（与 render 临时 profile 区分：登录态资产，**跨会话持久**，
 * rmSync 归属守卫镜像本常量）。目录形态：`~/.cache/lasso/login-chrome-profile/<ns>`。
 * ns 默认 "default"；env LASSO_LOGIN_BRIDGE_NS 命名空间化（多 agent 并行防 cookie 互污）。
 */
export const LOGIN_PROFILE_PREFIX = "login-chrome-profile";

export function loginProfileNs(): string {
  const ns = (process.env.LASSO_LOGIN_BRIDGE_NS ?? "").trim();
  // 命名空间即路径段：禁路径分隔符与 ..（路径逃逸），空=默认档
  if (ns === "" || ns === "." || ns === ".." || /[/\\]/.test(ns)) return "default";
  return ns.slice(0, 64);
}

// ============================================================
// idle 默认（三套 idle 勿互抄——render-flags §3.10 同款告诫）
// ============================================================
/**
 * relay 空闲自动关默认 10min（env LASSO_LOGIN_BRIDGE_IDLE_MS 覆盖）。
 * 「活跃 TCP 连接=活着」；无连接且超时 → relay 自关（Chrome 不死，台账常规回收）。
 */
export const LOGIN_RELAY_IDLE_DEFAULT_MS = 600_000;

export function loginRelayIdleMs(): number {
  const raw = process.env.LASSO_LOGIN_BRIDGE_IDLE_MS;
  if (raw === undefined || raw.trim() === "") return LOGIN_RELAY_IDLE_DEFAULT_MS;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) return LOGIN_RELAY_IDLE_DEFAULT_MS;
  return n; // ≤0 = 显式 opt-out 不自关（文档化语义，不 clamp——render 同款）
}

/**
 * 登录档 Chrome 台账 idle 默认 30min（env LASSO_LOGIN_CHROME_IDLE_MS 覆盖）。
 * 比渲染档 10min 长：登录等待期人来人往，status 轮询会 touch 续命，
 * 30min 是「无人再过问」的兜底。owner 对照：LASSO_LAUNCH_IDLE_MS（日常档）/
 * LASSO_RENDER_IDLE_MS（渲染档）/ 本键——勿互抄。
 */
export const LOGIN_CHROME_IDLE_DEFAULT_MS = 1_800_000;

export function loginChromeIdleMs(): number {
  const raw = process.env.LASSO_LOGIN_CHROME_IDLE_MS;
  if (raw === undefined || raw.trim() === "") return LOGIN_CHROME_IDLE_DEFAULT_MS;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) return LOGIN_CHROME_IDLE_DEFAULT_MS;
  return n;
}

// ============================================================
// 旗标面（与 RENDER_DETERMINISTIC_FLAGS 刻意不同——登录档要「正常浏览器」
// 非确定性冻结：无 --disable-sync（身份资产语义）、无 --enable-automation）
// ============================================================
/**
 * 登录档基础旗标（per-instance 项 user-data-dir/remote-debugging-port/
 * remote-allow-origins/起始 URL 由 launcher 拼接）。
 * - --headless=new：服务器无显示器；screencast 投屏在 headless=new 下完整可用
 *   （调研 §二源码级定谳）。
 * - --password-store=basic：云 Linux 无 keyring 时防密钥库弹窗挂死（N1 披露面：
 *   cookie 落盘为明文，方案 §五-4）。
 */
export const LOGIN_FLAGS: readonly string[] = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--disable-background-networking",
  "--password-store=basic",
];
