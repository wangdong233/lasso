/**
 * download tool 注册（v1.30，doc/bugs/12 下载器纳入决议与BT可行性定谳 §四/§五）
 *
 * 形态定案（决议 D1/D2）：单工具 `download(action: start|status|wait|cancel)`
 * action-enum 折叠（admin 正典，INV-17 家族）；独立工具族（fetch_url/search_local
 * 范式），不建 DownloadChannel、不挂 fallback 链（INV-23 caller-tier）。
 *
 * 依赖注入（WT 三分支并行纪律）：store/kill/reconcile（WT-core）与 route/engines
 * （WT-engines）在兄弟 worktree 开发，本文件只 import 契约类型
 * （src/download/types.ts——三 worktree 共享真源），实现细节全部经 DownloadDeps
 * 注入：主循环合并后在 index.ts 调 wireDownloadTools(实装)。**未接线时所有
 * action 诚实返回 didnt "download engine layer not wired (merge pending)"——
 * 宁可 didnt 不可悬空（read_text D1「写好没装配」防线反例的教训）。**
 *
 * 关键决议锚：
 *  - D12/H4：http kind 全量 ssrfGuard（与 fetch_url 同函数同 config，本文件直接
 *    import ssrfGuard）；magnet/torrent 禁走 ssrfGuard 冒充（magnet: 非 http URL，
 *    DHT peer 含私网 IP 是 P2P 设计面）；stream kind 诚实边界（网络面由 yt-dlp
 *    引擎决定，非 ssrfGuard-per-hop）。
 *  - D8/H3：wait timeout_s 帽 ≤120s（zod 与运行时共用 DOWNLOAD_WAIT_TIMEOUT_MAX_S），
 *    超时返 partial 快照 + outcome=unknown 可续轮询——不烧穿 MCP 超时。
 *  - D13：status:"all" 先 reconcileOrphans 再 listTasks（孤儿三件套之「可见」）。
 *  - D16/§二：BT 零 peer 超 60s 报**双因**（死种 OR 区域 ISP DPI 封锁，禁单因断言）
 *    +三出路建议——诊断即功能，input_guard_suspected 同款诚实信号哲学。
 *  - 家法：非法组合显式错 + data.ignored_options 回显（BrowseChannel ignored_options 先例）。
 *
 * 四处联动（决议 §五，防 read_text D1「写好没装配」bug 类）：
 *   本注册器 + index.ts 注册调用 + index.ts V5_TOOL_TO_CHANNEL + descriptions.ts
 *   （+ doc/usage/04 B 表 E17-E19 逐字锚，test/unit/tool-examples-truth.spec.ts）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractResult } from "../types.js";
import { ssrfGuard, ssrfDenial, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { DOWNLOAD_DESCRIPTION } from "./descriptions.js";
import { downloadAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";
import {
  BT_ZERO_PEER_DIAGNOSIS_S,
  DEFAULT_MAX_BYTES,
  DOWNLOAD_WAIT_TIMEOUT_MAX_S,
  type DownloadEngineName,
  type DownloadKind,
  type DownloadKindInput,
  type DownloadState,
  type DownloadTaskRecord,
  type EngineProgressSnapshot,
  type RoutedDownload,
} from "../download/types.js";

// ============================================================
// BT 双因诊断正典文案（决议 §二/D16——禁单因断言；date 是本机实证日）
// ============================================================
export const BT_ZERO_PEER_DIAGNOSIS =
  "zero peers after 60s: dead torrent OR regional-ISP DPI blocking (verified on this network 2026-09-20); legal exits: switch to http/stream source, try IPv6, or different egress";

/** wait 超时 hint（D8：教轮询，不烧穿 MCP 超时）。 */
export const WAIT_TIMEOUT_HINT =
  "poll again with download({action:\"wait\"}) or download({action:\"status\"})";

/** wait 缺省预算（D8 帽 ≤120s；缺省取半，教「短预算多轮」而非一次长等）。 */
const DEFAULT_WAIT_TIMEOUT_S = 60;

/** 终态集合（wait 停止条件；orphaned 非终态——引擎可能仍在跑，等 reconcile 收养）。 */
const TERMINAL_STATES: ReadonlySet<DownloadState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "oversize",
]);

// ============================================================
// Schema（决议 §四工具面契约；describe=L2 层，诚实话术）
// ============================================================
export const downloadSchema = {
  action: z
    .enum(["start", "status", "wait", "cancel"])
    .describe("one of: start | status | wait | cancel"),
  url: z
    .string()
    .min(1)
    .optional()
    .describe(
      "start only: http(s):// URL (http/stream kind), magnet: URI or absolute .torrent path (torrent kind)",
    ),
  kind: z
    .enum(["auto", "http", "stream", "torrent"])
    .optional()
    .describe(
      "default auto — routes: magnet:/.torrent→torrent, yt-dlp extractor sites→stream, else→http",
    ),
  out_dir: z
    .string()
    .optional()
    .describe(
      "default ~/Downloads; must be inside LASSO_DOWNLOAD_DIR_ALLOWLIST (realpath-checked)",
    ),
  filename: z
    .string()
    .optional()
    .describe(
      'must be a bare basename — no "/" or ".." (engine names the file when omitted)',
    ),
  proxy: z
    .string()
    .optional()
    .describe(
      'default auto: LASSO_PROXY → env HTTP(S)_PROXY → off; or "host:port" / "off" verbatim',
    ),
  subs: z
    .boolean()
    .optional()
    .describe(
      "stream kind only: fetch subtitles — json3 word-level source converted to .srt",
    ),
  audio_only: z
    .boolean()
    .optional()
    .describe("stream kind only: extract the audio track"),
  max_conn: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe("http kind only: max connections per server (default 8)"),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "size cap, default 5 GiB — Content-Length precheck + chunked watchdog kills oversize",
    ),
  task_id: z
    .string()
    .optional()
    .describe(
      'status (single task, or "all" — reconciles orphans first, lists deliverable files[]) / wait / cancel',
    ),
  timeout_s: z
    .number()
    .int()
    .positive()
    .max(DOWNLOAD_WAIT_TIMEOUT_MAX_S)
    .optional()
    .describe(
      "wait only: poll budget, default 60, max 120; on timeout returns partial snapshot + outcome unknown — poll again",
    ),
};

export type DownloadArgs = {
  action: "start" | "status" | "wait" | "cancel";
  url?: string;
  kind?: DownloadKindInput;
  out_dir?: string;
  filename?: string;
  proxy?: string;
  subs?: boolean;
  audio_only?: boolean;
  max_conn?: number;
  max_bytes?: number;
  task_id?: string;
  timeout_s?: number;
};

/** 各 action 实际消费的参数键（ignored_options 回显真源——drift-free by construction）。 */
const ACTION_CONSUMED_KEYS: Record<DownloadArgs["action"], ReadonlySet<string>> =
  {
    start: new Set([
      "action",
      "url",
      "kind",
      "out_dir",
      "filename",
      "proxy",
      "subs",
      "audio_only",
      "max_conn",
      "max_bytes",
    ]),
    status: new Set(["action", "task_id"]),
    wait: new Set(["action", "task_id", "timeout_s"]),
    cancel: new Set(["action", "task_id"]),
  };

// ============================================================
// 依赖注入面（WT-core / WT-engines 实装；单测用 fake deps 表驱动）
// ============================================================
export interface EngineSpawnOptions {
  /** 三值原样透传（auto | "host:port" | off）；三级解析在引擎层（D11）。 */
  proxy: string;
  subs: boolean;
  audioOnly: boolean;
  maxConn: number;
}

export interface StartTaskInput {
  source: string;
  kind: DownloadKind;
  engine: DownloadEngineName;
  /** 已通过 assertOutDirAllowed 的规范化目录。 */
  outDir: string;
  filename: string | null;
  proxy: string;
  subs: boolean;
  audioOnly: boolean;
  maxConn: number;
  maxBytes: number;
}

/** 引擎进度快照 + torrent 诊断面（peers 数——决议 D16 的轮询诊断输入）。 */
export type EngineSnapshotWithPeers = EngineProgressSnapshot & {
  peers: number | null;
};

export interface DownloadDeps {
  /** kind=auto 路由（纯函数，types.ts RouteKindFn 契约）。 */
  routeKind(source: string, explicit: DownloadKindInput): RoutedDownload;
  /** filename 归一（types.ts 契约：含 / 或 .. 抛 filename_must_be_basename）。 */
  resolveFilename(filename: string | null | undefined): string | null;
  /** out_dir 白名单校验（realpath 双侧；越界抛 out_dir_not_allowed）。 */
  assertOutDirAllowed(outDir: string): string;
  createTask(input: StartTaskInput): DownloadTaskRecord;
  spawnEngine(record: DownloadTaskRecord, opts: EngineSpawnOptions): void;
  readTask(taskId: string): DownloadTaskRecord | null;
  listTasks(): DownloadTaskRecord[];
  updateTask(
    taskId: string,
    patch: Partial<DownloadTaskRecord>,
  ): DownloadTaskRecord | null;
  /** 杀谓词（四要素）在实装内（D7/H10）；返回是否真杀了活树（已死=false）。 */
  killEngineTree(record: DownloadTaskRecord): boolean;
  /** 孤儿收养（D4/D13）；返回收养数。 */
  reconcileOrphans(): number;
  /** tail 解析 stdioFile 的增量进度（D14 机读协议）；torrent 附 peers 数。 */
  readEngineSnapshot(record: DownloadTaskRecord): EngineSnapshotWithPeers;
}

// ---- 模块级接线（index.ts 合并后 wireDownloadTools(实装)） ----
let deps: DownloadDeps | null = null;

export function wireDownloadTools(d: DownloadDeps): void {
  deps = d;
}

// ============================================================
// 返回形状
// ============================================================
export type DownloadToolData =
  | {
      task_id: string;
      kind: DownloadKind;
      engine: DownloadEngineName;
      out_dir: string;
      state: "starting";
    }
  | { task: DownloadTaskRecord }
  | { reconciled: number; count: number; tasks: DownloadTaskRecord[] }
  | {
      task: DownloadTaskRecord;
      waited_ms: number;
      ignored_options?: string[];
    }
  | {
      cancelled: true;
      task_id: string;
      engine_killed: boolean;
      already?: string;
      ignored_options?: string[];
    }
  | { ignored_options: string[] };

// ============================================================
// 纯 helper（可单测）
// ============================================================
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** `~/...` 展开为 homedir 前缀（展示层归一；白名单判定仍在 assertOutDirAllowed）。 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** proxy 三值合法性（auto | off | host:port[含 IPv6 括号形态]；解析语义在引擎层，D11）。 */
export function isValidProxy(v: string): boolean {
  if (v === "auto" || v === "off") return true;
  return /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._\-]+):\d+$/.test(v);
}

/**
 * BT 零 peer 双因诊断（D16）：torrent 任务、无既有 diagnosis、零 peer、
 * 距 createdAt 超 60s → 返正典文案；否则 null。
 */
export function maybeBtZeroPeerDiagnosis(
  record: DownloadTaskRecord,
  peers: number | null,
  nowMs: number,
): string | null {
  if (record.kind !== "torrent") return null;
  if (record.diagnosis) return record.diagnosis;
  const createdMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  if ((nowMs - createdMs) / 1000 < BT_ZERO_PEER_DIAGNOSIS_S) return null;
  if ((peers ?? 0) > 0) return null;
  return BT_ZERO_PEER_DIAGNOSIS;
}

/** 非终态任务的视图合并（快照数值覆盖 null 位）+ BT 诊断落盘与回显。 */
function enrichTask(
  d: DownloadDeps,
  record: DownloadTaskRecord,
): DownloadTaskRecord {
  if (TERMINAL_STATES.has(record.progress.state ?? "starting")) return record;
  const snap = d.readEngineSnapshot(record);
  // 审查修复批：readEngineSnapshot 挂 poll 副作用（pid 死兜底定谳/max_bytes
  // 守门/idle 硬顶）——触发后磁盘已是终态，重读拿定谳结果（view 禁止用旧态）
  const finalized = d.readTask(record.taskId);
  if (finalized !== null && TERMINAL_STATES.has(finalized.progress.state ?? "starting")) {
    return finalized;
  }
  const view: DownloadTaskRecord = {
    ...record,
    progress: {
      state: record.progress.state,
      progress: snap.progress ?? record.progress.progress,
      speedBps: snap.speedBps ?? record.progress.speedBps,
      etaSec: snap.etaSec ?? record.progress.etaSec,
      downloadedBytes: snap.downloadedBytes ?? record.progress.downloadedBytes,
      totalBytes: snap.totalBytes ?? record.progress.totalBytes,
    },
  };
  // 进度写回（复审 #2 P0 定罪修复）：解析出的数值持久化进任务表——
  // (a) enforceMaxBytes 的输入源（detached 路守门此前结构性不可达：登记时
  //     写 null 后无人更新，10GiB+5GiB 帽静默完整下载）；
  // (b) updatedAt 随写刷新 = idle 硬顶的活跃语义（活跃任务不该被 24h 硬顶
  //     杀——死任务无人 enrich，updatedAt 不动，硬顶照杀——语义自洽）。
  // 数值有变才写（避免 status 高频空写）。
  if (
    view.progress.downloadedBytes !== record.progress.downloadedBytes ||
    view.progress.totalBytes !== record.progress.totalBytes ||
    view.progress.progress !== record.progress.progress
  ) {
    d.updateTask(record.taskId, { progress: view.progress });
  }
  const diagnosis = maybeBtZeroPeerDiagnosis(view, snap.peers, Date.now());
  if (diagnosis && !record.diagnosis) {
    // 首诊落盘（跨会话可见）；已诊断不重复写
    d.updateTask(record.taskId, { diagnosis });
  }
  if (diagnosis) view.diagnosis = diagnosis;
  return view;
}

function envelope<T extends DownloadToolData>(
  outcome: InteractResult<T>["outcome"],
  data: T | null,
  retrievalMethod: string,
  error?: string,
  hint?: string,
): InteractResult<T> {
  return {
    outcome,
    data,
    served_by: "download",
    fallback_used: false,
    retrieval_method: retrievalMethod,
    ...(error ? { error } : {}),
    ...(hint ? { hint } : {}),
  };
}

// ============================================================
// 核心：doDownload（独立可测，不经 MCP 装配——doSearchLocal 范式）
// ============================================================
export async function doDownload(
  args: DownloadArgs,
  d: DownloadDeps | null,
  ssrfConfig: SsrfConfig,
): Promise<InteractResult<DownloadToolData>> {
  // 隐私纪律（search_local 同款）：日志不落 url / magnet 哈希
  logger.info({ evt: "download_action", action: args.action });

  if (!d) {
    // WT 分支诚实降级：实现层（WT-core/WT-engines）未接线——宁可 didnt 不可悬空
    return envelope(
      "didnt",
      null,
      "download_engine_layer_not_wired",
      "download engine layer not wired (merge pending)",
    );
  }

  // ---------- 非法组合 / 缺参（家法：显式错 + ignored_options 回显） ----------
  const consumed = ACTION_CONSUMED_KEYS[args.action];
  const ignored = Object.keys(args).filter((k) => !consumed.has(k));

  switch (args.action) {
    case "start": {
      if (ignored.length > 0) {
        // start 的合法参数集是全量的——多出来的（task_id/timeout_s 等）全是非法组合
        return envelope(
          "didnt",
          { ignored_options: ignored },
          "invalid_params_combination",
          `invalid_params_combination: start does not take ${ignored.join(", ")} (task addressing is status/wait/cancel)`,
        );
      }
      if (!args.url) {
        return envelope(
          "didnt",
          null,
          "url_required_for_start",
          "url_required_for_start: http(s) URL, magnet: URI, or absolute .torrent path",
        );
      }
      const proxy = args.proxy ?? "auto";
      if (!isValidProxy(proxy)) {
        return envelope(
          "didnt",
          null,
          "invalid_params_proxy",
          'invalid_params_proxy: proxy must be "auto", "host:port", or "off"',
        );
      }
      return await doStart(args, d, ssrfConfig);
    }
    case "status": {
      if (!args.task_id) {
        return envelope(
          "didnt",
          null,
          "task_id_required_for_status",
          'task_id_required_for_status: single task id or "all"',
        );
      }
      if (args.task_id === "all") {
        // D13 孤儿三件套之「可见」：先收养再列（顺序是契约）
        const reconciled = d.reconcileOrphans();
        const tasks = d.listTasks();
        return envelope(
          "worked",
          { reconciled, count: tasks.length, tasks },
          "download_status_all",
        );
      }
      const record = d.readTask(args.task_id);
      if (!record) {
        return envelope(
          "didnt",
          null,
          "download_task_not_found",
          `download_task_not_found:${args.task_id} (address cross-session tasks via download_status "all")`,
        );
      }
      return envelope(
        "worked",
        { task: enrichTask(d, record) },
        "download_status",
      );
    }
    case "wait": {
      if (!args.task_id || args.task_id === "all") {
        return envelope(
          "didnt",
          null,
          "task_id_required_for_wait",
          'task_id_required_for_wait: wait needs a single task_id ("all" is a status form)',
        );
      }
      const timeoutMs = Math.max(
        0,
        (args.timeout_s ?? DEFAULT_WAIT_TIMEOUT_S) * 1000,
      );
      const intervalMs = Math.min(500, Math.max(25, Math.floor(timeoutMs / 4)));
      const startedAt = Date.now();
      let view: DownloadTaskRecord | null = null;
      for (;;) {
        const record = d.readTask(args.task_id);
        if (!record) {
          return envelope(
            "didnt",
            null,
            "download_task_not_found",
            `download_task_not_found:${args.task_id}`,
          );
        }
        if (TERMINAL_STATES.has(record.progress.state ?? "starting")) {
          return envelope(
            "worked",
            { task: record, waited_ms: Date.now() - startedAt },
            "download_wait",
          );
        }
        view = enrichTask(d, record);
        if (Date.now() - startedAt + intervalMs > timeoutMs) break;
        await sleep(intervalMs);
      }
      // D8/H3：超时返 partial 快照 + outcome unknown——教轮询，不烧穿 MCP 超时
      return envelope(
        "unknown",
        { task: view!, waited_ms: Date.now() - startedAt },
        "download_wait_timeout",
        undefined,
        WAIT_TIMEOUT_HINT,
      );
    }
    case "cancel": {
      if (!args.task_id || args.task_id === "all") {
        return envelope(
          "didnt",
          null,
          "task_id_required_for_cancel",
          "task_id_required_for_cancel: cancel needs a single task_id",
        );
      }
      const record = d.readTask(args.task_id);
      if (!record) {
        return envelope(
          "didnt",
          null,
          "download_task_not_found",
          `download_task_not_found:${args.task_id}`,
        );
      }
      if (record.progress.state === "cancelled") {
        // 幂等：已取消再取消仍是 true
        return envelope(
          "worked",
          { cancelled: true, task_id: args.task_id, engine_killed: false, already: "cancelled" },
          "download_cancel",
        );
      }
      if (TERMINAL_STATES.has(record.progress.state ?? "starting")) {
        return envelope(
          "didnt",
          null,
          "task_already_terminal",
          `task_already_terminal:${record.progress.state} (nothing to cancel)`,
        );
      }
      const killed = d.killEngineTree(record); // 四要素谓词在实装内（D7/H10）
      d.updateTask(args.task_id, { progress: { ...record.progress, state: "cancelled" } });
      return envelope(
        "worked",
        {
          cancelled: true,
          task_id: args.task_id,
          engine_killed: killed,
          ...(killed ? {} : { already: "engine_already_dead" }),
        },
        "download_cancel",
      );
    }
  }
}

// ============================================================
// start 全链（决议任务序：resolveFilename→assertOutDirAllowed→routeKind→
// ssrfGuard(仅 http)→createTask→spawnEngine）
// ============================================================
async function doStart(
  args: DownloadArgs,
  d: DownloadDeps,
  ssrfConfig: SsrfConfig,
): Promise<InteractResult<DownloadToolData>> {
  // 1. filename 归一（basename 强制——H5；deps 实装抛 filename_must_be_basename）
  let filename: string | null;
  try {
    filename = d.resolveFilename(args.filename ?? null);
  } catch (e) {
    return envelope(
      "didnt",
      null,
      "filename_must_be_basename",
      String(e instanceof Error ? e.message : e).slice(0, 200),
    );
  }

  // 2. out_dir 白名单（H8——deps 实装抛 out_dir_not_allowed）
  let outDir: string;
  try {
    outDir = d.assertOutDirAllowed(expandHome(args.out_dir ?? "~/Downloads"));
  } catch (e) {
    return envelope(
      "didnt",
      null,
      "out_dir_not_allowed",
      String(e instanceof Error ? e.message : e).slice(0, 200),
    );
  }

  // 3. kind 路由（auto 展开；explicit 优先）
  const routed = d.routeKind(args.url!, args.kind ?? "auto");

  // 4. kind×url 合法性 + ssrfGuard（仅 http kind——D12；magnet/torrent 禁冒充）
  if (routed.kind === "http" || routed.kind === "stream") {
    if (!/^https?:\/\//i.test(args.url!)) {
      return envelope(
        "didnt",
        null,
        "url_scheme_mismatch",
        `url_scheme_mismatch: kind=${routed.kind} requires an http(s):// url (magnet:/local .torrent belong to kind=torrent)`,
      );
    }
  }
  if (routed.kind === "torrent") {
    const isMagnet = args.url!.startsWith("magnet:");
    const isTorrentFile =
      path.isAbsolute(args.url!) && args.url!.toLowerCase().endsWith(".torrent");
    if (!isMagnet && !isTorrentFile) {
      return envelope(
        "didnt",
        null,
        "url_scheme_mismatch",
        'url_scheme_mismatch: kind=torrent requires a magnet: URI or an absolute .torrent path',
      );
    }
  }
  if (routed.kind === "http" || routed.kind === "stream") {
    // 与 fetch_url 同函数同 config（INV-31 家族）；拒绝风格同构（ssrfDenial 二分；
    // served_by 同 fetch_url 的 "lasso.ssr_guard"——CC 端跨工具模式识别一致）。
    // 审查修复批 P1-7：stream 首跳同样守门（kind:"stream"+内网 URL 的全旁路
    // 定罪修复——lasso 可控面=首跳；引擎自跟随跳仍属诚实边界）
    const ssrfResult = await ssrfGuard(args.url!, ssrfConfig);
    if (!ssrfResult.allowed) {
      const denial = ssrfDenial(ssrfResult.reason);
      const rejected: InteractResult<DownloadToolData> = {
        outcome: denial.outcome,
        data: null,
        served_by: "lasso.ssr_guard",
        fallback_used: false,
        retrieval_method: denial.retrieval_method,
        error: denial.error,
      };
      return rejected;
    }
  }

  // 5-6. 建任务 + spawn（deps）
  const input: StartTaskInput = {
    source: args.url!,
    kind: routed.kind,
    engine: routed.engine,
    outDir,
    filename,
    proxy: args.proxy ?? "auto",
    subs: args.subs ?? false,
    audioOnly: args.audio_only ?? false,
    maxConn: args.max_conn ?? 8,
    maxBytes: args.max_bytes ?? DEFAULT_MAX_BYTES,
  };
  // 总量帽/写盘失败等装配层异常 → 显式 didnt（错误码可操作——审查修复批）
  let record: ReturnType<DownloadDeps["createTask"]>;
  try {
    record = d.createTask(input);
  } catch (e) {
    return envelope(
      "didnt",
      null,
      "task_create_failed",
      String(e instanceof Error ? e.message : e).slice(0, 300),
    );
  }
  d.spawnEngine(record, {
    proxy: input.proxy,
    subs: input.subs,
    audioOnly: input.audioOnly,
    maxConn: input.maxConn,
  });

  logger.info({
    evt: "download_started",
    task_id: record.taskId,
    kind: routed.kind,
    engine: routed.engine,
  });
  return envelope(
    "worked",
    {
      task_id: record.taskId,
      kind: routed.kind,
      engine: routed.engine,
      out_dir: outDir,
      state: "starting",
    },
    "download_start",
  );
}

// ============================================================
// 注册器（fetch-url.ts 范式：name + DESCRIPTION + schema + annotations）
// ============================================================
/**
 * @param server     MCP server
 * @param ssrfConfig SSRF 配置（与 fetch_url / browse_headless 共用同一对象——D12：
 *                   http kind 同函数同 config；未接线 deps 时 ssrfConfig 不会被触达）
 */
export function registerDownloadTools(
  server: McpServer,
  ssrfConfig: SsrfConfig,
): void {
  server.tool(
    "download",
    DOWNLOAD_DESCRIPTION,
    downloadSchema,
    downloadAnnotations,
    async (args) => {
      const result = await doDownload(args as DownloadArgs, deps, ssrfConfig);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
