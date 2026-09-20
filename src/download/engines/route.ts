/**
 * route.ts（doc/bugs/12 §四 kind=auto 路由表——RouteKindFn 契约实现）
 *
 * 冻结决策面（红队 A1 反 creep 精神）：域名特征表是**快照常量**而非探测——
 * 路由层零网络零 spawn（R-INT-01 纯函数），误路由只影响引擎选择不影响
 * 正确性（yt-dlp 也能下直链，aria2 也能下流媒体 URL——只是次优）。
 *
 * 引擎映射（D9）：http→aria2c / stream→yt-dlp / torrent→aria2c。
 * 「aria2c 缺失→undici 降级」**不在**路由层——那是 spawn 时 detect 逻辑
 * （start.ts），路由只标 engine=aria2c。
 */
import type {
  DownloadKind,
  DownloadKindInput,
  RoutedDownload,
} from "../types.js";

/**
 * yt-dlp extractor 域名特征表（冻结快照 2026-09-20；≥20 域）。
 * 收录标准：主站+短链+专有 CDN。误报成本低（yt-dlp 兜底可下直链），
 * 漏报成本高（aria2 拿到 DRM/签名 URL 只能下 HTML），故从宽。
 */
export const STREAM_EXTRACTOR_DOMAINS: readonly string[] = Object.freeze([
  // YouTube 系
  "youtube.com",
  "youtu.be",
  "ytimg.com",
  "googlevideo.com",
  // B 站系
  "bilibili.com",
  "b23.tv",
  "bilivideo.com",
  "hdslb.com",
  "biliapi.net",
  // X/Twitter 系
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  // TikTok/抖音系
  "tiktok.com",
  "tiktokcdn.com",
  "douyin.com",
  "iesdouyin.com",
  // Instagram
  "instagram.com",
  "cdninstagram.com",
  // 长视频/直播平台
  "vimeo.com",
  "twitch.tv",
  "ttvnw.net",
  "dailymotion.com",
  "dmcdn.net",
  "youku.com",
  "iqiyi.com",
  "v.qq.com",
  "weibo.com",
  // 音频平台
  "soundcloud.com",
  "sndcdn.com",
  "bandcamp.com",
  "bcbits.com",
]);

/** hostname 是否命中流媒体特征域（www. 前缀透明；子域=所属主域命中）。 */
export function isStreamExtractorHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return STREAM_EXTRACTOR_DOMAINS.some(
    (d) => h === d || h.endsWith(`.${d}`),
  );
}

/** source 单独分类（不含 explicit——供 start 层与诊断复用）。 */
export function classifySourceKind(source: string): DownloadKind {
  const s = source.trim();
  if (/^magnet:/i.test(s)) return "torrent";
  if (/\.torrent$/i.test(s)) return "torrent";
  try {
    const u = new URL(s);
    if ((u.protocol === "http:" || u.protocol === "https:") && isStreamExtractorHost(u.hostname)) {
      return "stream";
    }
  } catch {
    // 非 URL：只剩本地 .torrent 路径一种合法形态（上面已判），归 http 由
    // 后续校验报错——路由层不猜（didnt 档显式错误哲学）。
  }
  return "http";
}

const VALID_KINDS: readonly DownloadKind[] = ["http", "stream", "torrent"];

/**
 * RouteKindFn 实现（契约见 types.ts 三）：explicit≠auto 透传（非法值
 * fail-closed 抛错——zod 之外的第二道闸）；auto 按分类表展开。
 */
export function routeKind(
  source: string,
  explicit: DownloadKindInput,
): RoutedDownload {
  let kind: DownloadKind;
  if (explicit === "auto") {
    kind = classifySourceKind(source);
  } else if ((VALID_KINDS as readonly string[]).includes(explicit)) {
    kind = explicit;
  } else {
    throw new Error(`invalid_download_kind:${explicit}`);
  }
  return { kind, engine: kind === "stream" ? "yt-dlp" : "aria2c" };
}
