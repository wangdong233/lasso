#!/usr/bin/env node
// P26 收官：找出 MD 引用但未落盘的图 → 直接补下载到对应章 images/
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { BASE } from "./config.mjs"; // 2026-08-20 F1 整改：课程根唯一入口 config.mjs
const safeName = (t) => String(t).replace(/\//g, "／").replace(/\\/g, "＼");
const m = JSON.parse(fs.readFileSync(`${BASE}/.engine/manifest.json`, "utf8"));
const missing = [];
for (const f of m.flat) {
  const dir = path.join(BASE, f.dirName);
  const md = path.join(dir, `${safeName(f.title)}.md`);
  if (!fs.existsSync(md)) continue;
  const raw = fs.readFileSync(md, "utf8");
  const re = /!\[\]\(([^)]+)\)/g;
  let mm;
  while ((mm = re.exec(raw))) {
    const ref = mm[1];
    if (ref.startsWith("images/") && !fs.existsSync(path.resolve(dir, ref))) missing.push({ title: f.title, ref, dirName: f.dirName });
  }
}
console.log("缺失:", missing.length);
for (const x of missing) console.log("  ", x.dirName, "|", x.title, "|", x.ref);
// 补下载：basename 反推远程 URL（umiwi CDN 命名 /img/YYYY/MM/NAME）
let ok = 0;
for (const x of missing) {
  const base = x.ref.split("/").pop();
  const ym = base.match(/^(\d{4})(\d{2})/);
  if (!ym) { console.log("  [SKIP] 无法反推年月:", base); continue; }
  const url = `https://piccdn3.umiwi.com/img/${ym[1]}/${ym[2]}/${base}`;
  try {
    const buf = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
    if (buf.length < 100) throw new Error("empty");
    const abs = path.join(BASE, x.dirName, x.ref);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    console.log(`  [DL OK] ${base} → ${x.dirName}/${x.ref} (${buf.length}B md5=${createHash("md5").update(buf).digest("hex").slice(0, 8)})`);
    ok++;
  } catch (e) {
    console.log(`  [DL FAIL] ${url}: ${String(e && e.message || e).slice(0, 60)}`);
  }
}
console.log(`补齐 ${ok}/${missing.length}`);
