#!/usr/bin/env node
/** ft-r11 probe：rte fixture 上 activeElement 状态（文件版，避开 shell 转义） */
import { withServer, timedCall, sleep } from "./ft-round1-perf-lib.mjs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const srv = createServer((q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(readFileSync("/tmp/ft-r11-hrisk-rte.html")); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
spawnSync("/bin/zsh", ["-c", "LASSO_CDP_PORT=9223 node dist/index.js launch-chrome --port 9223 --mode hidden"], { cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso", encoding: "utf8", timeout: 60000 });
for (let i = 0; i < 8; i++) {
  const p = spawnSync("curl", ["-s", "-m", "2", "http://127.0.0.1:9223/json/version"], { encoding: "utf8" });
  if ((p.stdout ?? "").includes("Browser")) break;
  await sleep(2000);
}
const url = "http://127.0.0.1:" + port + "/";
await withServer({ LASSO_CDP_PORT: "9223" }, async (c) => {
  const nav = await timedCall(c, "browse_logged_in", { url, action: "navigate" }, 120000);
  console.log("nav outcome=" + nav.p?.outcome, "ms=" + nav.ms);
  const js = "return JSON.stringify({ae: document.activeElement ? document.activeElement.id + \"/\" + document.activeElement.tagName : null, ceFound: !!document.querySelector('[contenteditable]'), focusReport: document.activeElement ? document.activeElement.getAttribute('contenteditable') : null})";
  const ev = await timedCall(c, "browse_logged_in", { url, action: "evaluate", options: { js } }, 120000);
  console.log("eval outcome=" + ev.p?.outcome, "preview=" + JSON.stringify((ev.p?.data?.preview ?? "").slice(0, 220)));
});
spawnSync("/bin/zsh", ["-c", "cd /Users/wangdong/Documents/Project/cc-control-all/lasso && node dist/index.js chrome-stop --port 9223"], { encoding: "utf8", timeout: 60000 });
srv.close();
