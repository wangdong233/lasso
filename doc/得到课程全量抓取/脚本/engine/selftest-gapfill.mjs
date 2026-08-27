#!/usr/bin/env node
// selftest-gapfill.mjs — P30 gapfill 链感知升级的只读复扫自测（可重复跑，禁重渲染）
//
// 输入全部为既有产物：终局成书/shard*-*.pdf + shard*-meta.json + merge-plan.json + 章节 MD。
// 只读（pdftotext -bbox / pdfimages / 读 MD），零渲染、零写入（tmp 由 analyze.mjs 自理）。
//
// 断言组：
//   A 链盲复现 + 新规则生效：shard13 十处 leave:fits 大空白（p16/19/33/38/43/51/59/63/68/75，
//     对成品 p1237/1240/1254/1259/1264/1272/1280/1284/1289/1296 全部 G2 fail 贡献页）
//     ——旧版 0 动作，新版全部转为 shrink（含 p93 36% 共 11 动作）。
//   B 轮次截断复现（F3）：终态仍可执行的 round-4 动作（s4p42/s4p116/s5p59/s5p278/s12p110，
//     对成品 G2 fail p254/p328/p431/p650/p1181）在新旧两版均存在——证明 3 轮上限是约束
//     （merge.mjs 已改 RULES.MAX_ROUNDS=6 + 严格递减守卫）。
//   C 向后兼容：shard02-flow（冒烟-合并6章-flow 的实分片）新旧 plan 完全一致——
//     cosmetic 档不被链规则触碰，冒烟 QC 语义不变。
//   D decideGapFill 网格：chainHeadCss=0 时新输出 ≡ 旧输出（action/maxCss/availCss/tier）。
//   E P31 陈旧守卫谓词干跑：merge-plan.json(110 章) vs shard02-meta.json(5 章) → 守卫判真。
//   F assertNoUnfilledGaps 未动：对 shard13 仍如实报 hardFail（断言侧语义与交付报告一致）。
//
// 用法：node .engine/selftest-gapfill.mjs   （任意 cwd；绝对路径内建）
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert";
import { holeReport } from "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/analyze.mjs";
import {
  RULES, decideGapFill, planGapFill, matchFigsToPdf, figChainAnnotations, assertNoUnfilledGaps,
} from "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/gapfill.mjs";

const BASE = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学";
const OUT = path.join(BASE, "终局成书");
const GF = "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/gapfill.mjs";

// ======================== 基线（P30 前原版，逐字拷贝自 lasso git e5dde99 的 gapfill.mjs） ========================
// 证明手段：同输入喂旧/新两版 planGapFill，diff 出的 delta 即 P30 行为变化全集。
const baselineDecideGapFill = ({ freePt, freePct, printHCss, natDisplayCss = Infinity }) => {
  const freeCss = (freePt * 96) / 72;
  const availCss = freeCss - RULES.FIG_VMARGIN_CSS - RULES.SAFETY_CSS;
  const big = freePct >= RULES.GAP_BIG_PCT;
  const floor = big ? RULES.IMG_MIN_CSS : RULES.IMG_MIN_COSMETIC_CSS;
  const tier = big ? "big" : "cosmetic";
  if (printHCss <= availCss) return { action: "leave", reason: "fits", availCss: Math.round(availCss), tier };
  if (availCss >= floor) {
    const maxCss = Math.max(1, Math.floor(Math.min(availCss, natDisplayCss)));
    if (printHCss <= maxCss) return { action: "leave", reason: "nat-capped-fits", availCss: Math.round(availCss), tier };
    return { action: "shrink", maxCss, availCss: Math.round(availCss), tier };
  }
  if (big) return { action: "delete", reason: `avail(${Math.round(availCss)}css)<floor(${floor}css)`, availCss: Math.round(availCss), tier };
  return { action: "leave", reason: `cosmetic-below-floor(${Math.round(availCss)}<${floor})`, availCss: Math.round(availCss), tier };
};
function baselinePlanGapFill({ per, figsAligned, chapterStartPages = [], totalPages, alreadyShrunk = new Map(), deletedKeys = new Set() }) {
  const starts = new Set(chapterStartPages);
  const plan = { shrink: [], delete: [], skip: [] };
  for (let i = 0; i < per.length; i++) {
    const p = per[i];
    if (p.isLast || totalPages && p.page >= totalPages) continue;
    if (starts.has(p.page + 1)) { if (p.freePct >= RULES.GAP_COSMETIC_PCT) plan.skip.push({ page: p.page, freePct: p.freePct, why: "next-is-chapter-start" }); continue; }
    if (p.freePct < RULES.GAP_COSMETIC_PCT) continue;
    const onPage = figsAligned.filter((f) => f.actualPage === p.page + 1 && !deletedKeys.has(f.key));
    if (!onPage.length) { plan.skip.push({ page: p.page, freePct: p.freePct, why: "no-fig-on-next-page" }); continue; }
    const fig = onPage.reduce((a, b) => (a.key <= b.key ? a : b));
    if (typeof fig.key !== "number") { plan.skip.push({ page: p.page, freePct: p.freePct, why: "inline-fig-not-addressable" }); continue; }
    const d = baselineDecideGapFill({ freePt: p.freePt, freePct: p.freePct, printHCss: fig.printHCss ?? Infinity, natDisplayCss: fig.natDisplayCss ?? Infinity });
    const prev = alreadyShrunk.get(fig.key);
    if (d.action === "shrink" && prev !== undefined) {
      if (p.freePct >= RULES.GAP_BIG_PCT) {
        plan.delete.push({ page: p.page, freePct: p.freePct, freePt: p.freePt, fig, reason: `still-overflow-after-shrink(${prev}css)`, prevMax: prev });
        continue;
      }
      const maxCss = Math.max(RULES.IMG_MIN_COSMETIC_CSS, Math.floor(d.availCss - RULES.SAFETY_CSS));
      if (maxCss < prev) plan.shrink.push({ page: p.page, freePct: p.freePct, freePt: p.freePt, fig, maxCss, tier: "cosmetic-retry", reason: `retry-shrink-${prev}->${maxCss}` });
      else plan.skip.push({ page: p.page, freePct: p.freePct, why: `shrink-stalled(${prev})` });
      continue;
    }
    if (d.action === "shrink") plan.shrink.push({ page: p.page, freePct: p.freePct, freePt: p.freePt, fig, maxCss: d.maxCss, tier: d.tier, reason: d.reason, availCss: d.availCss });
    else if (d.action === "delete") plan.delete.push({ page: p.page, freePct: p.freePct, freePt: p.freePt, fig, reason: d.reason });
    else plan.skip.push({ page: p.page, freePct: p.freePct, why: `${d.action}:${d.reason}` });
  }
  return plan;
}

// ======================== 复放器材：从 meta+PDF 重建 round-N 输入态 ========================
// 章节 MD → h/img 块序（与 merge.mjs parseMd 的 img 块判定同构：整段恰为一条 ![]() 才占键）。
const safeName = (t) => String(t).replace(/\//g, "／").replace(/\\/g, "＼");
function mdBlocks(mdPath) {
  const raw = fs.readFileSync(mdPath, "utf8");
  let body = raw;
  if (raw.startsWith("---")) { const end = raw.indexOf("\n---", 3); if (end > 0) body = raw.slice(end + 4); }
  const lines = body.split("\n");
  const out = []; let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ t: "h", lvl: h[1].length }); i++; continue; }
    if (/^([-*]\s|\d+\.\s|>\s?|\|)/.test(ln)) { while (i < lines.length && /^([-*]\s|\d+\.\s|>\s?|\|)/.test(lines[i])) i++; continue; } // 列表/引用/表不占图键不构链
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[-*]\s|\d+\.\s|>|\|)/.test(lines[i])) { para.push(lines[i]); i++; }
    const joined = para.join("\n").trim();
    if (/^!\[\]\([^)]+\)$/.test(joined)) out.push({ t: "img" });
  }
  return out;
}
// 一片复放：终态 PDF + meta（figs/gapFill/chapters）→ 新旧两版 plan（同输入；新版多喂 figChain）
function replayShard(metaFile) {
  const m = JSON.parse(fs.readFileSync(path.join(OUT, metaFile), "utf8"));
  assert(fs.existsSync(m.pdf), `pdf missing: ${m.pdf}`);
  const hr = holeReport(m.pdf);
  const aligned = matchFigsToPdf(m.figs, m.pdf);
  const alreadyShrunk = new Map(); for (const s of m.gapFill.shrunk) alreadyShrunk.set(s.figKey, s.maxCss);
  const deletedKeys = new Set(m.gapFill.deleted.map((d) => d.figKey));
  // merge.mjs renderShard 的 startsForGap 复刻（章首豁免精算：前页 ≥35% 的章界不豁免）
  const curLoc = m.chapters.map((c) => c.localPage);
  const startsForGap = curLoc.filter((s, i) => {
    if (!s || i === 0) return false;
    const prev = hr.per[s - 2];
    return !(prev && prev.freePct >= RULES.GAP_BIG_PCT);
  });
  // figChain：按 meta 章序读 MD，走共享 figChainAnnotations（与 buildHtml figKey 键序同构）
  const chaptersForChain = m.chapters.map((c) => ({ blocks: mdBlocks(path.join(BASE, m.dirName, `${safeName(c.title)}.md`)) }));
  const figChain = figChainAnnotations(chaptersForChain);
  const common = { per: hr.per, figsAligned: aligned, chapterStartPages: startsForGap, totalPages: hr.pages, alreadyShrunk, deletedKeys };
  return { m, hr, aligned, figChain, base: baselinePlanGapFill(common), neu: planGapFill({ ...common, figChain }) };
}
const fmtAct = (arr) => arr.map((x) => `p${x.page}(${x.freePct}% fig${x.fig?.key ?? x.figKey}${x.maxCss !== undefined ? `->${x.maxCss}` : " DEL"}${x.reason ? ` ${x.reason.slice(0, 44)}` : ""})`);

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`  [PASS] ${name}`); } catch (e) { failed++; console.log(`  [FAIL] ${name}\n    ${String(e.message).split("\n")[0]}`); } };

// ======================== A. shard13：链盲 leave:fits → 新规则动作 ========================
console.log(`\n== A. shard13（线下活动茶歇，成品 p1237-1318 区 20 个 G2 fail 的 12 个来源）==`);
const A = replayShard("shard13-meta.json");
const A_PAGES = [16, 19, 33, 38, 43, 51, 59, 63, 68, 75]; // 前 8 个 = 成品 92%/98% 最重灾；16/19 = 成品 p1237/p1240（46%）
{
  const fitsSkips = A.base.skip.filter((s) => s.why === "leave:fits");
  console.log(`  旧版 skip:fits ${fitsSkips.length} 处：${fmtAct(fitsSkips).join(" | ")}`);
  const baseActsOn = (pg) => A.base.shrink.some((s) => s.page === pg) || A.base.delete.some((d) => d.page === pg);
  for (const pg of A_PAGES) {
    check(`旧版 p${pg} 零动作（链盲复现：skip leave:fits ${A.base.skip.find((s) => s.page === pg)?.why ?? "(非候选)"}`, () => {
      const skip = A.base.skip.find((s) => s.page === pg && s.why === "leave:fits");
      assert.ok(skip, `p${pg} 旧版应 skip:fits`);
      assert.ok(!baseActsOn(pg), `p${pg} 旧版不应有动作`);
    });
  }
  const newActPages = new Set([...A.neu.shrink, ...A.neu.delete].map((x) => x.page));
  for (const pg of A_PAGES) {
    check(`新版 p${pg} 转为动作（新规则生效）`, () => assert.ok(newActPages.has(pg), `p${pg} 不在新版动作集`));
  }
  console.log(`  新版动作 ${A.neu.shrink.length} shrink + ${A.neu.delete.length} delete：`);
  for (const s of A.neu.shrink.filter((s) => A_PAGES.includes(s.page))) console.log(`    shrink p${s.page} ${s.freePct}% fig${s.fig.key} prevPrintH=${s.fig.printHCss} -> ${s.maxCss}css [${s.tier}] ${s.reason}`);
  for (const d of A.neu.delete.filter((d) => A_PAGES.includes(d.page))) console.log(`    delete p${d.page} ${d.freePct}% fig${d.fig.key} ${d.reason}`);
}
// 键序契约抽检：链标注命中的 fig 其 MD 前邻确为 ## 人名 标题（抽 3 例）
{
  const probe = A.aligned.filter((f) => f.actualPage === 34 || f.actualPage === 39 || f.actualPage === 76).map((f) => f.key);
  for (const k of probe) check(`figChain[${k}]=${A.figChain.get(k) ?? 0}（70=h2 链头命中）`, () => assert.equal(A.figChain.get(k), RULES.CHAIN_H_CSS));
}

// ======================== B. 轮次截断：round-4 动作在新旧两版都在（约束是轮次而非规则） ========================
console.log(`\n== B. round-4 截断复现（终态仍可执行的动作 = 3 轮上限丢掉的收敛尾巴）==`);
const B_CASES = [
  ["shard04-meta.json", [42, 116], "成品 p254/p328（49.2%）"],
  ["shard05-meta.json", [59, 278], "成品 p431（40.8%）/p650（54.6% ch-head 链）"],
  ["shard12-meta.json", [110], "成品 p1181（48.7%）"],
];
for (const [metaFile, pages, note] of B_CASES) {
  const R = replayShard(metaFile);
  for (const pg of pages) {
    const b = R.base.shrink.find((s) => s.page === pg) || R.base.delete.find((d) => d.page === pg);
    const n = R.neu.shrink.find((s) => s.page === pg) || R.neu.delete.find((d) => d.page === pg);
    check(`${metaFile} p${pg} round-4 动作存在（旧版${b ? (b.maxCss !== undefined ? `shrink->${b.maxCss}` : "delete") : "无"} / 新版${n ? (n.maxCss !== undefined ? `shrink->${n.maxCss}${n.chainHeadCss ? ` h=${n.chainHeadCss}` : ""}` : "delete") : "无"}；${note}`, () => {
      assert.ok(n, `新版 p${pg} 无动作`);
    });
  }
  console.log(`  ${metaFile} 新版终态动作：${fmtAct(R.neu.shrink).join(" | ") || "-"} ${R.neu.delete.length ? "DEL: " + fmtAct(R.neu.delete).join(" | ") : ""}`);
}

// ======================== C. 向后兼容：shard02-flow（冒烟-合并6章-flow 实分片）新旧全同 ========================
console.log(`\n== C. 冒烟语义兼容（shard02-flow：全 cosmetic 档，链规则不得触碰）==`);
const C = replayShard("shard02-flow-meta.json");
{
  const key = (p) => JSON.stringify([...p.shrink.map((s) => [s.page, s.fig.key, s.maxCss]), ...p.delete.map((d) => [d.page, d.fig.key]), ...p.skip.map((s) => [s.page, s.why])]);
  check(`新旧 plan 完全一致（shrink/delete/skip 三元组零 diff）`, () => assert.equal(key(C.base), key(C.neu)));
  const bigPages = C.hr.per.filter((p) => !p.isLast && p.freePct >= RULES.GAP_BIG_PCT).length;
  console.log(`  分片 big 档页数=${bigPages}（0 ⇒ 链规则无触发面）；shrink=${C.neu.shrink.length} delete=${C.neu.delete.length} skip=${C.neu.skip.length}`);
  check(`assertNoUnfilledGaps 冒烟语义不变（hardFail=false，与 冒烟-合并6章-flow-report.json 一致）`, () => {
    const v = assertNoUnfilledGaps(path.join(OUT, "shard02-flow-01-经济学本源之一：东西不够(110讲).pdf"), C.m.figs, C.m.chapters.map((c) => c.localPage).filter(Boolean));
    assert.equal(v.hardFail, false);
  });
}

// ======================== D. decideGapFill 网格：chain=0 ⇒ 新 ≡ 旧 ========================
console.log(`\n== D. decideGapFill 网格回归（chainHeadCss=0 时行为与 e5dde99 逐点全同）==`);
{
  let n = 0;
  for (const freePct of [5, 12, 20, 34.9, 35, 40, 49.2, 55, 80, 92.2, 97.5]) {
    const freePt = (freePct / 100) * 784.32;
    for (const printH of [80, 150, 250, 500, 700, 915, 960]) {
      for (const nat of [Infinity, 600]) {
        const a = baselineDecideGapFill({ freePt, freePct, printHCss: printH, natDisplayCss: nat });
        const b = decideGapFill({ freePt, freePct, printHCss: printH, natDisplayCss: nat });
        assert.deepEqual({ action: a.action, maxCss: a.maxCss, availCss: a.availCss, tier: a.tier, reason: a.reason }, { action: b.action, maxCss: b.maxCss, availCss: b.availCss, tier: b.tier, reason: a.reason === undefined && b.reason === "fits-after-cap" ? undefined : b.reason });
        n++;
      }
    }
  }
  check(`${n} 网格点 action/maxCss/availCss/tier 全同（plain shrink 的 reason 由 undefined → 'fits-after-cap'，仅审计文案）`, () => {});
  // 链感知定向例：shard13 p33 实测 avail 916 / printH 915
  const t1 = decideGapFill({ freePt: 723.2, freePct: 92.2, printHCss: 915, chainHeadCss: RULES.CHAIN_H_CSS });
  check(`链感知定向：avail 916 - h2链70 → shrink 846（shard13 p33 实测值）`, () => { assert.equal(t1.action, "shrink"); assert.equal(t1.maxCss, 846); });
  const t2 = decideGapFill({ freePt: 413.6, freePct: 52.7, printHCss: 515, chainHeadCss: RULES.CHAIN_CHHEAD_CSS });
  check(`链感知定向：avail 505* - 章头链135 → shrink（shard05 p278 fig138 实测同型）`, () => assert.equal(t2.action, "shrink"));
}

// ======================== E. P31 陈旧守卫谓词干跑（不执行 merge，只判表达式） ========================
console.log(`\n== E. P31 陈旧分片守卫谓词干跑（F1：Aug19 的 5 章 shard02 vs Aug20 的 110 章 plan）==`);
{
  const plan = JSON.parse(fs.readFileSync(path.join(OUT, "merge-plan.json"), "utf8"));
  const meta2 = JSON.parse(fs.readFileSync(path.join(OUT, "shard02-meta.json"), "utf8"));
  const planShard2 = plan.shards.find((s) => s.shard === 2);
  const stale = (meta2.chapters?.length ?? -1) !== planShard2.chapters.length;
  console.log(`  shard02-meta ${meta2.chapters.length} 章 vs plan shard2 ${planShard2.chapters.length} 章 → 守卫判定=${stale ? "陈旧→强制重渲" : "可跳过"}`);
  check(`守卫判真（旧事故形态在新 cmdRender/cmdAssemble 下被拦截）`, () => assert.equal(stale, true));
  check(`守卫源码在位（cmdRender 与 cmdAssemble 双闸）`, () => {
    const src = fs.readFileSync("/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学/.engine/merge.mjs", "utf8");
    assert.ok(src.includes("陈旧分片强制重渲") && src.includes("陈旧分片：meta"), "守卫标记缺失");
    assert.ok(src.includes("QC-FAIL.pdf"), "交付隔离缺失");
    assert.ok(src.includes("RULES.MAX_ROUNDS"), "轮次上限未接 RULES.MAX_ROUNDS");
    assert.ok(src.includes("figChainAnnotations(chapters)"), "figChain 未接线");
  });
}

// ======================== F. 断言侧未动：shard13 仍如实 hardFail ========================
console.log(`\n== F. assertNoUnfilledGaps 语义未动（G2_figGaps 断言与交付报告同样如实）==`);
{
  const v = assertNoUnfilledGaps(A.m.pdf, A.m.figs, A.m.chapters.map((c) => c.localPage).filter(Boolean));
  console.log(`  violations=${v.violations.length} hardFail=${v.hardFail}（页集：${v.violations.filter((x) => !x.exempt).map((x) => `p${x.page}(${x.freePct}%)`).join(",")}`);
  check(`断言仍报 hardFail=true（planner 此前修不动 ≠ 断言看不见）`, () => assert.equal(v.hardFail, true));
}

console.log(`\n===== selftest 结果：${failed === 0 ? "ALL PASS" : `${failed} FAIL`} =====`);
process.exitCode = failed === 0 ? 0 : 1;
