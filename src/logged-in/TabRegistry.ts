/**
 * TabRegistry.ts（v0.8 parse9 §3.3）—— 多 tab LRU 管理（≤10 hard cap）
 *
 * 防爆炸场景（parse9 §4.3）：CC 反复 navigate 不同 URL，chrome-devtools-mcp
 * 默认每 URL 留一个 tab；100 次后 Chrome 内存爆。本类守 ≤10，超限 LRU
 * 淘汰最老 tab（close_page）。
 *
 * 复用范式（INV-50）：
 *  - LRU Map<tabId, { url, lastUsedAt }>（同 state-store.ts StateStore LRU(128)）
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
 * tab LRU 管理（parse9 §3.3）。
 *
 * 一个 TabRegistry 实例对应一个 channel（LoggedInChannel）；多 profile 场景
 * 每 profile 一个独立 TabRegistry 实例（profile 物理隔离 → tab 不跨 profile）。
 */
export class TabRegistry {
  private tabs = new Map<string, TabMeta>();
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
  // reconcile（parse9 §3.3）
  // ============================================================
  /**
   * 从 list_pages 同步 tab 列表 → 触达所有 → 淘汰超限。
   *
   * 调用方：LoggedInChannel.getMcpClient() 末尾，每次 ensureRunning 后调一次。
   *
   * 流程：
   *  1. 调 chrome-devtools-mcp `list_pages` 拿 tab 列表
   *  2. parse URL（match `https?://\S+`）
   *  3. 触达（已存在 → delete + set MRU 提升；新 url → set）
   *  4. while size > cap: 最老 tab → close_page → 从 Map 删
   *
   * @returns reaped: 被淘汰的 tab id 列表；kept: 淘汰后剩余 tab 数
   */
  async reconcile(client: McpClient): Promise<{ reaped: string[]; kept: number }> {
    const r = (await client.callTool("list_pages", {})) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (r.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    // 触达（MRU 提升）：delete + set 把记录挪到 Map 末位
    // （同 state-store.ts StateStore LRU(128) 范式；首位 = LRU）
    for (const url of urls) {
      const id = urlToTabId(url);
      this.tabs.delete(id);
      this.tabs.set(id, { url, lastUsedAt: Date.now() });
    }
    // 淘汰（LRU：最老 = Map 首位）
    // reaped 统计所有从 registry 移除的 tab（不论 close_page 是否成功 ——
    // tab 可能已自然关闭，close 抛错时仍要从 Map 删 + 计入 reaped）
    const reaped: string[] = [];
    while (this.tabs.size > this.cap) {
      const oldest = this.tabs.keys().next().value;
      if (!oldest) break;
      const meta = this.tabs.get(oldest)!;
      this.tabs.delete(oldest);
      reaped.push(oldest);
      try {
        await client.callTool("close_page", { url: meta.url });
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
   * 测试用：直接触达 URL（不经 list_pages）；用于 LRU 行为单测。
   * 生产路径应经 reconcile(client)，本方法仅供 vitest 单测验证 MRU 提升。
   */
  _touchForTests(url: string): void {
    const id = urlToTabId(url);
    this.tabs.delete(id);
    this.tabs.set(id, { url, lastUsedAt: Date.now() });
  }

  /** 测试用：检查某 url 是否仍在 registry。 */
  _hasForTests(url: string): boolean {
    return this.tabs.has(urlToTabId(url));
  }
}

// ============================================================
// helpers
// ============================================================
/**
 * URL → tab id（djb2 短哈希；与 BrowseChannel.parseListPages 同档；parse9 §4.3）。
 *
 * 32-bit hash → 8 hex 字符；<1e-9 碰撞概率（接受；v0.9+ 用真实 tabId）。
 */
function urlToTabId(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
