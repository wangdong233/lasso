#!/usr/bin/env node
/** 判定 L05 零增量：单 server 全链探查 cache 命中 + cb=3 的完整响应与 content_hop 日志 */
import { withServer, timedCall, sleep } from "./ft-round1-perf-lib.mjs";
const Q = "rust tokio tutorial";
await withServer({}, async (c) => {
  const fill = await timedCall(c, "search", { query: Q, limit: 10, no_cache: true });
  console.log("FILL", fill.ms, "ms outcome=", fill.p?.data?.outcome, "served=", fill.p?.data?.served_by, "n=", fill.p?.data?.results?.length);
  await sleep(1500);
  const base = await timedCall(c, "search", { query: Q, limit: 10 });
  console.log("BASE", base.ms, "ms cached=", base.p?.cached, "outcome=", base.p?.data?.outcome, "n=", base.p?.data?.results?.length);
  await sleep(1500);
  const cb = await timedCall(c, "search", { query: Q, limit: 10, content_blocks: 3 });
  console.log("CB3", cb.ms, "ms cached=", cb.p?.cached, "outcome=", cb.p?.data?.outcome, "n=", cb.p?.data?.results?.length);
  console.log("CB3 first result keys:", JSON.stringify(Object.keys(cb.p?.data?.results?.[0] ?? {})));
  console.log("CB3 results[0..2] content_status:", JSON.stringify((cb.p?.data?.results ?? []).slice(0,3).map(r => r.content_status ?? null)));
  console.log("CB3 content_chars:", (cb.p?.data?.results ?? []).reduce((a,x)=>a+(x.content?.length??0),0));
  console.log("CB3 quality:", cb.p?.data?.quality, "served_by:", cb.p?.data?.served_by);
});
