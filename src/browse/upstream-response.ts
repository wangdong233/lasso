/**
 * chrome-devtools-mcp@0.3.0 真实响应形状适配器（v1.8 W1-DEF-1b）。
 *
 * 2026-08-15 本机裸探实测契约（非 mock 推断）：
 * - evaluate_script 返回 markdown 包裹的 text block：
 *     "# evaluate_script response\nScript ran on page and returned:\n```json\n<返回值的 JSON>\n```"
 *   即：脚本返回值被上游 JSON.stringify 后包进 ```json 围栏。脚本返回字符串时双层编码。
 * - take_screenshot 返回 content 数组：[0]=text 头部块（"# take_screenshot response..."），
 *   [1]={type:"image", data:<base64>, mimeType:"image/png"}——base64 在 image 块，不在 text。
 *
 * 本模块是唯一权威解析入口；各 channel 不得再各自 firstText 后直接 JSON.parse。
 */

export type TextBlock = { type: "text"; text?: string };
export type ImageBlock = { type: "image"; data?: string; mimeType?: string };
export type UpstreamContentResult = {
  content?: Array<TextBlock | ImageBlock>;
  isError?: boolean;
};

/** 取第一个 text block 的原文（含上游 markdown 头，仅用于错误详情/raw 展示）。 */
export function firstText(
  r: UpstreamContentResult | undefined,
): string | undefined {
  if (!r?.content) return undefined;
  for (const b of r.content) {
    if (b.type === "text" && b.text) return b.text;
  }
  return undefined;
}

/**
 * 提取 evaluate_script 响应里 ``` 围栏内的文本（去掉 ```json 语言标）。
 * 无围栏（上游形状漂移）返回 undefined。
 */
export function evalFence(
  r: UpstreamContentResult | undefined,
): string | undefined {
  const text = firstText(r);
  if (!text) return undefined;
  const m = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  return m?.[1];
}

/**
 * 解析 evaluate_script 的脚本返回值：
 * 围栏文本 → JSON.parse 一次得返回值；若结果是 string 且再次 parse 成功则再解一层
 * （脚本 `return JSON.stringify(x)` 时双层编码的宽容处理）。
 * 任何失败返回 undefined（caller 各自决定兜底语义）。
 */
export function parseEvalResult(
  r: UpstreamContentResult | undefined,
): unknown {
  const fence = evalFence(r);
  if (fence == null) return undefined;
  try {
    const once = JSON.parse(fence);
    if (typeof once === "string") {
      try {
        return JSON.parse(once);
      } catch {
        return once; // 脚本本来就返回纯字符串（如 "true"/"false"）
      }
    }
    return once;
  } catch {
    return undefined;
  }
}

/**
 * evaluate_script 返回值归一为字符串（"true"/"false"/文本）。
 * 供条件判定类消费（ExpectPoll / StealthEngine CF 检测）。
 */
export function evalTextValue(
  r: UpstreamContentResult | undefined,
): string | undefined {
  const v = parseEvalResult(r);
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  return String(v);
}

/** 取 take_screenshot 的 image content block（base64 + mimeType）。 */
export function imageBlock(
  r: UpstreamContentResult | undefined,
): { data: string; mimeType: string } | undefined {
  if (!r?.content) return undefined;
  for (const b of r.content) {
    if (b.type === "image" && b.data) {
      return { data: b.data, mimeType: b.mimeType ?? "image/png" };
    }
  }
  return undefined;
}
