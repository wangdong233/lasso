/**
 * AxBackendFactory（parse11 §3.1 v1.0 跨平台 desktop；INV-60 单一真源）
 *
 * 职责（单一）：按当前平台路由到对应 backend class（MacAxBackend /
 * WinUiaBackend / LinuxAtspiBackend），让 AxProvider 不感知平台。
 *
 * 单一真源（INV-60）：
 *  - 本文件是 backend 注册的**唯一**入口（grep `new MacAxBackend|new WinUiaBackend|new LinuxAtspiBackend`
 *    只在本文件 + 单测 mocks；AxProvider / DesktopChannel / index.ts 都不经此工厂不直构 backend）
 *  - AxBackendKind 字面量 type 定义在 AxBackend.ts（INV-60 衍生：类型真源）
 *
 * 路由策略（parse11 §3.1）：
 *  - process.platform === "darwin"  → MacAxBackend       → rust.call("ax_*")
 *  - process.platform === "win32"   → WinUiaBackend      → rust.call("uia_*")
 *  - process.platform === "linux"   → LinuxAtspiBackend  → rust.call("atspi_*")
 *  - 其他                            → 抛 unsupported_platform（不静默降级）
 *
 * 不做的事（深模块边界 / R-CI-02）：
 *  - 不在 TS 层做平台 API 分支（INV-21：平台 API 全在 rust-helper/*.rs）
 *  - 不缓存 backend 实例（factory 调用方决定生命周期；index.ts 持单例）
 *  - 不引第二套探测机制（platform-detect.ts 是单一真源；INV-60 衍生）
 *
 * INV-21 衍生 + INV-60 衍生：本工厂不直接 import 平台 crate（那都在 Rust 端）；
 * 本工厂只是 TS 端路由器（薄壳调度）。
 *
 * macOS-only 现实红线（parse11 §1.3）：本机 macOS-only，Windows UIA + Linux AT-SPI
 * 无法本机运行时验证。本工厂在 TS 端三平台同构可证（factory.create 在三平台返
 * 同 AxBackend interface 实例）；真实 UIA/AT-SPI 执行留手测清单，不伪造。
 *
 * 借鉴：parse11 §3.1；13 §2.4 R-CI-02（兄弟不是父子）；abstract-factory pattern
 * （GoF）：client（AxProvider）只依赖 AxBackend interface，不依赖具体 class）。
 */
import type { AxBackend, AxBackendKind } from "./AxBackend.js";
import {
  MacAxBackend,
  WinUiaBackend,
  LinuxAtspiBackend,
} from "./AxBackend.js";
import type { RustBridge } from "../subprocess/RustBridge.js";
import { detectPlatform, rawToPlatform } from "./platform-detect.js";

// ============================================================
// 错误种类
// ============================================================
/**
 * 不支持平台时抛的 error_kind（与 rust-helper/src/protocol.rs error_kind 同风格）。
 *
 * AxBackendFactory.detectKind / .create 在 process.platform 不在
 * {darwin, win32, linux} 时抛此 error；doctor #31 platform_backend_active
 * 捕获并报 fail。
 */
export const UNSUPPORTED_PLATFORM_ERROR_KIND = "unsupported_platform";

// ============================================================
// AxBackendFactory（静态注册表 + 路由器）
// ============================================================
/**
 * AxBackend 工厂（v1.0 F3.10.9 落地；parse11 §3.1）。
 *
 * INV-60：本类是三平台 backend 注册的单一真源。
 *
 * 设计选择（parse11 §3.1）：静态方法而非实例方法 —— 路由是无状态的纯函数，
 * 不需实例化（避免 index.ts 多一个 new Factory() 步骤）；测试时 detectPlatform
 * 的 mock 入参走 detectKind(opts) 显式注入。
 */
export class AxBackendFactory {
  /**
   * 探测当前平台对应的 backend kind。
   *
   * @param opts 可选注入 rawPlatform（测试 mock 用）；生产路径走 detectPlatform()
   * @returns AxBackendKind（"mac" / "win_uia" / "linux_atspi"）
   * @throws Error(`unsupported_platform:<raw>`) 当平台不在三平台之列
   */
  static detectKind(
    opts: { rawPlatform?: string } = {},
  ): AxBackendKind {
    const raw = opts.rawPlatform ?? detectPlatform().raw;
    const platform = rawToPlatform(raw);
    switch (platform) {
      case "mac":
        return "mac";
      case "win":
        return "win_uia";
      case "linux":
        return "linux_atspi";
      default:
        throw new Error(`${UNSUPPORTED_PLATFORM_ERROR_KIND}:${raw}`);
    }
  }

  /**
   * 按 AxBackendKind 选 backend class 并 new 出实例。
   *
   * @param kind AxBackendKind（detectKind 输出）
   * @param rust RustBridge 实例（透传给 backend 构造器）
   * @returns AxBackend 实例（具体 class 由 kind 决定）
   *
   * INV-60 衍生：本方法是 `new MacAxBackend|WinUiaBackend|LinuxAtspiBackend`
   * 的唯一允许位置（grep 三 class `new` 字面量只在本方法 + AxBackend 单测）。
   */
  static createFromKind(
    kind: AxBackendKind,
    rust: RustBridge,
  ): AxBackend {
    switch (kind) {
      case "mac":
        return new MacAxBackend(rust);
      case "win_uia":
        return new WinUiaBackend(rust);
      case "linux_atspi":
        return new LinuxAtspiBackend(rust);
    }
  }

  /**
   * 便捷入口：探测平台 → 选 kind → new backend（index.ts 装配用）。
   *
   * @param rust RustBridge 实例
   * @param opts 可选 rawPlatform（测试 mock）
   * @returns AxBackend（已路由到对应平台 class）
   *
   * 生产路径（index.ts）：`AxBackendFactory.create(rustBridge)` → 当前平台 backend。
   * 测试路径：`AxBackendFactory.create(mock, { rawPlatform: "win32" })` → WinUiaBackend。
   */
  static create(
    rust: RustBridge,
    opts: { rawPlatform?: string } = {},
  ): AxBackend {
    const kind = this.detectKind(opts);
    return this.createFromKind(kind, rust);
  }
}
