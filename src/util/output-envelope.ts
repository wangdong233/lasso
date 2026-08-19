/**
 * Lasso v0.3 bounded output 48KiB/2000 行 + @oN 续页（parse3 §3.4，F3.2.20）
 *
 * 架构铁律（08 §0 原则 5）：CC 收到的单条结果不超过 48KiB / 2000 行，
 * 超限自动落盘（mode 0o600，隐私适合 logged_in cookie 内容），返回 16KiB
 * preview + @oN ref + continue_hint，CC 用 read_text({ref, offset}) 续页。
 *
 * 借鉴源（12 §1.3G 源码级 —— injaneity src/output.ts）：
 *   - MODEL_TEXT_MAX_BYTES = 48 * 1024
 *   - MODEL_TEXT_MAX_LINES = 2000
 *   - MODEL_PREVIEW_BYTES  = 16 * 1024
 *   - OUTPUT_PAGE_BYTES    = 16 * 1024
 *   - 单条上限 16 MiB / store 总 64 MiB
 *   - storeOutput 用 os.tmpdir() + mkdtempSync mode 0o600，文件名 @oN.txt
 *   - applyOutputEnvelope 超限返回 preview + 三行 trailer
 *
 * INV-15（parse3 §5.3）：spill 文件必须 mode 0o600（防其他用户读 cookie/PII）。
 */
import {
  promises as fsPromises,
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================
// 常量（与 injaneity output.ts 对齐）
// ============================================================
export const MAX_BYTES = 48 * 1024; // 48 KiB
export const MAX_LINES = 2000;
export const PREVIEW_BYTES = 16 * 1024; // 16 KiB
export const PAGE_BYTES = 16 * 1024; // read_text 默认页大小
const SINGLE_CAP_BYTES = 16 * 1024 * 1024; // 16 MiB 单条上限
const STORE_CAP_BYTES = 64 * 1024 * 1024; // 64 MiB 总量上限

const SPILL_ROOT = path.join(os.tmpdir(), "lasso-output");

// ============================================================
// 模块状态
// ============================================================
/**
 * @oN → 落盘元数据。Map 保插入序；readOutputPage 访问时 touch（delete+set 移到尾），
 * 头部即 LRU 最老——v1.18.2（doc/29 F4）兑现「便于 LRU 清理」的承诺：
 * 总量超 STORE_CAP_BYTES 时按 LRU 淘汰最老 spill（同步删文件），不再 throw。
 */
const store = new Map<string, { path: string; bytes: number }>();
let outputCounter = 0;
let totalBytes = 0;
/** LRU 淘汰计数（观测：doctor/测试可见会话内淘汰了多少老 spill）。 */
let evictedCount = 0;

// ============================================================
// BoundedOutput 类型
// ============================================================
/**
 * applyOutputEnvelope 的返回形状。
 *  - truncated=false 时，preview 即完整内容（≤ 48KiB / 2000 行）。
 *  - truncated=true 时，preview 是前 16KiB，CC 需 read_text({ref,offset}) 续页。
 */
export interface BoundedOutput {
  /** 前 16KiB（truncated=false 时是完整内容） */
  preview: string;
  truncated: boolean;
  /** "@o3" — CC 用此 ref 续页（read_text({ref:"@o3", ...})） */
  ref?: string;
  total_bytes?: number;
  total_lines?: number;
  /** tool-specific 提示，如 "narrow selectors to reduce node count" */
  refine_hint?: string;
  /** "read_text({ref:\"@o3\", offset:16384})" */
  continue_hint?: string;
}

// ============================================================
// 核心 API
// ============================================================
/**
 * 包络函数：若 text ≤ 48KiB 且 ≤ 2000 行 → 原样返回（truncated=false）。
 * 否则 spill 到 /tmp/lasso-output/@oN.<extension>（mode 0o600），返回 preview + ref。
 *
 * @param text        原始完整文本（chain result JSON / 整页抽取等）
 * @param refineHint  tool-specific refine_hint（不传则用 defaultRefineHint）
 * @param extension   v0.5 新增（parse6 §3.3.2）：落盘文件后缀，默认 ".txt"（向后兼容）；
 *                    pdf 工具传 ".pdf"（注：内容仍是 base64 文本，扩展名只是 hint 给 caller）。
 */
export function applyOutputEnvelope(
  text: string,
  refineHint?: string,
  extension: ".txt" | ".pdf" = ".txt",
): BoundedOutput {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n").length;

  if (bytes <= MAX_BYTES && lines <= MAX_LINES) {
    return { preview: text, truncated: false };
  }

  if (bytes > SINGLE_CAP_BYTES) {
    // 单条上限保护：超 16 MiB 直接抛错（说明上游数据异常）
    throw new Error(
      `output single cap exceeded: ${bytes} > ${SINGLE_CAP_BYTES}`,
    );
  }

  // 超限 → spill（mode 0o600，隐私适合 logged_in cookie 内容）
  const ref = `@o${++outputCounter}`;
  spillToDisk(ref, text, extension);
  const preview = utf8ByteSlice(text, 0, PREVIEW_BYTES);

  return {
    preview,
    truncated: true,
    ref,
    total_bytes: bytes,
    total_lines: lines,
    refine_hint: refineHint ?? defaultRefineHint(text),
    continue_hint: `read_text({ref:"${ref}", offset:${PREVIEW_BYTES}})`,
  };
}

/**
 * read_text 工具续页：从落盘文件读 [offset, offset+limit) 字节，返回 { text, eof }。
 * v1.18.2（doc/29 F4）：读即 touch（LRU 访问刷新——正被续页读的 ref 不易被淘汰）。
 * @throws 若 ref 不在 store（LRU 淘汰或未知）
 */
export function readOutputPage(
  ref: string,
  offset = 0,
  limit = PAGE_BYTES,
): { text: string; eof: boolean; total_bytes: number } {
  const entry = store.get(ref);
  if (!entry) {
    throw new Error(`unknown ref: ${ref}`);
  }
  // LRU touch：删了重插移到 Map 尾（最新端）
  store.delete(ref);
  store.set(ref, entry);
  const full = existsSync(entry.path)
    ? readFileSync(entry.path, "utf8")
    : "";
  const slice = utf8ByteSlice(full, offset, offset + limit);
  return {
    text: slice,
    eof: offset + limit >= Buffer.byteLength(full, "utf8"),
    total_bytes: entry.bytes,
  };
}

/** 查询当前 store 总占用（调试 / 测试用）。 */
export function getTotalBytes(): number {
  return totalBytes;
}

/** 查询当前 ref 计数（测试用）。 */
export function getOutputCounter(): number {
  return outputCounter;
}

/** v1.18.2（doc/29 F4）：会话内 LRU 淘汰次数（观测：长会话磁盘 churn 可见）。 */
export function getEvictedCount(): number {
  return evictedCount;
}

// ============================================================
// 内部 helper
// ============================================================
/**
 * v1.18.2（doc/29 F4）：总量超 cap 时 **LRU 淘汰最老 spill（删 Map 头 + 删文件）**
 * 直到放得下，而不是 throw。
 *
 * 旧实现（v0.3「暂不淘汰」）：totalBytes 单调递增 → 长命 server 会话累计 ≥64MiB
 * （≈1365 个 spill；PDF base64 膨胀 1.33×，全量批次一天可撞）→ 撞后**所有**大输出
 * 永久 throw 直至重启——未捕获路径（BrowseChannel/fetch_url）直接崩 tool、
 * 误分类路径（pdf/network catch）把「已抓到内容」报成 didnt，并级联喂熔断。
 *
 * 数学保证：SINGLE_CAP(16MiB) < STORE_CAP(64MiB) → 淘汰光后新 spill 必放得下；
 * 防御分支保留（不可达；防未来常量漂移）。
 */
function spillToDisk(
  ref: string,
  text: string,
  extension: ".txt" | ".pdf" = ".txt",
): string {
  const incomingBytes = Buffer.byteLength(text, "utf8");
  // LRU 淘汰：从 Map 头（最老/最久未读）开始，直到总占用 + 新 spill ≤ cap
  while (
    totalBytes + incomingBytes > STORE_CAP_BYTES &&
    store.size > 0
  ) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    const entry = store.get(oldest)!;
    store.delete(oldest);
    totalBytes -= entry.bytes;
    evictedCount++;
    try {
      rmSync(entry.path, { force: true });
    } catch {
      // 删文件失败不阻塞 spill（磁盘上的孤儿文件由 OS tmp 清理兜底；内存账已减）
    }
  }
  if (totalBytes + incomingBytes > STORE_CAP_BYTES) {
    // 防御分支（LRU 后数学不可达——SINGLE_CAP < STORE_CAP；防常量漂移）
    throw new Error(
      `output store exhausted (single spill ${incomingBytes} > cap ${STORE_CAP_BYTES})`,
    );
  }
  // SPILL_ROOT 目录：mode 0o700（仅当前用户可进）
  // 用 mkdirSync recursive 而非 mkdtempSync，因为我们需要固定的 "@oN.txt" 路径。
  mkdirSync(SPILL_ROOT, { recursive: true, mode: 0o700 });

  // v0.5（parse6 §3.3.2）：extension 参数支持 ".pdf"（pdf 工具用）；
  // 默认 ".txt" 守 backward-compat（output-envelope.spec.ts 不破）。
  const file = path.join(SPILL_ROOT, `${ref}${extension}`);
  // 文件：mode 0o600（仅当前用户可读写）—— INV-15 + INV-34（pdf 二进制内容同源）
  writeFileSync(file, text, { mode: 0o600 });

  store.set(ref, { path: file, bytes: incomingBytes });
  totalBytes += incomingBytes;
  return file;
}

/** UTF-8 字节精确切片：避免在多字节字符中间断开（取 ≤ endByte 的最大完整前缀）。 */
function utf8ByteSlice(text: string, startByte: number, endByte?: number): string {
  const buf = Buffer.from(text, "utf8");
  const end = endByte ?? buf.length;
  let safeEnd = end;
  if (safeEnd > buf.length) safeEnd = buf.length;
  // 回退到 UTF-8 安全边界（继续字节 0b10xxxxxx 不能作为起点）
  while (safeEnd > startByte && safeEnd < buf.length && (buf[safeEnd]! & 0xc0) === 0x80) {
    safeEnd--;
  }
  return buf.subarray(startByte, safeEnd).toString("utf8");
}

function defaultRefineHint(text: string): string {
  // 粗启发式：JSON 含 "actions_and_results" → 多步链结果，提示缩 selector
  if (text.includes('"actions_and_results"')) {
    return "chain result too large: narrow selectors or split into smaller steps to reduce node count";
  }
  // 长文本（≥ 200 KiB）通常是大 DOM 抽取
  if (Buffer.byteLength(text, "utf8") > 200 * 1024) {
    return "extract result too large: consider narrower CSS selector or extract-specific-fields action";
  }
  return "output exceeded 48 KiB / 2000 lines; refine query to reduce size";
}

// ============================================================
// 测试辅助（不入 dist 的 production 路径）
// ============================================================
/**
 * 重置模块状态 + 清理 spill 目录。仅 vitest 单测调用。
 */
export async function _resetForTests(): Promise<void> {
  for (const { path: p } of store.values()) {
    try {
      await fsPromises.rm(p, { force: true });
    } catch {
      // ignore
    }
  }
  store.clear();
  outputCounter = 0;
  totalBytes = 0;
  evictedCount = 0;
}
