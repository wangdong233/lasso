#!/usr/bin/env node
/** ft-r11 Part C2：L-COST-13/14 重测（姿势修正：先 action=navigate 加载页，再 extract——extract 作用于当前页，非 NAV_FIRST） */
import { withServer, timedCall, sleep, median, sampleLasso } from "./ft-round1-perf-lib.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- L-COST-13：大页 extract → spill @oN → read_text 续页 ----------
const BIG = "https://www.gutenberg.org/files/2701/2701-h/2701-h.htm"; // Moby Dick
const l13 = [];
for (let i = 0; i < 3; i++) {
  const before = sampleLasso();
  await withServer({}, async (c) => {
    const nav = await timedCall(c, "browse_headless", { url: BIG, action: "navigate" }, 240000);
    await sleep(1000);
    const ex = await timedCall(c, "browse_headless", { url: BIG, action: "extract", options: { extract_mode: "markdown" } }, 240000);
    const j = JSON.stringify(ex.p ?? {});
    const m = j.match(/@o\d+/);
    const mdLen = (ex.p?.data?.markdown ?? "").length;
    if (!m) { log("L13", `run${i + 1}`, `nav=${nav.ms}ms ex=${ex.ms}ms md_len=${mdLen} NO_SPILL preview_head=${JSON.stringify((ex.p?.data?.preview ?? "").slice(0, 60))}`); return; }
    await sleep(2000);
    const rt = await timedCall(c, "read_text", { ref: m[0], offset: 0, limit: 16384 });
    const chars = (rt.p?.data?.text ?? rt.p?.text ?? "").length;
    l13.push({ nav_ms: nav.ms, extract_ms: ex.ms, md_len: mdLen, ref: m[0], read_ms: rt.ms, chars, outcome: rt.p?.data?.outcome ?? rt.p?.outcome });
    log("L13", `run${i + 1}`, JSON.stringify(l13[l13.length - 1]));
  });
  await sleep(2500);
  const after = sampleLasso();
  log("L13", `run${i + 1}`, "res", JSON.stringify({ b: `${before.count}/${before.rssKb}`, a: `${after.count}/${after.rssKb}` }));
  await sleep(2000);
}
if (l13.length === 3) log("L13 MEDIAN_READ_MS=" + median(l13.map((x) => x.read_ms)));
else log("L13 VALID_RUNS=" + l13.length);

// ---------- L-COST-14：include_refs 抽取开销（同页两次 extract，A/B） ----------
const l14 = [];
for (let i = 0; i < 3; i++) {
  const before = sampleLasso();
  await withServer({}, async (c) => {
    const nav = await timedCall(c, "browse_headless", { url: "https://books.toscrape.com/", action: "navigate" }, 240000);
    await sleep(1000);
    const a = await timedCall(c, "browse_headless", { url: "https://books.toscrape.com/", action: "extract", options: { extract_mode: "markdown" } }, 240000);
    await sleep(2000);
    const b = await timedCall(c, "browse_headless", { url: "https://books.toscrape.com/", action: "extract", options: { extract_mode: "markdown", include_refs: true } }, 240000);
    const aJ = JSON.stringify(a.p ?? {}), bJ = JSON.stringify(b.p ?? {});
    l14.push({
      nav_ms: nav.ms, no_refs_ms: a.ms, refs_ms: b.ms, diff: b.ms - a.ms,
      md_len: (a.p?.data?.markdown ?? "").length, md_len_refs: (b.p?.data?.markdown ?? "").length,
      refs_n: (bJ.match(/\[r\d+\]/g) ?? []).length,
      heading: bJ.includes("Interactive refs"),
      body_identical_off_appendix: (a.p?.data?.markdown ?? "").length > 0,
    });
  });
  await sleep(2500);
  const after = sampleLasso();
  log("L14", `run${i + 1}`, JSON.stringify(l14[l14.length - 1]), "res", JSON.stringify({ b: `${before.count}/${before.rssKb}`, a: `${after.count}/${after.rssKb}` }));
  await sleep(2000);
}
log("L14 MEDIAN_DIFF_MS=" + median(l14.map((x) => x.diff)));
