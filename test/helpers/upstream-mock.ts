/**
 * chrome-devtools-mcp@0.3.0 真实响应形状 mock helper（v1.8 W1-DEF-1b）。
 *
 * 契约锚点：src/browse/upstream-response.ts 头注（2026-08-15 本机裸探实测，非推断）：
 *  - evaluate_script 成功响应 content[0].text 是 markdown 围栏包裹：
 *      "# evaluate_script response\nScript ran on page and returned:\n```json\n"
 *      + JSON.stringify(脚本返回值) + "\n```"
 *  - take_screenshot 成功响应 content 是数组：
 *      [0]={type:"text",text:"# take_screenshot response\nTook a screen..."},
 *      [1]={type:"image",data:"<base64 PNG>",mimeType:"image/png"}
 *
 * 铁律：各测试的 stub McpClient 统一经此构造 evaluate_script / take_screenshot
 * 返回，禁各自手搓旧形状（base64/JSON 裸放 text block——那是 W1-DEF-1b 之前的
 * 历史形态，正是 11 个用例失败的根因）。
 */

import { deflateSync } from "node:zlib";

/** evaluate_script 成功响应（脚本返回值经上游 JSON.stringify 后包进 ```json 围栏）。 */
export function mockEvalResponse(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text:
          "# evaluate_script response\nScript ran on page and returned:\n```json\n" +
          JSON.stringify(value) +
          "\n```",
      },
    ],
  };
}

/** take_screenshot 成功响应（[0]=text 头部块，[1]=image block 含 base64 + mimeType）。 */
export function mockScreenshotResponse(pngBase64: string = VALID_PNG_BASE64): {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
} {
  return {
    content: [
      { type: "text", text: "# take_screenshot response\nTook a screenshot" },
      { type: "image", data: pngBase64, mimeType: "image/png" },
    ],
  };
}

// ============================================================
// 真实合法小 PNG（≥100 字节、89 50 4E 47 开头）——运行时用 zlib 现造，
// 不硬编码魔数串。src doScreenshot 校验 PNG magic + ≥100 字节，此常量满足。
// ============================================================
const CRC_TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** 128x128 全零灰度图：IHDR/IDAT/IEND 齐全 + zlib 真实压缩，总长 ≥100 字节。 */
const VALID_PNG: Buffer = (() => {
  const W = 128;
  const H = 128;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(H * (1 + W)); // 每行 filter byte 0 + W 个零像素
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  // 全零图压缩后总长可能 <100 字节；补 tEXt padding 块（PNG 合法块）到 ≥120，
  // 满足 src doScreenshot 的 PNG magic + ≥100 字节校验。
  if (png.length < 120) {
    const text = Buffer.concat([
      Buffer.from("Comment\0", "ascii"),
      Buffer.alloc(120 - png.length + 12),
    ]);
    return Buffer.concat([
      png.subarray(0, png.length - 12), // IEND 前插入
      pngChunk("tEXt", text),
      png.subarray(png.length - 12),
    ]);
  }
  return png;
})();

if (VALID_PNG.length < 100 || VALID_PNG[0] !== 0x89 || VALID_PNG[1] !== 0x50) {
  throw new Error(
    `upstream-mock: VALID_PNG 不满足契约（len=${VALID_PNG.length}）`,
  );
}

export const VALID_PNG_BASE64 = VALID_PNG.toString("base64");
