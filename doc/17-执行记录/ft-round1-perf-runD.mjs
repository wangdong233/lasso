#!/usr/bin/env node
/** ft-r11 Part D：T-ELICIT 场景 0 真机降级红线（c1-真机手测.md §0）
 *  MCP 客户端不声明 elicitation 能力 → 高风险步必须现行 didnt（byte-identical），
 *  且 elicitInput 零调用（守卫前置）。真机 Chrome 9222 + browse_logged_in steps 链。 */
import { withServer, timedCall, sleep } from "./ft-round1-perf-lib.mjs";
import { spawnSync } from "node:child_process";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const REPO = "/Users/wangdong/Documents/Project/cc-control-all/lasso";

// 1. 9222 被会话前进程占用且不服务 CDP HTTP（404 空体）——改用 9223 自起（lasso 台账内，面板收尾可停）。
const PORT = "9223";
spawnSync("/bin/zsh", ["-c", `cd ${REPO} && LASSO_CDP_PORT=${PORT} node dist/index.js launch-chrome --port ${PORT} --mode hidden`], { encoding: "utf8", timeout: 60000 });
let up = false;
for (let i = 0; i < 8; i++) {
  const p = spawnSync("curl", ["-s", "-m", "2", `http://127.0.0.1:${PORT}/json/version`], { encoding: "utf8" });
  if ((p.stdout ?? "").includes("Browser")) { up = true; log(PORT, "UP (lasso-launched hidden, poll", (i + 1) * 2, "s)"); break; }
  await sleep(2000);
}
if (!up) { console.log("FATAL: " + PORT + " not serving"); process.exit(1); }

const CASES = [
  { kind: "rte", file: "/tmp/ft-r11-hrisk-rte.html" },
  { kind: "drag_drop", file: "/tmp/ft-r11-hrisk-drag.html" },
];

// 本地 HTTP 供夹具（file:// 被 ssrfGuard protocol_not_allowed 拒——设计行为；127.0.0.1/32 在放行带）
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const httpSrv = createServer((req, res) => {
  const f = req.url === "/drag" ? "/tmp/ft-r11-hrisk-drag.html" : "/tmp/ft-r11-hrisk-rte.html";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(f));
});
await new Promise((r) => httpSrv.listen(0, "127.0.0.1", r));
const FIX_PORT = httpSrv.address().port;
log("fixture http on 127.0.0.1:" + FIX_PORT);

await withServer({ LASSO_CDP_PORT: "9223" }, async (c) => {
  for (const cs of CASES) {
    const url = cs.kind === "drag_drop" ? "http://127.0.0.1:" + FIX_PORT + "/drag" : "http://127.0.0.1:" + FIX_PORT + "/rte";
    // 先 navigate 加载 + 验证 focus 落在风险元素
    const nav = await timedCall(c, "browse_logged_in", { url, action: "navigate" }, 120000);
    log(cs.kind, "navigate ms=" + nav.ms, "outcome=" + nav.p?.outcome, "title=" + JSON.stringify((nav.p?.data?.title ?? "").slice(0, 30)));
    await sleep(1000);
    // 高风险步：click 带未注入 uid → gate activeElement 回退 → pattern 命中 → 无 elicitation 能力 → blocked
    const st = await timedCall(c, "browse_logged_in", {
      url, action: "navigate",
      options: { steps: [{ action: "click", selectors: { click: "999_999" } }] },
    }, 120000);
    const j = JSON.stringify(st.p ?? {});
    log(cs.kind, "steps ms=" + st.ms, "outcome=" + st.p?.outcome,
      "error=" + JSON.stringify((st.p?.error ?? "").toString().slice(0, 60)),
      "chain_error=" + JSON.stringify((j.match(/"error"\s*:\s*"[^"]{0,60}/g) ?? []).slice(0, 3)),
      "stopped=" + JSON.stringify((j.match(/"stopped_at"[^}]{0,120}/g) ?? [])),
      "high_risk_hit=" + (j.includes("high_risk_pattern:" + cs.kind) ? cs.kind : (j.match(/high_risk_pattern:\w+/)?.[0] ?? "none")));
    await sleep(2000);
  }
});

// 收尾：admin tab_restore（把借用 tab 恢复为用户原列表；T-LIFE-12 机制出口）
await withServer({ LASSO_CDP_PORT: "9223" }, async (c) => {
  const tr = await timedCall(c, "admin", { action: "tab_restore", reason: "ft-r11-scenario0-cleanup" }, 60000);
  log("tab_restore outcome=" + (tr.p?.outcome ?? tr.p?.data?.outcome));
});
const stop = spawnSync("node", ["dist/index.js", "chrome-stop", "--port", "9223"], { cwd: REPO, encoding: "utf8", timeout: 60000 });
log("chrome-stop 9223 exit=" + stop.status);
httpSrv.close();
