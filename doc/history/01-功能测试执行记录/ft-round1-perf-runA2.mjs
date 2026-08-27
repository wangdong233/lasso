#!/usr/bin/env node
/** ft-r11 Part A2：L-COST-05/06 重测（方法修正：每轮 rm search-cache，warm→base(缓存命中)→cb(命中+第二跳)） */
import { withServer, timedCall, sleep, median } from "./ft-round1-perf-lib.mjs";
import { rmSync } from "node:fs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const CACHE = process.env.HOME + "/.cache/lasso/search-cache";
const RUNS = 3;

async function incrementRun(label, query, cb) {
  const out = [];
  for (let i = 0; i < RUNS; i++) {
    rmSync(CACHE, { recursive: true, force: true });
    await withServer({}, async (c) => {
      const warm = await timedCall(c, "search", { query, limit: 10 });
      const wServed = warm.p?.data?.served_by ?? warm.p?.served_by;
      const wN = warm.p?.data?.results?.length ?? 0;
      await sleep(2000);
      const base = await timedCall(c, "search", { query, limit: 10 });
      const bCached = base.p?.cached, bN = base.p?.data?.results?.length ?? 0;
      await sleep(2000);
      const withCb = await timedCall(c, "search", { query, limit: 10, content_blocks: cb });
      const results = withCb.p?.data?.results ?? [];
      out.push({
        warm_ms: warm.ms, warm_served: wServed, warm_n: wN,
        base_ms: base.ms, base_cached: bCached, base_n: bN,
        cb_ms: withCb.ms, inc: withCb.ms - base.ms,
        cs: results.slice(0, cb).map((r) => r.content_status ?? null),
        chars: results.reduce((a, x) => a + (x.content?.length ?? 0), 0),
      });
    });
    log(label, `run${i + 1}`, JSON.stringify(out[out.length - 1]));
    await sleep(2000);
  }
  log(label, "MEDIAN_INCREMENT_MS=" + median(out.map((o) => o.inc)));
}

await incrementRun("L05-cb3-EN", "rust tokio tutorial", 3);
await incrementRun("L06-cb5-EN", "rust tokio tutorial", 5);
rmSync(CACHE, { recursive: true, force: true }); // 收尾清理，避免污染后续测量/其他用例
log("search-cache purged (final)");
