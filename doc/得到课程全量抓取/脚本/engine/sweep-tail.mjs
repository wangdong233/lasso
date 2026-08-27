#!/usr/bin/env node
// P26 收尾：剩余失败章小批重启跑（每批新进程=新 lasso 会话，规避长会话劣化白盒结论）
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
const ENGINE = "/Users/wangdong/Documents/Project/claude技能/lasso/output/得到_薛兆丰的经济学/.engine";
const st = JSON.parse(fs.readFileSync(`${ENGINE}/state.json`, "utf8"));
const hard = new Set(["加餐", "直播回顾", "第七单元串讲"]);
const easy = Object.values(st.chapters).filter((e) => e.status === "failed" && !hard.has(e.title)).map((e) => e.title);
const hards = Object.values(st.chapters).filter((e) => e.status === "failed" && hard.has(e.title)).map((e) => e.title);
const chunks = [];
for (let i = 0; i < easy.length; i += 7) chunks.push(easy.slice(i, i + 7));
if (hards.length) chunks.push(hards);
console.log(`[sweep] 剩余 ${easy.length + hards.length} 章 → ${chunks.length} 批（每批 7 章重启；病理页殿后）`);
let total = { ok: 0, fail: 0 }, fails = [];
for (let i = 0; i < chunks.length; i++) {
  const batch = chunks[i];
  console.log(`\n[sweep] ===== 批 ${i + 1}/${chunks.length}（${batch.length} 章）=====`);
  try {
    const out = execFileSync("node", [`${ENGINE}/engine.mjs`, "produce", "--only", batch.join(","), "--retry"], {
      cwd: ENGINE, maxBuffer: 64 << 20, timeout: 30 * 60 * 1000,
    }).toString();
    const oks = (out.match(/\[OK\] /g) || []).length;
    const fls = (out.match(/\[FAIL\] /g) || []).length;
    total.ok += oks; total.fail += fls;
    for (const ln of out.split("\n")) if (ln.includes("[FAIL] ")) fails.push(ln.slice(0, 120));
    console.log(`[sweep] 批 ${i + 1} 完成：OK=${oks} FAIL=${fls}`);
  } catch (e) {
    console.log(`[sweep] 批 ${i + 1} 异常：${String(e.message).slice(0, 100)}`);
    total.fail += batch.length;
  }
  try { fs.rmSync(`${ENGINE}/BREAKER.trip`, { force: true }); } catch {}
}
console.log(`\n[sweep] 全部完成：OK=${total.ok} FAIL=${total.fail}`);
if (fails.length) { console.log("[sweep] 失败明细："); fails.forEach((f) => console.log("  " + f)); }
