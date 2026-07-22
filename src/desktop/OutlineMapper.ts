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

/**
 * interactiveOnly 过滤：可交互 role 集合（doc/14 §4.2d Lightpanda-inspired）。
 * 只含「用户能操作」的元素（点击/输入/选择），排除纯文本/布局/容器。
 * 取自 ax-role-map.ts unified roles 中语义为 interactive 的子集。
 * INV-21：用的是 unified role（非平台 AXRole 字面量）。
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textfield",
  "textarea",
  "checkbox",
  "radio",
  "select",
  "menuitem",
  "menubaritem",
  "menubutton",
]);

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

// ============================================================
// interactiveOnly 过滤（doc/14 §4.2d，v1.2）
// ============================================================
/**
 * 判断 role 是否「可交互」（用户能操作：点击/输入/选择）。
 * 用于 interactiveOnly opt-in 过滤（pruneToInteractive）。
 */
export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

/**
 * 含交互后代判定（含自身）—— 用于剪枝决策：保留一个节点当它自身可交互
 * 或它的子树含可交互节点（保留祖先以维持树结构上下文）。
 */
function hasInteractiveInSubtree(node: OutlineNode): boolean {
  if (isInteractiveRole(node.role)) return true;
  return node.children.some(hasInteractiveInSubtree);
}

/**
 * 剪枝 OutlineNode 树到「只含可交互元素 + 其祖先」（doc/14 §4.2d）。
 *
 * - **root 永远保留**（即使非交互）—— 上游需要树根 handle；root 是 application/window。
 * - 非根节点：保留当且仅当「自身可交互 OR 子树含可交互后代」。
 * - 纯文本/布局/容器（无交互后代）的叶子分支被剪掉。
 * - 不改原树（返新树；children 数组重建，节点对象复用浅拷贝）。
 *
 * 用途：LLM 只需「这页面能点什么/填什么」时，大幅省 token（vs 全 AX tree）。
 * 默认 off（DesktopOptions.interactive_only 未传 = 不过滤 = byte-identical v1.1）。
 *
 * INV-70：本函数是 opt-in 后处理；axTreeToOutline（映射）一行不改（INV-61 三平台共享不变）。
 */
export function pruneToInteractive(root: OutlineNode): OutlineNode {
  const visit = (node: OutlineNode, isRoot: boolean): OutlineNode | null => {
    const selfInteractive = isInteractiveRole(node.role);
    // root 永远保留；非 root 且既非交互也无交互后代 → 剪
    if (!isRoot && !selfInteractive && !hasInteractiveInSubtree(node)) {
      return null;
    }
    const children = node.children
      .map((c) => visit(c, false))
      .filter((c): c is OutlineNode => c !== null);
    return { ...node, children };
  };
  const pruned = visit(root, true);
  // pruned 非 null（root 永远保留）；防御性兜底
  return pruned ?? root;
}
