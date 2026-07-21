/**
 * RootRegistry（parse5 §3.1.2）
 *
 * forest 调度层的「身份 → 短指针」复用 map。
 *
 * 核心职责（parse5 §3.1.2 + §4.1）：
 *  1. 持有 `nextRootRefIndex` 单调递增单计数器（@p / @w 前缀**共享**）
 *  2. `identityToRef`：identity 哈希 → RootRef（复用：同 url 重开 → 同 @pN）
 *  3. `refToInfo`：RootRef → RootInfo（反查 + 列表）
 *
 * 关键设计选择（parse5 §4.1 调研结论）：
 *  - **共享单计数器**：13 §3.3 v0.4+ 承诺；不分裂成 nextPageRefIndex +
 *    nextWindowRefIndex。双前缀只是 model 区分 surface 的提示，不影响计数。
 *    序列形如 `@p0 / @w1 / @p2 / @w3`（前缀交替递增）。
 *  - **identity 哈希在 channel 内计算**（BrowseChannel 算 cdpContextId|url；
 *    DesktopChannel 算 bundleId|pid|windowId）——抽象层不渗 channel 内部。
 *    与 injaneity 差异：Lasso 加 @p/@w 双前缀（injaneity 单 @r）。
 *  - **RootRegistry 单一真源**（INV-24，parse5 §2.3）：grep `class RootRegistry`
 *    全项目 ≤1，类比 INV-3 ProviderConfig / INV-9 ProviderRegistry。
 *
 * INV-21 衍生（INV-29）：本文件无平台字面量。
 * INV-26：本文件 import 自 ./forest-types.js（同层抽象数据），不 import channel。
 *
 * 借鉴：12 §1.2(F) injaneity state.ts `windowRefByIdentity` +
 *       `browserRootByContext` 双 map 设计。
 */
import type {
  RootIdentity,
  RootInfo,
  RootKind,
  RootRef,
} from "./forest-types.js";

// ============================================================
// 常量
// ============================================================
/**
 * LRU 容量上限（parse5 §3.1.2 evictStale 默认 256）。
 * 与 StateStore LRU(128) 量级一致；CC 单 session 内活跃 root 数远 < 256。
 */
const DEFAULT_MAX_ROOTS = 256;

/** 默认 stale 阈值：30 分钟（rootRef 长期未被 dispatch 视为过期）。 */
const DEFAULT_MAX_AGE_MS = 30 * 60_000;

// ============================================================
// 内部表项
// ============================================================
/**
 * refToInfo 表项：RootInfo + 上次 dispatch 时间戳（LRU 淘汰用）。
 */
interface RegistryEntry {
  info: RootInfo;
  /** 注册时戳（evictStale 用）。 */
  createdAt: number;
  /** 上次 dispatch 时戳（lookup/dispatch 刷新；evictStale 据此判定）。 */
  lastTouchedAt: number;
}

// ============================================================
// RootRegistry
// ============================================================
/**
 * forest 调度层的身份注册中心（INV-24：单一真源）。
 *
 * 线程模型：单线程 Node.js + async；本类的 map 操作是同步的（async getOrCreate
 * 仅为了对齐未来异步持久化路径）。多并发 interact_roots 调用经调用方串行化
 * （M0.4a 无 ResourceScheduler，由 MCP server 自身的 stdin 串行性兜底）。
 */
export class RootRegistry {
  /**
   * 单调递增单计数器（@p/@w 共享）。
   * 首次分配 = 0；每次 getOrCreate 命中新 ref 路径都 +1（不管 kind）。
   */
  private nextRootRefIndex = 0;

  /** identity 哈希 → RootRef（复用 map 核心）。 */
  private readonly identityToRef = new Map<string, RootRef>();

  /** RootRef → 注册表项（含 RootInfo + 时戳）。 */
  private readonly refToEntry = new Map<RootRef, RegistryEntry>();

  constructor(private readonly maxRoots: number = DEFAULT_MAX_ROOTS) {}

  /**
   * 注册或复用一个 Root。
   *
   * - identity 已存在 → 返回既有 rootRef（**不**分配新计数器；复用是核心）
   * - identity 不存在 → 按 kind 选前缀（@p / @w）+ 分配 nextRootRefIndex++
   *
   * @param ident    身份哈希（channel 自己算好；不渗 channel 内部）
   * @param factory  若需新建 ref，调 factory(kind, newRef) → RootInfo
   * @returns 已存在或新建的 RootRef
   */
  async getOrCreate(
    ident: RootIdentity,
    factory: (kind: RootKind, newRef: RootRef) => RootInfo,
  ): Promise<RootRef> {
    const existing = this.identityToRef.get(ident.identity);
    if (existing) {
      // 复用：refresh lastTouchedAt（活跃 root 不被淘汰）
      const entry = this.refToEntry.get(existing);
      if (entry) entry.lastTouchedAt = Date.now();
      return existing;
    }

    const prefix = ident.kind === "browser_page" ? "@p" : "@w";
    const newRef: RootRef = `${prefix}${this.nextRootRefIndex++}`;
    const info = factory(ident.kind, newRef);
    const now = Date.now();
    this.identityToRef.set(ident.identity, newRef);
    this.refToEntry.set(newRef, {
      info,
      createdAt: now,
      lastTouchedAt: now,
    });

    // 容量守护：超限淘汰最老
    if (this.refToEntry.size > this.maxRoots) {
      this.evictOldest();
    }
    return newRef;
  }

  /**
   * 反查 RootInfo（InteractDispatcher.dispatch 前置校验 rootRef 存在用）。
   * 同时刷新 lastTouchedAt（活跃 root 不被淘汰）。
   */
  lookup(ref: RootRef): RootInfo | undefined {
    const entry = this.refToEntry.get(ref);
    if (!entry) return undefined;
    entry.lastTouchedAt = Date.now();
    return entry.info;
  }

  /**
   * 列出所有 RootInfo（interact_roots 数据源）。
   *
   * 排序（parse5 §3.1.2）：
   *  - @pN 在前 @wN 在后（model 阅读：browser_page 优先；window 兜底）
   *  - 同前缀按 N 升序（与分配顺序一致）
   *
   * @param filter 可选按 kind 过滤
   */
  list(filter?: { kind?: RootKind }): RootInfo[] {
    const all = [...this.refToEntry.values()].map((e) => e.info);
    const filtered = filter?.kind
      ? all.filter((r) => r.kind === filter.kind)
      : all;
    return filtered.sort(compareRootInfo);
  }

  /**
   * 淘汰过期 root（parse5 §3.1.2 evictStale）。
   *
   * 过期定义：lastTouchedAt 早于 `now - maxAge`。
   * 调用时机：调用方显式调（doctor 周期清理 / registry 自己容量超限时触发 evictOldest）。
   *
   * @returns 被淘汰的 RootRef 列表（audit log / 调用方清理下游 state 用）
   */
  evictStale(maxAge: number = DEFAULT_MAX_AGE_MS): RootRef[] {
    const now = Date.now();
    const staleRefs: RootRef[] = [];
    for (const [ref, entry] of this.refToEntry) {
      if (now - entry.lastTouchedAt > maxAge) {
        staleRefs.push(ref);
      }
    }
    for (const ref of staleRefs) {
      this.remove(ref);
    }
    return staleRefs;
  }

  /** 当 refToEntry.size 超限：淘汰最老的 N 条（按 lastTouchedAt 升序）。 */
  private evictOldest(): void {
    const overflow = this.refToEntry.size - this.maxRoots;
    if (overflow <= 0) return;
    // 按 lastTouchedAt 升序取最早的 overflow 条
    const sorted = [...this.refToEntry.entries()].sort(
      (a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt,
    );
    for (let i = 0; i < overflow; i++) {
      const [ref] = sorted[i];
      this.remove(ref);
    }
  }

  /** 内部移除：同时清两个 map。 */
  private remove(ref: RootRef): void {
    const entry = this.refToEntry.get(ref);
    if (!entry) return;
    this.refToEntry.delete(ref);
    // identityToRef 反查 identity（O(n)；调用频度低，可接受）
    for (const [ident, r] of this.identityToRef) {
      if (r === ref) {
        this.identityToRef.delete(ident);
        break;
      }
    }
  }

  /** 测试 / 诊断用：当前注册数量。 */
  get size(): number {
    return this.refToEntry.size;
  }

  /** 测试 / 诊断用：下一次分配的 N（断言「单计数器」用）。 */
  getNextRootRefIndexForTest(): number {
    return this.nextRootRefIndex;
  }
}

// ============================================================
// 排序工具（导出供测试 / doctor 用）
// ============================================================
/**
 * RootInfo 排序：@pN 在前 @wN 在后；同前缀按 N 升序。
 *
 * 抽出为独立函数便于测试（forest-root-registry.spec.ts 直接断言顺序）。
 */
export function compareRootInfo(a: RootInfo, b: RootInfo): number {
  const aKind = a.rootRef.startsWith("@p") ? 0 : 1;
  const bKind = b.rootRef.startsWith("@p") ? 0 : 1;
  if (aKind !== bKind) return aKind - bKind;
  const aIdx = parseInt(a.rootRef.slice(2), 10);
  const bIdx = parseInt(b.rootRef.slice(2), 10);
  return aIdx - bIdx;
}
