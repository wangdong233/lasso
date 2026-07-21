/**
 * OutlineMapper（parse4 §4.3 + §4.4）
 *
 * 把 Rust helper ax_snapshot 返回的 AxNode 原始树标准化为 OutlineNode 树。
 *
 * 职责（简单性铁律 — 不缠绕）：
 *  1. children 递归（深度优先，前序遍历）
 *  2. @eN ref 单调分配（DFS 序，0-based，每次自增 1）
 *  3. pictureOnly 三启发式判定（parse4 §4.4）
 *
 * 不做的事（深模块边界）：
 *  - 不重新映射 role（Rust 端已用 map_ax_role 映射过；本类直接透传 AxNode.role）
 *  - 不读 raw_role 做控制流（raw_role 仅诊断字段，不参与判定）
 *  - 不裁剪 / 不去重 / 不排序（保持原序 + 原结构）
 *  - 不做语义推断（label 模糊匹配等在 find 阶段做）
 *
 * INV-21（F3.9.9 f）：本文件判定 pictureOnly 只用 mapped unified role
 * （"img" / "unknown" / "group"），不引用任何平台 AXRole 字面量。
 * 启发式 (3) 用 "group" + label="" 近似覆盖 storyboard canvas 场景
 * （Rust 端已把 AXLayoutArea 映射到 "group"，本类据此识别"无标签大空白 group"
 * 这类 canvas 候选；M0.5a 验证覆盖率后再决定是否加更细判别）。
 *
 * 借鉴：parse4 §4.3 递归 visit 范式；DOM role 标准；pi-computer-use
 * 的 tree-walk ref 分配模式。
 */
import type { AxNode, OutlineNode } from "./desktop-types.js";

// ============================================================
// 常量
// ============================================================
/** pictureOnly 启发式:rect 长宽均需 > 此阈值（parse4 §4.4）。 */
const PICTURE_ONLY_MIN_DIM = 100;

// ============================================================
// 公共类型
// ============================================================
/**
 * axTreeToOutline 返回结构。
 *  - root       : 映射后的 OutlineNode 树根（ref 已分配）
 *  - refCounter : 分配的 ref 总数（= DFS 序最大值 + 1，便于上游 cache sizing）
 */
export interface OutlineMapResult {
  root: OutlineNode;
  refCounter: number;
}

// ============================================================
// 主入口
// ============================================================
/**
 * AxNode 原始树 → OutlineNode 标准化树。
 *
 * @param root AxNode 树根（来自 Rust helper ax_snapshot 响应）
 * @returns { root, refCounter } —— root 是 OutlineNode 树；refCounter 是 ref 总数
 *
 * 算法（parse4 §4.3）：
 *  1. 从 root 开始 DFS 前序遍历
 *  2. 每访问一个节点，分配 ref = `@e${counter++}`
 *  3. pictureOnly 判定（见 _isPictureOnly）
 *  4. 递归 children（保持原序）
 *
 * 复杂度：O(N)，N = 树节点数。无副作用，可重入。
 */
export function axTreeToOutline(root: AxNode): OutlineMapResult {
  let refCounter = 0;
  const visit = (n: AxNode): OutlineNode => {
    const ref = `@e${refCounter++}`;
    const children = n.children.map(visit);
    return {
      role: n.role,
      label: n.label,
      ref,
      rect: n.rect,
      pictureOnly: isPictureOnly(n, children.length),
      children,
    };
  };
  const outlineRoot = visit(root);
  return { root: outlineRoot, refCounter };
}

// ============================================================
// pictureOnly 三启发式（parse4 §4.4）
// ============================================================
/**
 * 三启发式组合判定（M0.5a 验证 ≥80% 准确率，parse4 §4.4）：
 *
 *  (1) role === "img"  且 rect.w>100 且 rect.h>100 且无 children → true
 *      （大图无子元素；AXImage 在 Rust 端映射为 "img"）
 *
 *  (2) role === "unknown" 且 rect.w>100 且 rect.h>100 且无 children → true
 *      （canvas/Metal 候选；AXUnknown + 未映射的 AXRole 都落到 "unknown"）
 *
 *  (3) role === "group" 且 label==="" 且 rect.w>100 且 rect.h>100 且无 children → true
 *      （Xcode storyboard canvas 等；AXLayoutArea 在 Rust 端映射为 "group"，
 *       无 label + 大空白 + 无子元素是 canvas 候选的近似特征）
 *
 * 不满足任一 → false。判定只读 mapped role + label + rect + children.length，
 * 不读 raw_role（避免在 TS 层引入平台 AXRole 字面量）。
 *
 * @param node       AxNode 原始节点（取 role / label / rect）
 * @param childCount children 数量（已递归后传入，避免重复访问）
 */
export function isPictureOnly(
  node: AxNode,
  childCount: number,
): boolean {
  if (childCount > 0) return false;
  const { w, h } = node.rect;
  if (!(w > PICTURE_ONLY_MIN_DIM && h > PICTURE_ONLY_MIN_DIM)) return false;

  if (node.role === "img") return true;
  if (node.role === "unknown") return true;
  if (node.role === "group" && node.label === "") return true;
  return false;
}
