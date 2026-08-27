#!/usr/bin/env node
// img-opt.mjs — merge 渲染层图像重压缩影子目录（2026-08-20 全书 ≤300M 压缩阶梯 ③）
//
// 设计约束（用户裁决）：
//  - 正典 images/ 与 MD 一字节不动——压缩只发生在渲染时拷入的影子副本
//  - 不动字体/字号/字间距/内容顺序；图像视觉冗余（打印内容宽 ~6.5in，200dpi 需 ~1300px，
//    超出部分为屏显冗余）可安全降采样
//  - 幂等可缓存：同源(mtime+size)+同参数 → 复用影子文件（重渲不重复压）
//
// 用法（merge.mjs 渲染前）：
//   const { prepareImgOpt } = await import("./img-opt.mjs");
//   const shadow = await prepareImgOpt(srcAbs, { maxDim: 1400, quality: 78 }); // 返回影子绝对路径
//   // buildHtml 时 fig.src 改指 shadow；失败 → 原样返回 srcAbs（降级不阻断渲染）
//
// 工具：macOS 自带 sips（无 ImageMagick 依赖）。
//  - JPEG 源：sips --setProperty format jpeg --setProperty formatOptions <q>（重编码）
//  - PNG 源（含透明）：保 PNG 仅降采样（sips -Z）；无透明的 PNG 转 JPEG 体积收益更大，
//    但透明检测成本高——v1 保守：PNG 只降采样不转码。
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const SHADOW_ROOT_DEFAULT = path.join(process.env.IMG_OPT_DIR || ".", "img-opt");
let SHADOW_ROOT = SHADOW_ROOT_DEFAULT;

/** 指定影子目录（merge 用 WORK/img-opt）。 */
export function setImgOptDir(dir) { SHADOW_ROOT = dir; fs.mkdirSync(dir, { recursive: true }); }

function sh(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

async function imageSize(abs) {
  const r = await sh("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs]);
  if (!r.ok) return null;
  const w = +((r.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1] || 0);
  const h = +((r.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1] || 0);
  return w && h ? { w, h } : null;
}

/**
 * 单图压缩入影子目录。返回影子绝对路径；任何失败返回原 srcAbs（降级不阻断）。
 * @param {string} srcAbs 正典图绝对路径
 * @param {{maxDim?:number, quality?:number}} opts
 */
export async function prepareImgOpt(srcAbs, { maxDim = 1400, quality = 78 } = {}) {
  try {
    if (!fs.existsSync(srcAbs)) return srcAbs;
    const st = fs.statSync(srcAbs);
    if (st.size < 40 * 1024) return srcAbs; // 小图压不出收益，直通
    const ext = path.extname(srcAbs).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return srcAbs; // gif(动图)/svg 等直通
    const dim = await imageSize(srcAbs);
    if (!dim) return srcAbs;
    // JPEG 系（jpg/jpeg/webp）一律重编码到质量档——得到图源多为 ~1080px 高质量档，
    // 体积大头是质量不是尺寸（实测 234KB/1080px），仅按尺寸直通会全部免检（首测踩坑）。
    // 压不过原大的在尾部收益检查里自动弃用，故「总是尝试」零风险。
    // PNG：无透明检测成本，保守只降采样不转码 → 尺寸达标即直通。
    const keepPng = ext === ".png";
    if (keepPng && Math.max(dim.w, dim.h) <= maxDim) return srcAbs;
    const key = createHash("sha1")
      .update(`${srcAbs}|${st.mtimeMs}|${st.size}|${maxDim}|${quality}`)
      .digest("hex").slice(0, 16);
    const shadow = path.join(SHADOW_ROOT, `${key}${keepPng ? ".png" : ".jpg"}`);
    if (fs.existsSync(shadow)) return shadow; // 幂等缓存命中
    fs.mkdirSync(SHADOW_ROOT, { recursive: true });
    const tmp = shadow + ".tmp-" + process.pid;
    const args = ["-Z", String(maxDim)];
    if (!keepPng) { args.push("--setProperty", "format", "jpeg", "--setProperty", "formatOptions", String(quality)); }
    args.push(srcAbs, "--out", tmp);
    const r = await sh("sips", args);
    if (!r.ok || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) { try { fs.rmSync(tmp, { force: true }); } catch {} return srcAbs; }
    // 压后反而更大（罕见）→ 弃用影子
    if (fs.statSync(tmp).size >= st.size) { try { fs.rmSync(tmp, { force: true }); } catch {} return srcAbs; }
    fs.renameSync(tmp, shadow);
    return shadow;
  } catch { return srcAbs; }
}

/**
 * 批量：对 blocks 里全部 img 块生成影子映射。
 * @returns {Promise<Map<string,string>>} 原始 src → 影子路径（值可能=键，即直通）
 */
export async function prepareImgOptBatch(srcAbsList, opts) {
  const map = new Map();
  const CONC = 6; // sips 并发（子进程级，不阻塞事件循环）
  const queue = [...new Set(srcAbsList)];
  let i = 0;
  async function worker() { while (i < queue.length) { const s = queue[i++]; map.set(s, await prepareImgOpt(s, opts)); } }
  await Promise.all(Array.from({ length: CONC }, worker));
  return map;
}

/** CLI 自检：node img-opt.mjs <图片路径> [maxDim] [quality] → 打印前后体积。 */
if (process.argv[1] && process.argv[1].endsWith("img-opt.mjs") && process.argv[2]) {
  const src = path.resolve(process.argv[2]);
  const before = fs.statSync(src).size;
  setImgOptDir(path.join(path.dirname(src), ".img-opt-test"));
  const out = await prepareImgOpt(src, { maxDim: +process.argv[3] || 1400, quality: +process.argv[4] || 78 });
  const after = out === src ? before : fs.statSync(out).size;
  console.log(JSON.stringify({ src, out, before, after, saved: before - after, ratio: +(after / before).toFixed(3) }));
}
