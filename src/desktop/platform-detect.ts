/**
 * platform-detect（parse11 §3.1 v1.0 跨平台 desktop）
 *
 * 职责（单一，简单）：把 process.platform + os.release() 收敛为
 * PlatformInfo，供 AxBackendFactory 路由到对应 backend class。
 *
 * 不做的事（深模块边界 / R-CI-02）：
 *  - 不引第二套平台抽象（process.platform 是 Node 内置单一真源）
 *  - 不读 process.env 做平台伪装（LASSO_FORCE_PLATFORM 类的环境覆盖会破坏
 *    AxBackendFactory 单一真源；doctor #31 是只读 report）
 *  - 不做浏览器 UA 探测（Lasso 是 Node 进程；UA 无关）
 *  - 不直接 import 任一 backend class（守 INV-60：backend 注册只在 Factory）
 *
 * INV-21 衍生：本文件不引用任何平台 API 字面量（AXUIElement / CGEvent /
 * UIAutomationClient / libatspi）；只读 process.platform 字符串字面量
 * "darwin" / "win32" / "linux"（Node process.platform 内置常量）。
 *
 * 借鉴：parse11 §3.1 detectKind；is-platform / get-os 等社区工具都太厚，
 * Lasso 只需 process.platform + os.release —— 薄壳足够（R-CI-02 守门）。
 */
import process from "node:process";
import { release } from "node:os";

// ============================================================
// 公共类型
// ============================================================
/**
 * Lasso 支持的平台枚举（基于 Node process.platform 收敛）。
 *
 *  - "mac"    : process.platform === "darwin"
 *  - "win"    : process.platform === "win32"
 *  - "linux"  : process.platform === "linux"
 *  - "unknown": 其他（freebsd / aix / sunos / openbsd 等；AxBackendFactory 抛错）
 */
export type Platform = "mac" | "win" | "linux" | "unknown";

/**
 * 平台探测结果（PlatformInfo）。
 *
 *  - platform  : 收敛后的 Platform 枚举（mac/win/linux/unknown）
 *  - raw       : process.platform 原值（如 "darwin" / "win32"；诊断字段）
 *  - kernel    : os.release() 内核版本（如 "21.6.0"；macOS 12 Intel 本机值）
 *  - arch      : process.arch（"x64" / "arm64" / ...；诊断字段）
 */
export interface PlatformInfo {
  platform: Platform;
  raw: string;
  kernel: string;
  arch: string;
}

// ============================================================
// 主入口
// ============================================================
/**
 * 探测当前进程所在平台。
 *
 * @param opts 可选注入 process.platform（测试 mock 用）；生产路径走 process.platform
 * @returns PlatformInfo（platform + raw + kernel + arch）
 *
 * INV-21 衍生 + INV-60 衍生：本函数只读 process.* / os.* 内置 API；
 * 不调任何平台 AX/UIA/AT-SPI API（那都在 Rust 端 rust-helper/src/*.rs）。
 */
export function detectPlatform(
  opts: { rawPlatform?: string; kernel?: string; arch?: string } = {},
): PlatformInfo {
  const raw = opts.rawPlatform ?? process.platform;
  const kernel = opts.kernel ?? release();
  const arch = opts.arch ?? process.arch;
  return {
    platform: rawToPlatform(raw),
    raw,
    kernel,
    arch,
  };
}

/**
 * process.platform 原值 → Platform 枚举收敛。
 *
 * 单独导出便于 AxBackendFactory.detectKind / 单测直接调用（不每次重算 kernel/arch）。
 */
export function rawToPlatform(raw: string): Platform {
  switch (raw) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}
