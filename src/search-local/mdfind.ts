/**
 * search_local 源 2：mdfind / Spotlight 文件搜索（B1 第四通道，parse24 §5.3）
 *
 * **为什么存在**：「本地那个 PDF 在哪」——Spotlight 已建好全盘索引，
 * mdfind 是零依赖查询面（decision-B F1：组件成熟）。
 *
 * **隐私红线（INV-81 钉死）**：
 *  - 只读元数据：输出 { path, modified_at? }——**不读文件内容**（stat 只取 mtime）；
 *  - 日志只记 query_len，永不记查询原文与结果集（INV-81(e)）；
 *  - 零网络调用（INV-81(d)）；子进程经异步 execFile（P31 移交2，2026-10-26——
 *    search_local 工具在 server 进程可达，spawnSync 5s 上限冻结事件循环）。
 *
 * **诚实降级**：非 darwin → didnt + reason:"mdfind_darwin_only"（不伪装空结果）；
 * mdfind 非零退 / maxBuffer 超限 → didnt + 原因；0 行 → didnt + no_matches。
 *
 * **过渡红利（parse24 §5.3）**：Spotlight 索引 Apple Notes 标题
 * （com.apple.notes）——files 源天然覆盖部分笔记**标题**搜索，
 * 是 §5.4 Notes 全文源推迟到 v2 的过渡缓解。
 *
 * 借鉴：launcher/chrome-hide.ts（execFn 注入范式）；bootstrap.ts（P31 异步形态）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";

/** bootstrap.ts:29 同款先例（P31 形态：server 可达路径异步 execFile）。 */
const execFileP = promisify(execFile);
import type { InteractResult } from "../types.js";
import { logger } from "../util/logger.js";

// ============================================================
// 输出形状（隐私红线落地：只有路径 + mtime，无内容）
// ============================================================

/** 单条文件命中 —— INV-81(b)：只有路径与时间，禁加内容类字段 */
export interface MdfindHit {
  /** 文件绝对路径（mdfind 输出行） */
  path: string;
  /** 文件 mtime（ISO 8601；stat 失败/权限不可及 → 省略，不伪装） */
  modified_at?: string;
}

export interface MdfindData {
  source: "files";
  /** 返回条数（≤ limit） */
  count: number;
  results: MdfindHit[];
}

// ============================================================
// 依赖注入（测试零真机依赖）
// ============================================================

export interface MdfindExecResult {
  status: number | null;
  stdout: string;
}

export interface MdfindDeps {
  /** 平台覆盖（默认 process.platform） */
  platform?: string;
  /** mdfind 执行器注入（默认异步 execFile；测试 mock 点——返回 Promise 或裸
   * 结果均可，launch-chrome.ts:153 P31 先例同款联合形态） */
  execFn?: (args: string[]) => MdfindExecResult | Promise<MdfindExecResult>;
  /** stat 注入（默认 fs.statSync；返回 ms 时间戳） */
  statFn?: (path: string) => { mtimeMs: number };
}

export interface MdfindQuery {
  query: string;
  limit: number;
}

// ============================================================
// 入口：searchMdfind
// ============================================================

export async function searchMdfind(
  q: MdfindQuery,
  deps: MdfindDeps = {},
): Promise<InteractResult<MdfindData>> {
  const platform = deps.platform ?? process.platform;
  const notReady = (error: string, data: MdfindData | null = null): InteractResult<MdfindData> => ({
    outcome: "didnt",
    data,
    served_by: "search_local",
    fallback_used: false,
    retrieval_method: "spotlight_mdfind",
    error,
  });

  if (platform !== "darwin") {
    return notReady("mdfind_darwin_only");
  }

  // P31 移交2（2026-10-26）：spawnSync → 异步 execFile。catch 映射回
  // MdfindExecResult：非零退出 err.code=数字 → status=N（保 mdfind_exit_N 诚实
  // 错误串形态，search-local.spec:387 钉死）；ENOENT/超时（SIGKILL）→ null →
  // mdfind_exit_null。timeout 5s / maxBuffer 1MB 原值（parse24 §5.3 上限）。
  const execFn =
    deps.execFn ??
    (async (args: string[]) => {
      try {
        const r = await execFileP("mdfind", args, {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 1024 * 1024, // 1MB（parse24 §5.3 上限）
          killSignal: "SIGKILL",
        });
        return { status: 0, stdout: String(r.stdout ?? "") };
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        return { status: typeof code === "number" ? code : null, stdout: "" };
      }
    });

  const r = await execFn([q.query]);
  if (r.status !== 0) {
    return notReady(`mdfind_exit_${r.status ?? "null"}`);
  }

  // 行 = 文件路径；去空行 + 去重（Spotlight 可能重复行）+ 截 limit
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const p = line.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
    if (paths.length >= q.limit) break;
  }

  const statFn = deps.statFn ?? ((p: string) => statSync(p));
  const results: MdfindHit[] = paths.map((p) => {
    try {
      const st = statFn(p);
      return { path: p, modified_at: new Date(st.mtimeMs).toISOString() };
    } catch {
      // stat 不可及（权限/竞态删除）——保留路径、省略时间（不吞条目）
      return { path: p };
    }
  });

  logger.info({ evt: "search_local_mdfind_done", query_len: q.query.length, hits: results.length });

  if (results.length === 0) {
    return notReady("no_matches");
  }

  return {
    outcome: "worked",
    data: { source: "files", count: results.length, results },
    served_by: "search_local",
    fallback_used: false,
    retrieval_method: "spotlight_mdfind",
  };
}
