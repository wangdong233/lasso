#!/usr/bin/env node
/**
 * dedao 探察 driver — 单 lasso server 会话内顺序执行多 phase（nav/eval/snap）。
 * 用法: node drive.mjs <phase...>   phase: nav | snap | e:<jsfile>
 * Chrome 前置：direct-launch @9224（不入 lasso 台账，免疫 exit-hook 杀）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const RAW = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学/探察raw";
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-probe", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>/tmp/dedao-drive-stderr.log"],
  cwd: repoRoot,
  env: { ...process.env, LASSO_CDP_PORT: "9224" },
});
await client.connect(transport);

async function browse(action, options = {}) {
  const res = await client.callTool(
    { name: "browse_logged_in", arguments: { url: TARGET, action, options } },
    undefined,
    { timeout: 120000 },
  );
  const t = res.content?.[0]?.text ?? "";
  try {
    const j = JSON.parse(t);
    return { outcome: j.outcome, error: j.error, preview: j.data?.preview ?? null };
  } catch {
    return { outcome: "parse_fail", preview: t.slice(0, 500) };
  }
}

const phases = process.argv.slice(2);
for (const ph of phases) {
  try {
    if (ph === "nav") {
      const r = await browse("navigate", { wait_until: "load", timeout_ms: 90000 });
      console.log("### nav:", r.outcome, r.error ?? "");
      // JS 轮询等 SPA 渲染（wait_for 上游超时不可靠）
      const w = await browse("evaluate", {
        js: `
const t0=Date.now();
async function poll(){while(Date.now()-t0<25000){const t=document.title||'';const b=(document.body&&document.body.innerText||'');if(t.includes('得到')||b.includes('经济学')||b.includes('发刊词'))return JSON.stringify({ok:true,title:t,ms:Date.now()-t0});await new Promise(r=>setTimeout(r,500));}return JSON.stringify({ok:false,title:document.title,ms:Date.now()-t0});}
return await poll();
`,
      });
      console.log("### poll:", w.outcome, (w.preview ?? "").slice(0, 200));
    } else if (ph === "snap") {
      const r = await browse("snapshot");
      fs.writeFileSync(path.join(RAW, "snapshot.txt"), r.preview ?? "");
      console.log("### snap len:", (r.preview ?? "").length);
    } else if (ph.startsWith("e:")) {
      const js = fs.readFileSync(ph.slice(2), "utf8");
      const r = await browse("evaluate", { js });
      console.log("### " + path.basename(ph.slice(2)) + " [" + r.outcome + "]");
      console.log(r.preview ?? JSON.stringify(r).slice(0, 400));
      if (r.error) console.log("ERR:", r.error);
    }
  } catch (e) {
    console.log("### " + ph + " CALL_FAILED:", String(e).slice(0, 300));
  }
}
await transport.close();
await new Promise((r) => setTimeout(r, 300));
