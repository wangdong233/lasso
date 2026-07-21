/**
 * Channel 抽象基类（parse1 §2.1 + §3.4 SearchChannel / §3.5 BrowseChannel）
 *
 * 三层抽象（08 §3.1.3）：
 *  - BaseChannel   : 通用层 —— 所有 channel 共有的 is_available / status / health_check
 *  - UiChannel     : UI 层   —— 比 BaseChannel 多「页面状态」概念（v0.1 占位，v0.3 加）
 *  - 具体通道      : SearchChannel / BrowseChannel / HeadlessChannel / LoggedInChannel
 *
 * 不变量 INV-2：所有具体 XxxChannel 必须 extends BaseChannel 或 UiChannel。
 * invariants 脚本扫源码确认所有非 abstract 的 Channel 类都通过 extends 接入分层。
 *
 * 借鉴：08 §3.1.3 分层；12 F.1 outcome-first 接口风格。
 */
import type { ChannelStatus, Health } from "../types.js";

export abstract class BaseChannel {
  /** channel 自报名（如 "search.zhipu" / "browse_headless"），用于 InteractResult.served_by。 */
  abstract readonly name: string;

  /**
   * 不触网的快速可用性判定（如「API key 配了没」「endpoint 是 https 开头吗」）。
   * 真实活性看 status() / healthCheck()。
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * 触网探测：返回可用性 + 延迟。失败时 available=false 且 note 带原因。
   * 实现**不应抛异常**——所有错误走 { available: false, note }。
   */
  abstract status(): Promise<ChannelStatus>;

  /**
   * 聚合健康判定：healthy / degraded / down。
   * doctor 用这个做 readiness 检查项。
   */
  abstract healthCheck(): Promise<Health>;
}
