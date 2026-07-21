/**
 * UI 层 channel 抽象（parse1 §2.1 + §3.5 BrowseChannel）
 *
 * 比 BaseChannel 多「页面状态」概念：browse_headless / browse_logged_in 都要
 * 处理 URL → action → 状态写盘（state_id + content_path）。desktop 通道
 * （v0.3.5）同样继承本类，共享 action 抽象。
 *
 * v0.1 占位：BrowseChannel 子类化时才用到本层；v0.3 会加 expect 后置条件、
 * StateStore LRU、steps 多步链式等 UI 层公共逻辑。现阶段保持极简——只做
 * 类型分层让 INV-2 检查通过 + 给后续扩展留口子。
 *
 * **简单性铁律（01 思想）**：不为未实装的功能加抽象方法。v0.1 的 BrowseChannel
 * 直接在自身实装 browse()；UiChannel v0.3 真正需要 abstract 方法时再加。
 *
 * 借鉴：08 §3.1.3 分层；pi-computer-use 的 UI layer 抽象。
 */
import { BaseChannel } from "./BaseChannel.js";

export abstract class UiChannel extends BaseChannel {
  // v0.1 占位；v0.3 加 abstract 方法（如 pageState() / dispatchAction()）。
  // 现在让 BrowseChannel 直接在自身实装 browse()，不强制子类实装额外抽象方法
  // —— 不为未实装的抽象埋空操作（不把 easy 当 simple）。
}
