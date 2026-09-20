/**
 * types.ts（doc/bugs/12 下载器批——v1.30 接口契约，三 worktree 共享真源）
 *
 * 本文件先于实现 commit（决议 §八：WT-core / WT-engines / WT-tools 并行的
 * 共享依赖）。**改本文件必须同步改 doc/bugs/12 §三/§四**——契约与决议
 * 文档互为镜像，单一真源纪律。
 *
 * 关键决议锚（红队条件编号见 doc/bugs/12 §三）：
 *  - D5/H1：引擎 stdio 一律文件化（stdioFile），进度=tail 解析 progressLog；
 *    禁 stdio pipe（lasso 死后引擎 SIGPIPE 自毁）。
 *  - D6/H6：任务表每任务一文件（tasks/<taskId>.json），chrome-ledger 纪律。
 *  - D7/H10：cancel 杀谓词=任务定向四要素，killTreeSync 单一真源。
 *  - D8/H3：wait 帽 ≤120s，超时=partial 快照+outcome unknown。
 *  - D12/H5：filename 强制 basename（resolveFilename 里拒 `/`、`..`）。
 */
import * as path from "node:path";

// ============================================================
// 一、领域类型（任务表 JSON 的 schema 真源）
// ============================================================

export type DownloadKind = "http" | "stream" | "torrent";
/** status/任务表里的 kind 存 resolved 形态（auto 已在 start 时展开）。 */
export type DownloadKindInput = DownloadKind | "auto";

export type DownloadState =
  | "starting" // 引擎 spawn 前后、尚未收到首个进度
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned" // lasso 重启/会话死，引擎可能仍在跑（reconcile 收养）
  | "oversize"; // 超 max_bytes 被 watchdog 杀（D12/H4）

/** 引擎身份（任务表持久化用字符串字面量）。 */
export type DownloadEngineName = "aria2c" | "yt-dlp" | "undici";

export interface DownloadProgress {
  state: DownloadState;
  /** 0-1；torrent 元数据未完成时 null。 */
  progress: number | null;
  speedBps: number | null;
  etaSec: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
}

/**
 * 任务表记录（每任务一文件的 JSON 体）。
 * 纪律（D6）：写入=同步块内 read-modify-write + tmp+rename 原子写；
 * 损坏读→跳过该文件（chrome-ledger「损坏读→[]」同款，绝不整目录失效）。
 */
export interface DownloadTaskRecord {
  taskId: string;
  /** resolved kind（auto 已展开为 http/stream/torrent）。 */
  kind: DownloadKind;
  /** 原始输入（url / magnet: / .torrent 绝对路径）。 */
  source: string;
  /** realpath 规范化后的白名单内目录。 */
  outDir: string;
  /** basename 强制（禁 `/`、`..`）；null=引擎自命名。 */
  filename: string | null;
  createdAt: string;
  updatedAt: string;
  /** spawn 发起时的 lasso 进程 pid（孤儿判定基准）。 */
  ownerPid: number;
  engine: DownloadEngineName | null;
  enginePid: number | null;
  /** 引擎进程完整 argv（cancel 归属验证的 cmdline 匹配源）。 */
  engineCmdline: string[];
  /** stdio 文件化路径（H1/D5：stdout/stderr 重定向目标，兼进度日志）。 */
  stdioFile: string | null;
  progress: DownloadProgress;
  /** 产物绝对路径清单（completed 后=status 的交付物本体）。 */
  files: string[];
  /** 网络级诊断（BT 双因等）；null=无诊断。 */
  diagnosis: string | null;
  proxyUsed: string | null;
  maxBytes: number;
  /** subs=true 时 yt-dlp 产出的字幕文件（json3 源转 .srt 后终态）。 */
  subsFile: string | null;
}

// ============================================================
// 二、引擎层契约（WT-engines 实现面）
// ============================================================

/** 路由结果：kind=auto 的展开（决议 §四路由表）。 */
export interface RoutedDownload {
  kind: DownloadKind;
  engine: DownloadEngineName;
}

/** 引擎 spawn 规格（per-task spawn，D3——无 daemon）。
 *  可执行路径在 plan 的外层 `{command, spec}` 对里（WT-engines 原生分离设计：
 *  spec 描述 spawn 参数面，command 是解析后的可执行路径——2026-09-20 合并
 *  批次裁定保持分离，不并入本接口）。 */
export interface EngineSpawnSpec {
  engine: DownloadEngineName;
  args: string[];
  env: Record<string, string>;
  /** stdio 文件化目标（fs.openSync fd 追加写；H1：禁 pipe）。 */
  stdioFile: string;
  cwd: string;
}

/** 从 progressLog tail 解析出的增量进度（D14 机读协议）。 */
export interface EngineProgressSnapshot {
  progress: number | null;
  speedBps: number | null;
  etaSec: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  /** 引擎已自行退出时的退出码（null=仍在跑）。 */
  exitCode: number | null;
}

// ============================================================
// 三、纯函数契约（实现方必须导出的具名函数）
// ============================================================

/**
 * kind=auto 路由（决议 §四）：magnet:/.torrent→torrent；
 * yt-dlp extractor 域名特征表→stream；其余→http。
 * 纯函数（同输入同输出——R-INT-01），域名特征表为冻结常量。
 */
export type RouteKindFn = (source: string, explicit: DownloadKindInput) => RoutedDownload;

/**
 * filename 归一（D12/H5）：null 透传；含 `/` 或 `..` 段→抛
 * `filename_must_be_basename`（didnt 档显式错误，不猜）。
 */
export type ResolveFilenameFn = (filename: string | null | undefined) => string | null;

/**
 * cancel 杀谓词四要素（D7/H10——全满足才允许 killTreeSync）：
 * ①任务表在案 ②pid 仍活 ③/proc 等价 cmdline 含 lasso marker
 * ④cmdline 与记录的 engineCmdline 匹配（taskId 不可伪造面）。
 */
export interface KillPredicateInput {
  record: DownloadTaskRecord;
  enginePid: number;
  /** ps 等价手段取到的引擎进程 argv 现值。 */
  cmdlineNow: string[];
}

export type KillPredicateFn = (input: KillPredicateInput) => boolean;

// ============================================================
// 四、常量（单一真源）
// ============================================================

/**
 * 引擎 argv 归属标记——**2026-09-20 合并适配：已退役（历史契约保留）**。
 * 实测定罪：aria2 1.37.0 与 yt-dlp 均拒绝未知长参数
 * （`unrecognized option '--lasso-download-task'`），marker 不能进 argv。
 * 归属验证真源 = `engineCmdlineMatchesTask`（src/download/engines/staging.ts：
 * argv 含 `staging/<taskId>` 子串——aria2 `--dir` / yt-dlp `--paths` 必然携带）。
 * 本常量仅供 doc/bugs/12 契约史对照，**生产代码禁再引用**（kill.ts 已切换）。
 */
export const LASSO_DOWNLOAD_ARGV_MARKER = "--lasso-download-task";

/** 任务表根目录（env LASSO_DOWNLOADS_PATH 可覆盖——测试隔离）。 */
export const DOWNLOADS_DIR_ENV = "LASSO_DOWNLOADS_PATH";
export const DEFAULT_DOWNLOADS_DIR_SUFFIX = path.join("downloads", "tasks");

/** 引擎二进制缓存目录（D10：yt-dlp_macos / conda-forge aria2 落地处）。 */
export const LASSO_BIN_CACHE_ENV = "LASSO_BIN_DIR";
export const DEFAULT_BIN_DIR_SUFFIX = path.join("bin");

/** wait 帽（D8/H3：zod max 与运行时共用）。 */
export const DOWNLOAD_WAIT_TIMEOUT_MAX_S = 120;

/** max_bytes 缺省（D12：5 GiB 纸面帽+watchdog 强制点）。 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** BT 零 peer 诊断窗（决议 §二：60s 双因报因，禁单因断言）。 */
export const BT_ZERO_PEER_DIAGNOSIS_S = 60;
