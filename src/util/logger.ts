/**
 * 结构化日志（parse1 §2 util/logger.ts）
 *
 * 全部走 console.error（stderr）—— MCP stdio 协议在 stdout，stderr 不污染。
 * 每行一个 JSON，便于 grep/jq。`fallback_used` 等关键字段由调用方透传。
 */
export type LogLevel = "info" | "warn" | "error";

export interface LogEntry extends Record<string, unknown> {
  level: LogLevel;
  ts: string;
  msg?: string;
}

function emit(level: LogLevel, entry: Record<string, unknown>): void {
  const line: LogEntry = { level, ts: new Date().toISOString(), ...entry };
  console.error(JSON.stringify(line));
}

export const logger = {
  info: (entry: Record<string, unknown>) => emit("info", entry),
  warn: (entry: Record<string, unknown>) => emit("warn", entry),
  error: (entry: Record<string, unknown>) => emit("error", entry),
};
