/**
 * 进程级 run_id（parse1 §2 util/run-id.ts）
 *
 * 启动时生成一次 UUID，进程内复用。所有 state-store 写盘路径都挂在
 * ~/.cache/lasso/<run_id>/ 下，进程退出后便于回放/清理。
 */
import { randomUUID } from "node:crypto";

let cached: string | null = null;

/** 返回进程级 run_id（首次调用生成，之后复用同一 UUID）。 */
export function newRunId(): string {
  if (!cached) cached = randomUUID();
  return cached;
}

/** 测试用：强制重置（生产代码不要调）。 */
export function _resetRunIdForTests(): void {
  cached = null;
}
