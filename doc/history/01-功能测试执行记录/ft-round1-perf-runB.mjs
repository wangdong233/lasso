#!/usr/bin/env node
/** ft-r11 Part B：L-COST-04（ssrf 拒绝→browse 兜底，资源三采样）+ L-COST-08/09（fetch_feed）+ L-COST-10/11（search_local） */
import { withServer, timedCall, sleep, median, sampleLasso } from "./ft-round1-perf-lib.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- L-COST-04：serp_http 被 SSRF 拒 → browse_headless 兜底 ----------
const l04 = [];
for (let i = 0; i < 3; i++) {
  const before = sampleLasso();
  await withServer(
    { LASSO_MACHINE_CLAUDE_JSON_PATH: "/nonexistent", LASSO_SSRF_DENY_RANGES: "0.0.0.0/0,::/0" },
    async (c) => {
      const r = await timedCall(c, "search", { query: "rust tokio tutorial", limit: 10, no_cache: true }, 240000);
      const d = r.p?.data ?? {};
      l04.push({
        ms: r.ms, served_by: d.served_by ?? r.p?.served_by,
        actions: (d.actions_and_results ?? []).map((a) => `${a.action ?? a.channel}:${a.outcome ?? a.result}:${(a.reason ?? a.error ?? "").toString().slice(0, 40)}`),
        n: d.results?.length ?? 0,
      });
    },
  );
  await sleep(500);
  const after = sampleLasso();
  log("L04", `run${i + 1}`, JSON.stringify(l04[l04.length - 1]), "res", JSON.stringify({ b: before.count + "/" + before.rssKb, a: after.count + "/" + after.rssKb }));
  await sleep(2000);
}
log("L04 MEDIAN_MS=" + median(l04.map((x) => x.ms)));

// ---------- L-COST-08/09：fetch_feed ----------
async function feedRun(label, url) {
  const out = [];
  await withServer({}, async (c) => {
    for (let i = 0; i < 3; i++) {
      const r = await timedCall(c, "fetch_feed", { url, limit: 5 });
      const d = r.p?.data ?? r.p ?? {};
      out.push({
        ms: r.ms, outcome: d.outcome ?? r.p?.outcome, isError: r.isError,
        entries: (d.entries ?? d.items ?? []).length,
        truncated_input: d.truncated_input ?? r.p?.truncated_input ?? false,
        error: (d.error ?? r.p?.error ?? "").toString().slice(0, 60),
        first_title: ((d.entries ?? d.items ?? [])[0]?.title ?? "").slice(0, 40),
      });
      log(label, `run${i + 1}`, JSON.stringify(out[out.length - 1]));
      await sleep(2000);
    }
  });
  log(label, "MEDIAN_MS=" + median(out.map((o) => o.ms)));
}
await feedRun("L08-feed-github", "https://github.com/anthropics/claude-code/releases.atom");
await feedRun("L09-feed-ruanyifeng", "https://www.ruanyifeng.com/blog/atom.xml");

// ---------- L-COST-10/11：search_local ----------
async function localRun(label, args) {
  const out = [];
  await withServer({}, async (c) => {
    for (let i = 0; i < 3; i++) {
      const r = await timedCall(c, "search_local", args);
      const d = r.p?.data ?? r.p ?? {};
      out.push({
        ms: r.ms, outcome: d.outcome ?? r.p?.outcome, isError: r.isError,
        results: (d.results ?? []).length,
        profiles: (d.profiles_searched ?? []).length ?? undefined,
        error: (d.error ?? r.p?.error ?? (typeof d.reason === "string" ? d.reason : "")).toString().slice(0, 50),
      });
      log(label, `run${i + 1}`, JSON.stringify(out[out.length - 1]));
      await sleep(2000);
    }
  });
  log(label, "MEDIAN_MS=" + median(out.map((o) => o.ms)));
}
await localRun("L10-local-history", { query: "lasso", limit: 5, source: "history" });
await localRun("L11-local-files", { query: "lasso", limit: 5, source: "files" });
