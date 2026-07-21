/**
 * 页面状态写盘（parse1 §2 util/state-store.ts，v0.1 简化版）
 *
 * v0.1：channel 把 BrowseResult 部分字段序列化成 JSON 写到
 *   ~/.cache/lasso/<run_id>/<channel>-<state_id>.json
 * 返回 content_path（绝对路径）给 InteractResult。
 *
 * token 经济学：CC 收到的 BrowseResult 只带 ≤1k tokens 的 preview + 一个
 * state_id 短指针；需要完整快照时再让 CC 读 content_path（不走 LLM context）。
 *
 * v0.3 升级：内存 LRU + stateId 反查 + 多种 artifact（HTML/PNG/JSON）。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

/**
 * 写一个 channel 的状态快照。
 *  - channel : "browse_headless" / "browse_logged_in" / ...
 *  - stateId : UUID（由 channel 生成，作为短指针回传给 CC）
 *  - data    : BrowseResult 的 partial 字段
 * 返回写入文件的绝对路径。
 */
export async function writeState(
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

/** 回读 state（用于测试 / CC 显式拉取完整快照）。 */
export async function readState(contentPath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(contentPath, "utf8"));
}
