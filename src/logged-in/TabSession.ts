/**
 * TabSession.ts（v1.9 parse17 §4.2 机制三 —— logged_in tab 快照+diff 恢复）
 *
 * 设计原理：快照+diff，不动 TabRegistry。
 *  - TabRegistry 的 LRU≤10 是**运行中防爆**语义（parse9 §4.3），「恢复原列表」是
 *    **会话收尾**语义——生命周期不同（前者每次 getMcpClient 触发，后者一次会话一次）、
 *    数据模型不同（LRU 用 URL 哈希 id，恢复需要真实 targetId——/json/list 才给）。
 *    塞进同一个类会把两种语义搅在一起。故本类独立存在，TabRegistry 一行不动。
 *
 * 红线机械化：restore() 的关闭目标**只来自 diff**（当前 page targets − 快照 targetId
 * 集）——快照内 targetId 在类型层面就进不了关闭列表，「绝不关闭用户原有的任何 tab」
 * 由 diff 的定义保证，而非靠运行时判断。
 *
 * 三守卫（宁少关不误关）：
 *  1. CDP 不可达（网络错/非 200）→ cdp_unreachable，放弃不硬来
 *  2. Chrome 重启形态（当前 page url 集 ∩ 快照 url 集 == ∅ 且双方非空）→
 *     browser_restarted——快照内 tab 已随旧 Chrome 消失，现存 tab 全部视为用户
 *     新开的（诚实声明：若 Lasso 把用户原 tab 全 navigate 走且没开新 tab 也会触发，
 *     保守性可接受）
 *  3. diff > maxDiff(32) → diff_too_large——异常大 diff 视为快照错位，不批量关
 *
 * INV-52 合规：TabSession 只读 /json/list + 关闭 diff tab，**不触碰任何 cookie 路径**。
 *
 * restore() 永不 throw（红线）——所有失败路径走 TabRestoreResult。
 */
import { CdpClient } from "./CdpClient.js";
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
/** 快照条目（/json/list 的 page target 子集）。 */
export interface TabSnapshotEntry {
  targetId: string;
  url: string;
}

export type TabRestoreFailureReason =
  | "no_snapshot"
  | "cdp_unreachable"
  | "browser_restarted"
  | "diff_too_large";

export interface TabRestoreResult {
  ok: boolean;
  /** 成功关闭的 targetId（只含快照后新增的）。 */
  closed: string[];
  reason?: TabRestoreFailureReason;
}

/** fetch 返回的最小面（与 Response 同构；测试 mock 注入用）。 */
interface FetchLikeResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

export interface TabSessionOptions {
  /** 测试注入：mock /json/list 与 /json/close（默认 global fetch + 2s 超时）。 */
  fetchFn?: (url: string) => Promise<FetchLikeResponse>;
  /** 测试注入：fallback CDP Target.closeTarget（默认 CdpClient）。 */
  closeFn?: (targetId: string) => Promise<boolean>;
  /** diff 上限（默认 32；超过视为快照错位放弃）。 */
  maxDiff?: number;
}

// ============================================================
// TabSession
// ============================================================
export class TabSession {
  private snapshot: TabSnapshotEntry[] | null = null;
  private readonly fetchFn: (url: string) => Promise<FetchLikeResponse>;
  private readonly closeFn: (targetId: string) => Promise<boolean>;
  private readonly maxDiff: number;

  constructor(
    private readonly cdpPort: number,
    opts: TabSessionOptions = {},
  ) {
    this.fetchFn = opts.fetchFn ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(2_000) }));
    this.closeFn = opts.closeFn ?? defaultCloseFn(cdpPort);
    this.maxDiff = opts.maxDiff ?? 32;
  }

  /**
   * 首次附着快照（本 server 生命周期内第一次 getMcpClient 调）。
   * 已有快照 → no-op；失败 → warn 放弃（下次 getMcpClient 重试）。
   * 只记 type==="page" 的 target（background_page / iframe / worker 不进快照不打 diff）。
   */
  async takeSnapshotIfAbsent(): Promise<void> {
    if (this.snapshot !== null) return;
    const list = await this.listPages();
    if (list === null) {
      logger.warn({
        evt: "tab_snapshot_failed",
        cdp_port: this.cdpPort,
        note: "will retry on next attach",
      });
      return;
    }
    this.snapshot = list;
    logger.info({
      evt: "tab_snapshot_taken",
      cdp_port: this.cdpPort,
      tabs: list.length,
    });
  }

  /**
   * 恢复原 tab 列表：关闭快照后新增的 page target（永不 throw）。
   * 成功后 snapshot 置 null（下次附着重新快照 = 新会话基线）。
   */
  async restore(): Promise<TabRestoreResult> {
    // 1. 无快照 → no-op 失败
    if (this.snapshot === null) {
      return { ok: false, closed: [], reason: "no_snapshot" };
    }
    const snapshot = this.snapshot;
    // 2. 当前列表（CDP 不可达 → 守卫 1）
    const current = await this.listPages();
    if (current === null) {
      logger.warn({ evt: "tab_restore_result", ok: false, reason: "cdp_unreachable", cdp_port: this.cdpPort });
      return { ok: false, closed: [], reason: "cdp_unreachable" };
    }
    // 3. Chrome 重启守卫（url 零交集 + 双方非空 → 守卫 2）
    const snapshotUrls = new Set(snapshot.map((t) => t.url));
    const overlap = current.some((t) => snapshotUrls.has(t.url));
    if (!overlap && snapshotUrls.size > 0 && current.length > 0) {
      logger.warn({
        evt: "tab_restore_result",
        ok: false,
        reason: "browser_restarted",
        cdp_port: this.cdpPort,
        snapshot_tabs: snapshot.length,
        current_tabs: current.length,
      });
      return { ok: false, closed: [], reason: "browser_restarted" };
    }
    // 4. diff（只关快照后新增；守卫 3 异常大 diff 放弃）
    const snapshotIds = new Set(snapshot.map((t) => t.targetId));
    const diff = current.filter((t) => !snapshotIds.has(t.targetId));
    if (diff.length > this.maxDiff) {
      logger.warn({
        evt: "tab_restore_result",
        ok: false,
        reason: "diff_too_large",
        cdp_port: this.cdpPort,
        diff: diff.length,
        targets: diff.map((t) => t.targetId).slice(0, 8),
        note: "manual cleanup advised; snapshot may be misaligned",
      });
      return { ok: false, closed: [], reason: "diff_too_large" };
    }
    // 5. 逐个关闭 diff 内 targetId：主路径 /json/close/<id>（Chrome DevTools HTTP
    //    端点，已废弃但仍工作——R-INT-08 外部契约），失败 fallback CDP
    //    Target.closeTarget（WebSocket browser 级）。单个失败 warn 继续（部分恢复
    //    优于全放弃）。
    const closed: string[] = [];
    for (const t of diff) {
      let ok = false;
      try {
        const r = await this.fetchFn(`http://127.0.0.1:${this.cdpPort}/json/close/${t.targetId}`);
        ok = r.ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        try {
          ok = await this.closeFn(t.targetId);
        } catch (e) {
          logger.warn({ evt: "tab_close_failed", targetId: t.targetId, error: String(e) });
        }
      }
      if (ok) closed.push(t.targetId);
      else logger.warn({ evt: "tab_close_failed", targetId: t.targetId, note: "both /json/close and Target.closeTarget failed" });
    }
    // 6. 快照消费掉（下次附着重新快照 = 新会话基线）
    this.snapshot = null;
    logger.info({
      evt: "tab_restore_result",
      ok: true,
      closed: closed.length,
      cdp_port: this.cdpPort,
    });
    return { ok: true, closed };
  }

  /** 快照是否已存在（admin/doctor 观测用）。 */
  hasSnapshot(): boolean {
    return this.snapshot !== null;
  }

  /**
   * v1.10（parse18 §4.3 机制三）：当前 page target 列表（公开只读探针）。
   * LoggedInChannel 预建 background tab 前判定「零 page target」用；
   * 失败返 null（与 restore 守卫 1 同语义）。
   */
  async listPageTargets(): Promise<TabSnapshotEntry[] | null> {
    return this.listPages();
  }

  /** 读 /json/list → filter type==="page"；失败返 null（调用方决定放弃/重试）。 */
  private async listPages(): Promise<TabSnapshotEntry[] | null> {
    let r: FetchLikeResponse;
    try {
      r = await this.fetchFn(`http://127.0.0.1:${this.cdpPort}/json/list`);
      if (!r.ok) return null;
      const body = (await r.json()) as unknown;
      if (!Array.isArray(body)) return null;
      const out: TabSnapshotEntry[] = [];
      for (const item of body) {
        if (item === null || typeof item !== "object") continue;
        const t = item as Record<string, unknown>;
        if (t.type !== "page") continue; // background_page / iframe / worker 不算 tab
        if (typeof t.id !== "string" || typeof t.url !== "string") continue;
        out.push({ targetId: t.id, url: t.url });
      }
      return out;
    } catch {
      return null;
    }
  }
}

/** 默认 fallback closer：CdpClient（裸 WebSocket browser 级 Target.closeTarget）。 */
function defaultCloseFn(cdpPort: number): (targetId: string) => Promise<boolean> {
  return async (targetId: string) => {
    const cdp = new CdpClient(cdpPort);
    try {
      return await cdp.closeTarget(targetId);
    } finally {
      await cdp.close();
    }
  };
}
