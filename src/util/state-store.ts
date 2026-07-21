/**
 * Lasso 状态存储（v0.1 单磁盘 → v0.3 LRU + stateId + AsyncLocalStorage 双路径）
 *
 *  - v0.1 路径：writeState(channel, stateId, data) → 落盘 ~/.cache/lasso/<run_id>/<channel>-<stateId>.json
 *  - v0.3 新增：
 *      class StateStore<T>     —— 内存 LRU(128) + 磁盘 spill 双写
 *      withOperation()/currentOperation() —— AsyncLocalStorage 请求级 hydrate
 *      StaleStateError         —— 过期 stateId cleanly fail
 *
 * 兼容策略（parse3 §3.3 + §4.4）：v0.2 测试零改动。
 *  - writeState/readState 旧签名保留（内部转调新 API + 双写磁盘）
 *  - BrowseChannel v0.2 路径不变；StepEngine v0.3 直接用 StateStore 类
 *
 * 借鉴源（12 §1.1A 源码级）：
 *  - injaneity src/runtime.ts StateStore<T>:
 *      Map<stateId, StoredState<T>>, limit=128
 *      set 时 delete+set 把记录挪到 MRU 端
 *      超容量时 keys().next().value 取最老删之（LRU）
 *      StoredState = { stateId: randomUUID(), resourceKey, epoch, value: T }
 *  - injaneity src/state.ts SavedStates 叠 AsyncLocalStorage<OperationState>:
 *      每次 .run() 进上下文；hydrate(record) 把 StoredState 还原成
 *      请求局部的 OperationState
 *
 * INV-12（parse3 §5.3）：BrowseChannel.browse()/runChain() 入口必须经 withOperation() 包裹。
 * epoch 字段保留但 v0.3 不启用 ResourceScheduler（parse3 §4.3 推迟）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ============================================================
// v0.1 兼容：磁盘 cache 上下文
// ============================================================
export interface StateStoreContext {
  runId: string;
  cacheDir?: string;
}

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "lasso");

let runtime: StateStoreContext = {
  runId: "unset",
  cacheDir: DEFAULT_CACHE_DIR,
};

/** 进程启动时由 index.ts 调一次，注入 run_id 和可选 cache 目录。 */
export function setStateStoreContext(ctx: StateStoreContext): void {
  runtime = {
    runId: ctx.runId,
    cacheDir: ctx.cacheDir ?? DEFAULT_CACHE_DIR,
  };
}

export function getStateStoreContext(): StateStoreContext {
  return runtime;
}

// ============================================================
// v0.3：StoredState + StateStore<T> LRU(128) + ALS
// ============================================================
/**
 * StoredState：StateStore 内部记录形状。
 *  - stateId    : UUID（短指针回传 CC）
 *  - resourceKey: "browse_logged_in:9222:tabA" / "browse_headless:session1"（session 复用键）
 *  - epoch      : 每次 navigate 自增；v0.5+ 才接 ResourceScheduler stale-reject
 *  - value      : BrowseResult 的 partial 字段
 *  - spillPath  : 大对象落盘路径（跨进程恢复用）
 *  - capturedAt : epoch ms
 */
export interface StoredState<T = unknown> {
  stateId: string;
  resourceKey: string;
  epoch: number;
  value: T;
  spillPath?: string;
  capturedAt: number;
}

/** LRU 容量上限（与 injaneity runtime.ts 对齐）。 */
const LIMIT = 128;

/**
 * 全局 LRU Map（按插入序：首位 = LRU，末位 = MRU）。
 *
 * 单例：StateStore 类只是面向对象的 facade，背后共享此 Map（v0.3 设计简化）。
 * 同 process 内所有 channel 共用一个 store —— resourceKey 防跨 channel 误命中。
 */
const globalStore = new Map<string, StoredState>();

/**
 * AsyncLocalStorage：每个 MCP 请求 hydrate 出请求局部 OperationState。
 *
 * INV-12：BrowseChannel.browse()/runChain() 入口必须经 withOperation() 包裹。
 * 09 §2.3 验收 5：并发 2 session AsyncLocalStorage 隔离率 100%。
 */
export interface OperationState {
  resourceId: string;
  epoch: number;
  /** 最近一次 observe 的 stateId（同一请求内复用） */
  stateId?: string;
}

const als = new AsyncLocalStorage<OperationState>();

/**
 * StateStore<T>：内存 LRU(128) + 磁盘双写 facade。
 *
 * 设计要点（与 injaneity runtime.ts StateStore 对齐）：
 *  - get 时 delete+set 把记录挪到 MRU 端
 *  - set 时若超容量，keys().next().value 取最老删之
 *  - spillPath 字段提供磁盘 fallback；内存命中时不读盘
 */
export class StateStore<T = unknown> {
  /**
   * 取记录 + MRU 提升（runtime.ts set 时 delete+set）。
   */
  get(stateId: string): StoredState<T> | undefined {
    const rec = globalStore.get(stateId);
    if (rec) {
      // MRU 提升：删了再 set，挪到 Map 末位
      globalStore.delete(stateId);
      globalStore.set(stateId, rec);
    }
    return rec as StoredState<T> | undefined;
  }

  /**
   * 写入 + LRU 淘汰（runtime.ts keys().next().value）。
   *  - stateId     : 由调用方生成（UUID）或外部传入
   *  - value       : BrowseResult 的 partial 字段
   *  - resourceKey : session 复用键
   *  - spillPath   : 大对象落盘路径（可选，跨进程恢复）
   */
  set(
    stateId: string,
    value: T,
    resourceKey: string,
    spillPath?: string,
  ): StoredState<T> {
    // epoch 从 ALS 取（同请求内自增；无 ALS 上下文 → 0）
    const epoch = (als.getStore()?.epoch ?? 0) + 1;
    const rec: StoredState<T> = {
      stateId,
      resourceKey,
      epoch,
      value,
      spillPath,
      capturedAt: Date.now(),
    };
    // MRU：先 delete 再 set（同时清理同 key 老记录）
    globalStore.delete(stateId);
    globalStore.set(stateId, rec);

    // LRU 淘汰：超容量时删首位（最老）
    while (globalStore.size > LIMIT) {
      const oldest = globalStore.keys().next().value;
      if (oldest === undefined) break;
      globalStore.delete(oldest);
    }

    // 同步 ALS 上下文的 stateId（便于复用检测）
    const op = als.getStore();
    if (op) op.stateId = stateId;

    return rec;
  }

  /**
   * 过期 stateId cleanly fail（不抛 unknown 异常；09 §2.3 验收 5）。
   */
  getOrThrow(stateId: string): StoredState<T> {
    const r = this.get(stateId);
    if (!r) throw new StaleStateError(`stateId expired or unknown: ${stateId}`);
    return r;
  }

  /** 当前 store 大小（调试 / 测试用）。 */
  size(): number {
    return globalStore.size;
  }

  /** 仅测试用：清空全局 store。生产代码勿调。 */
  _clearForTests(): void {
    globalStore.clear();
  }
}

/**
 * StaleStateError：过期/未知 stateId 抛此类型（区别于其他运行时错）。
 */
export class StaleStateError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "StaleStateError";
  }
}

// ============================================================
// AsyncLocalStorage API
// ============================================================
/**
 * 请求级 hydrate（12 §1.1A：ALS .run() + hydrate）。
 *
 * 用法（BrowseChannel 入口）：
 *   return withOperation("browse_logged_in:9222:tabA", 0, async () => {
 *     // 此处 currentOperation() 可拿到 { resourceId, epoch }
 *     return await this.stepEngine.runChain(url, steps);
 *   });
 *
 * INV-12：BrowseChannel.browse()/runChain() 必须经此包裹。
 */
export function withOperation<T>(
  resourceId: string,
  epoch: number,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run({ resourceId, epoch }, fn);
}

/** 当前请求的 OperationState（无 ALS 上下文返回 undefined）。 */
export function currentOperation(): OperationState | undefined {
  return als.getStore();
}

// ============================================================
// v0.1 兼容：writeState / readState 旧签名保留
// ============================================================
/**
 * 写一个 channel 的状态快照（v0.1/v0.2 旧接口）。
 *  - channel : "browse_headless" / "browse_logged_in" / ...
 *  - stateId : UUID（由 channel 生成，作为短指针回传给 CC）
 *  - data    : BrowseResult 的 partial 字段
 * 返回写入文件的绝对路径。
 *
 * v0.3 内部转调 StateStore + 双写磁盘（parse3 §3.3）。
 * @deprecated v0.3 后改走 StateStore.set；保留 v0.2 调用方（INV：v0.2 349 tests 不改 1 行）
 */
export async function writeState(
  channel: string,
  stateId: string,
  data: Record<string, unknown>,
): Promise<string> {
  // 1. 内存 LRU 写入（resourceKey = channel，spillPath 待磁盘写完回填）
  const ss = new StateStore();
  const resourceKey = channel;
  // 2. 磁盘双写（跨进程恢复用，F3.2.10 保留磁盘）
  const diskPath = await writeStateToDisk(channel, stateId, data);
  ss.set(stateId, data, resourceKey, diskPath);
  return diskPath;
}

/** 回读 state（用于测试 / CC 显式拉取完整快照）。 */
export async function readState(contentPath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(contentPath, "utf8"));
}

// ============================================================
// 磁盘写盘 helper（v0.1 逻辑原样保留）
// ============================================================
/**
 * v0.1 磁盘写盘实现（parse3 §4.4：保留磁盘 fallback）。
 * 写到 ~/.cache/lasso/<run_id>/<channel>-<stateId>.json
 */
async function writeStateToDisk(
  channel: string,
  stateId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const dir = path.join(runtime.cacheDir ?? DEFAULT_CACHE_DIR, runtime.runId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${channel}-${stateId}.json`);
  const payload = {
    channel,
    state_id: stateId,
    saved_at: new Date().toISOString(),
    ...data,
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

// ============================================================
// 测试辅助
// ============================================================
/**
 * 重置全局 LRU Map（仅 vitest 单测调用）。
 * 生产路径下 BrowseChannel 应该把 store 当成长期缓存。
 */
export function _resetStoreForTests(): void {
  globalStore.clear();
}

/**
 * 生成新 UUID（v0.3 公开给 BrowseChannel v0.3 路径用；v0.2 路径仍用 node:crypto.randomUUID）。
 */
export function newStateId(): string {
  return randomUUID();
}
