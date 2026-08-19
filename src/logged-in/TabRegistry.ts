/**
 * TabRegistry.ts（v0.8 parse9 §3.3）—— lasso 操作面 tab LRU 管理（≤10 hard cap）
 *
 * 防爆炸场景（parse9 §4.3）：CC 反复 navigate 不同 URL，chrome-devtools-mcp
 * 留 tab；100 次后 Chrome 内存爆。本类守 ≤10，超限 LRU 淘汰最老 own tab
 * （close_page）。
 *
 * v1.17.2（doc/27-静默性全面审计 S-10 修复）—— 两个契约修正：
 *  1. **close 形态**：上游 chrome-devtools-mcp@1.7.0 的 `close_page` schema 是
 *     `{pageId:number}`——旧代码传 `{url}` 在 wire 级必被 zod 拒（-32602，
 *     verify.md §5e 实证）→ 淘汰从未真正生效。改为从 list_pages 解析 pageId
 *     后按 id 关（同一次 reconcile 内解析即用，id 在页生命周期内稳定）。
 *  2. **所有权边界（机械化）**：旧代码把 list_pages 列出的**全部** URL 触达进
 *     LRU——连用户 Chrome 时用户自己的 tab 全部入册，一旦 close 形态修好，
 *     「淘汰」关的就是用户 tab（S-10 的潜在事故面）。现改为 reconcile 只触达
 *     **已登记 own 页**（`noteOwnPage`——LoggedInChannel.ensureOwnPageSelected
 *     创建并选中自建页后登记）：「close_page 只可能落在 lasso 自己开的 tab 上」
 *     由登记集合的定义保证，而非运行时判断（红线机械化范式，同 TabSession
 *     diff 守卫）。陈旧条目（页已关 / 上游 respawn id 重置）按列表修剪。
 *
 * 复用范式（INV-50）：
 *  - LRU Map<pageId, { url, lastUsedAt }>（同 state-store.ts StateStore LRU(128)）
 *  - 触达 = delete + set（MRU 提升；Map 保插入序，首位 = LRU）
 *  - 淘汰 = while size > cap: keys().next().value + close_page
 *
 * 不渗 BaseChannel（INV-7 衍生）：tab 是 chrome-devtools-mcp 概念，desktop 通道无 tab。
 * 不渗 BrowseChannel.actionDispatch（parse9 §3.3 决策）：tab 管理是横切关注点，
 * BrowseChannel 一行不改；本类由 LoggedInChannel.getMcpClient() 末尾调。
 *
 * 借鉴：parse9 §3.3 接口签名 + util/state-store.ts StateStore LRU 范式（INV-12 同源）。
 */
import type { McpClient } from "../subprocess/McpClient.js";
import { logger } from "../util/logger.js";

// ============================================================
// 常量
// ============================================================
/** 默认 tab hard cap（parse9 §4.3：≤10；与 StateStore(128) 同范式不同概念）。 */
export const TAB_CAP_DEFAULT = 10;
/** cap clamp 下界（构造 cap < 1 → 1）。 */
const CAP_MIN = 1;
/** cap clamp 上界（构造 cap > 20 → 20；防 LLM 误配过大）。 */
const CAP_MAX = 20;

// ============================================================
// 上游 list_pages 解析（v1.17.2 S-10；LoggedInChannel.ensureOwnPageSelected 共用）
// ============================================================
/** 上游一个 page 条目（1.7.0 `## Pages` 段一行）。 */
export interface UpstreamPageEntry {
  /** 上游进程内单调计数器 id（select_page / close_page 的契约键）。 */
  pageId: number;
  /** 页 URL（尽力解析；空串 = 解析不出，仅日志用途）。 */
  url: string;
  /** 是否上游当前选中页（= lasso 操作面）。 */
  selected: boolean;
}

/**
 * chrome-devtools-mcp@1.7.0 `list_pages` 文本 → UpstreamPageEntry[]。
 *
 * 上游格式（McpResponse.js `## Pages` 段，每行）：
 *   `<id>: <title> (<url>) [selected]`（无 title 时 `<id>: <url>`；
 *   扩展页在 `## Extension Pages` 段、id 同计数器）
 *
 * @returns null = 一条页行都没解析到（空响应 / 上游格式漂移）——调用方保守降级，
 *          宁可不淘汰也不误判（失败方向良性：close 从不被触发）。
 */
export function parseUpstreamPageEntries(text: string): UpstreamPageEntry[] | null {
  if (!text || !text.trim()) return null;
  const out: UpstreamPageEntry[] = [];
  for (const line of text.split("\n")) {
    // 页行以 `<数字>: ` 开头；`## Pages` / `Note: ...` / 空行全部跳过
    const m = line.match(/^(\d+):\s+(.*)$/);
    if (!m) continue;
    const rest = m[2];
    // url：优先取最后一个 scheme 开头的括号组（title 可能自带括号，url 组恒在
    // [selected] 前的最后一位）；无 title 形态则 rest 本身就是 url
    let url = "";
    const groups = [...rest.matchAll(/\(([^()]+)\)/g)];
    for (let i = groups.length - 1; i >= 0; i--) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(groups[i]![1])) {
        url = groups[i]![1];
        break;
      }
    }
    if (!url) {
      const bare = rest.match(/^(?:about:blank|[a-z][a-z0-9+.-]*:\/\/\S+)/i);
      if (bare) url = bare[0];
    }
    out.push({
      pageId: parseInt(m[1]!, 10),
      url: url.replace(/[),.;\]]+$/, ""),
      selected: /\[selected\]/.test(rest),
    });
  }
  return out.length > 0 ? out : null;
}

// ============================================================
// 内部类型
// ============================================================
interface TabMeta {
  url: string;
  lastUsedAt: number;
}

// ============================================================
// TabRegistry
// ============================================================
/**
 * lasso 操作面 tab 的 LRU 管理（parse9 §3.3 + v1.17.2 S-10 所有权收窄）。
 *
 * 一个 TabRegistry 实例对应一个 channel（LoggedInChannel）；多 profile 场景
 * 每 profile 一个独立 TabRegistry 实例（profile 物理隔离 → tab 不跨 profile）。
 */
export class TabRegistry {
  private tabs = new Map<number, TabMeta>();
  /** v1.17.2（S-10）：lasso 自建页 id 登记（close 淘汰候选的唯一来源）。 */
  private ownPages = new Set<number>();
  private readonly cap: number;

  constructor(cap: number = TAB_CAP_DEFAULT) {
    // hard clamp [1, 20]（parse9 §3.3 + §6.3 验收：cap clamp）
    this.cap = Math.min(Math.max(Math.trunc(cap), CAP_MIN), CAP_MAX);
  }

  /** 当前 cap（测试用）。 */
  getCap(): number {
    return this.cap;
  }

  /** 当前 tab 数。 */
  size(): number {
    return this.tabs.size;
  }

  // ============================================================
  // own 页登记（v1.17.2 S-10 所有权机械化）
  // ============================================================
  /**
   * 登记 lasso 自建页（LoggedInChannel.ensureOwnPageSelected 创建并选中后调）。
   * reconcile 只触达/淘汰已登记页——「close_page 只可能落在 lasso 自己开的
   * tab 上」由登记集合的定义保证（用户 tab 无登记路径，类型层面进不了候选）。
   */
  noteOwnPage(pageId: number): void {
    this.ownPages.add(pageId);
  }

  /**
   * 清空 own 登记（上游 (re)spawn 时调——id 计数器随进程重置，陈旧 id 作废；
   * 与 LoggedInChannel.lastClient 实例变更联动）。
   */
  resetOwnPages(): void {
    this.ownPages.clear();
  }

  // ============================================================
  // reconcile（parse9 §3.3；v1.17.2 S-10 重订契约）
  // ============================================================
  /**
   * 从 list_pages 同步 lasso 操作面 → 触达 → 修剪已关页 → 淘汰超限。
   *
   * 调用方：LoggedInChannel.getMcpClient() 末尾，每次 ensureRunning 后调一次。
   *
   * 流程（v1.17.2 S-10）：
   *  1. 调 chrome-devtools-mcp `list_pages`，解析 `{pageId, url, selected}` 条目
   *     （parseUpstreamPageEntries；解析不出 → 本轮保守 no-op）
   *  2. **只触达已登记 own 页**（noteOwnPage 登记 = lasso 创建的页；用户 tab
   *     无登记路径，进不了淘汰候选——所有权机械化。selected 是上游 context
   *     指针，用户在自己窗口里切 tab 不影响该标记）
   *  3. 修剪：册内 pageId 已不在当前列表的（页已自然关闭）→ 移除
   *  4. while size > cap: 最老 own 页 → `close_page {pageId}`（1.7.0 wire 契约）
   *     → 从 Map 删。被淘汰者恒非当前 selected（selected 每轮 reconcile 先触达、
   *     必在 MRU 尾，LRU 头取不到它——顺序保证，无死码守卫）
   *
   * @returns reaped: 本轮从册中移除的 pageId（字符串形态；含已关页修剪 + 超限淘汰）；
   *          kept: 淘汰后剩余 tab 数
   */
  async reconcile(client: McpClient): Promise<{ reaped: string[]; kept: number }> {
    const r = (await client.callTool("list_pages", {})) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (r.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    const entries = parseUpstreamPageEntries(text);
    if (entries === null) {
      // 空响应 / 上游格式漂移 → 保守 no-op（宁可不淘汰；失败方向良性）
      logger.warn({ evt: "tab_reconcile_unparseable_list", note: "skip this round" });
      return { reaped: [], kept: this.tabs.size };
    }
    // 触达（MRU 提升）：只认已登记 own 页（selected 且在 ownPages 集内）
    for (const e of entries.filter((x) => x.selected && this.ownPages.has(x.pageId))) {
      this.tabs.delete(e.pageId);
      this.tabs.set(e.pageId, { url: e.url, lastUsedAt: Date.now() });
    }
    // 修剪：已不在当前列表的 pageId（页已自然关闭 / 上游 respawn id 重置）
    const listedIds = new Set(entries.map((e) => e.pageId));
    const reaped: string[] = [];
    for (const id of [...this.tabs.keys()]) {
      if (!listedIds.has(id)) {
        this.tabs.delete(id);
        reaped.push(String(id));
      }
    }
    // 淘汰（LRU：最老 = Map 首位；close_page {pageId} = 1.7.0 wire 契约，S-10 修复）
    // reaped 统计所有从 registry 移除的 tab（不论 close_page 是否成功——
    // tab 可能已自然关闭，close 抛错时仍要从 Map 删 + 计入 reaped）
    while (this.tabs.size > this.cap) {
      const oldest = this.tabs.keys().next().value;
      if (oldest === undefined) break;
      this.tabs.delete(oldest);
      reaped.push(String(oldest));
      try {
        await client.callTool("close_page", { pageId: oldest });
      } catch {
        // close 失败（tab 已自然关闭）→ 静默；registry 已删 + 已计入 reaped
      }
    }
    return { reaped, kept: this.tabs.size };
  }

  // ============================================================
  // 测试辅助
  // ============================================================
  /**
   * 测试用：直接触达 pageId（不经 list_pages）；用于 vitest 单测验证 MRU 提升。
   * 生产路径应经 reconcile(client)，本方法仅供单测。
   */
  _touchForTests(pageId: number, url = ""): void {
    this.tabs.delete(pageId);
    this.tabs.set(pageId, { url, lastUsedAt: Date.now() });
  }

  /** 测试用：检查某 pageId 是否仍在 registry。 */
  _hasForTests(pageId: number): boolean {
    return this.tabs.has(pageId);
  }
}
