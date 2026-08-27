#!/usr/bin/env node
/** ft-r11 Part C：L-COST-12（launch-chrome hidden 冷启动）+ L-COST-13（read_text 续页）+ L-COST-14（include_refs 开销）。资源三采样。 */
import { withServer, timedCall, sleep, median, sampleLasso } from "./ft-round1-perf-lib.mjs";
import { spawnSync } from "node:child_process";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const REPO = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const cli = (args) => spawnSync("node", ["dist/index.js", ...args], { cwd: REPO, encoding: "utf8", timeout: 60000 });

// ---------- L-COST-12 ----------
const l12 = [];
for (let i = 0; i < 3; i++) {
  const before = sampleLasso();
  const t0 = Date.now();
  const r = cli(["launch-chrome", "--mode", "hidden"]);
  const ms = Date.now() - t0;
  const probe = spawnSync("curl", ["-s", "-m", "3", "http://127.0.0.1:9222/json/version"], { encoding: "utf8" });
  const peak = sampleLasso();
  const stop = cli(["chrome-stop", "--all"]);
  await sleep(2500);
  const after = sampleLasso();
  l12.push({ ms, cli_exit: r.status, cli_ok: (r.stdout ?? "").includes('"ok"'), probe_ok: (probe.stdout ?? "").includes("Browser"), stop_exit: stop.status });
  log("L12", `run${i + 1}`, JSON.stringify(l12[l12.length - 1]),
    "res", JSON.stringify({ b: `${before.count}/${before.rssKb}`, p: `${peak.count}/${peak.rssKb}`, a: `${after.count}/${after.rssKb}` }));
  await sleep(2000);
}
log("L12 MEDIAN_MS=" + median(l12.map((x) => x.ms)));

// ---------- L-COST-13 ----------
const WIKIS = ["https://en.wikipedia.org/wiki/Rust_(programming_language)", "https://en.wikipedia.org/wiki/JavaScript", "https://en.wikipedia.org/wiki/Python_(programming_language)"];
const l13 = [];
outer: for (let i = 0; i < 3; i++) {
  const before = sampleLasso();
  for (const url of WIKIS) {
    const hit = await withServer({}, async (c) => {
      const ex = await timedCall(c, "browse_headless", { url, action: "extract", options: { extract_mode: "markdown" } }, 240000);
      const text = JSON.stringify(ex.p ?? {});
      const m = text.match(/@o\d+/);
      if (!m) return null;
      const ref = m[0];
      await sleep(2000);
      const rt = await timedCall(c, "read_text", { ref, offset: 0, limit: 16384 });
      const chars = (rt.p?.data?.text ?? rt.p?.text ?? "").length;
      return { url, extract_ms: ex.ms, ref, read_ms: rt.ms, chars, outcome: rt.p?.data?.outcome ?? rt.p?.outcome };
    });
    if (hit) {
      await sleep(2500);
      const after = sampleLasso();
      l13.push(hit);
      log("L13", `run${i + 1}`, JSON.stringify(hit), "res", JSON.stringify({ b: `${before.count}/${before.rssKb}`, a: `${after.count}/${after.rssKb}` }));
      await sleep(2000);
      continue outer;
    }
    log("L13", `run${i + 1}`, "no spill on", url, "— trying next");
  }
}
if (l13.length) log("L13 MEDIAN_READ_MS=" + median(l13.map((x) => x.read_ms)));

// ---------- L-COST-14 ----------
const l14 = [];
for (let i = 0; i < 3; i++) {
  const before = sampleLasso();
  await withServer({}, async (c) => {
    const a = await timedCall(c, "browse_headless", { url: "https://books.toscrape.com/", action: "extract", options: { extract_mode: "markdown" } }, 240000);
    await sleep(2000);
    const b = await timedCall(c, "browse_headless", { url: "https://books.toscrape.com/", action: "extract", options: { extract_mode: "markdown", include_refs: true } }, 240000);
    const bText = JSON.stringify(b.p ?? {});
    l14.push({
      no_refs_ms: a.ms, refs_ms: b.ms, diff: b.ms - a.ms,
      refs_in_appendix: (bText.match(/\[r\d+\]/g) ?? []).length,
      appendix_heading: bText.includes("Interactive refs"),
      ignored_flag: bText.includes("ignored_include_refs"),
    });
  });
  await sleep(2500);
  const after = sampleLasso();
  log("L14", `run${i + 1}`, JSON.stringify(l14[l14.length - 1]), "res", JSON.stringify({ b: `${before.count}/${before.rssKb}`, a: `${after.count}/${after.rssKb}` }));
  await sleep(2000);
}
log("L14 MEDIAN_DIFF_MS=" + median(l14.map((x) => x.diff)));
