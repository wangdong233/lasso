#!/usr/bin/env node
/**
 * dedao 探察脚本 — 阶段化 probe（持久 MCP 会话，lasso browse_logged_in @ CDP 9226）。
 * 用法: node probe.mjs <phase> [argFile]
 *   phase = nav | eval <file-with-js> | snap
 * 输出: stdout = 工具返回 JSON（截断到 PREVIEW_MAX_CHARS=4000 的 preview 字段）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";

const repoRoot = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-probe", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>/tmp/dedao-probe-stderr.log"],
  cwd: repoRoot,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);

async function browseLogged(action, options = {}) {
  const res = await client.callTool(
    { name: "browse_logged_in", arguments: { url: TARGET, action, options } },
    undefined,
    { timeout: 120000 },
  );
  return res;
}

function previewOf(res) {
  try {
    const t = res.content?.[0]?.text ?? "";
    const j = JSON.parse(t);
    return { outcome: j.outcome, error: j.error, preview: j.data?.preview };
  } catch {
    return { raw: String(res.content?.[0]?.text).slice(0, 800) };
  }
}

const phase = process.argv[2];
try {
  if (phase === "nav") {
    const res = await browseLogged("navigate", {
      wait_until: "networkidle",
      timeout_ms: 90000,
    });
    console.log(JSON.stringify(previewOf(res), null, 1));
    // 等 SPA 渲染 + 轮询标题出现
    const w = await browseLogged("wait", {
      expect: { text: "经济学", timeout_ms: 30000 },
    });
    console.log("WAIT:", JSON.stringify(previewOf(w)));
  } else if (phase === "snap") {
    const res = await browseLogged("snapshot");
    const p = previewOf(res);
    fs.writeFileSync(
      "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学/探察raw/snapshot.txt",
      p.preview ?? JSON.stringify(p),
    );
    console.log("SNAP_LEN:", (p.preview ?? "").length);
    console.log((p.preview ?? "").slice(0, 1500));
  } else if (phase === "eval") {
    const js = fs.readFileSync(process.argv[3], "utf8");
    const res = await browseLogged("evaluate", { js });
    console.log(previewOf(res).preview ?? JSON.stringify(previewOf(res)));
  }
} catch (e) {
  console.log("CALL_FAILED:", String(e).slice(0, 500));
} finally {
  await transport.close();
  await new Promise((r) => setTimeout(r, 300));
}
