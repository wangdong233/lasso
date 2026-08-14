// wave2：T-TOOLS-08 回归 + read_text 新工具实测（spill → @oN 续读）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stderrLog = path.join(here, "wave2-tools-stderr.log");

const client = new Client({ name: "lasso-wave2-tools", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env },
});
await client.connect(transport);

const parse = (res) => {
  const t = res?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 400) }; }
};
const call = async (name, args) =>
  parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }));

// 0) tools/list 断言 read_text 在场
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("TOOLS:", JSON.stringify(tools));

// 1) example.com 正常抓取
const r1 = await call("fetch_url", { url: "https://example.com" });
console.log("R1 example.com:", JSON.stringify({
  outcome: r1.outcome, body_kind: r1.data?.body_kind, body_bytes: r1.data?.body_bytes,
}));

// 2) redirect/2 不跟随
const r2 = await call("fetch_url", { url: "https://httpbin.org/redirect/2" });
console.log("R2 redirect/2:", JSON.stringify({
  outcome: r2.outcome, retrieval_method: r2.retrieval_method,
  body_kind: r2.data?.body_kind, location: r2.data?.location, error: r2.error,
}));

// 3) markdown 模式
const r3 = await call("fetch_url", { url: "https://example.com", mode: "markdown" });
console.log("R3 markdown:", JSON.stringify({
  outcome: r3.outcome, body_kind: r3.data?.body_kind,
  preview_head: String(r3.data?.preview ?? "").slice(0, 60),
}));

// 4) >48KiB 大页 → spill + @oN ref
const r4 = await call("fetch_url", { url: "https://en.wikipedia.org/wiki/Long_page", mode: "markdown" });
console.log("R4 spill:", JSON.stringify({
  outcome: r4.outcome, truncated: r4.truncated, ref: r4.ref,
  total_bytes: r4.total_bytes, continue_hint: (r4.continue_hint ?? "").slice(0, 80),
  spill_path: r4.spill_path ?? r4.data?.spill_path, error: r4.error,
}));

const ref = r4.ref;
if (ref) {
  // spill 文件事实核查
  const spillDir = path.join(os.tmpdir(), "lasso-output");
  const files = fs.existsSync(spillDir)
    ? fs.readdirSync(spillDir).map((f) => {
        const st = fs.statSync(path.join(spillDir, f));
        return { f, size: st.size, mode: st.mode.toString(8) };
      })
    : [];
  console.log("SPILL_DIR:", JSON.stringify(files.filter((x) => x.f === `${ref}.txt` || x.f.startsWith(ref))));

  // 5) read_text 续读（新工具）
  const rt1 = await call("read_text", { ref });
  const t1 = typeof rt1 === "string" ? rt1 : rt1;
  console.log("RT1 read_text full:", JSON.stringify({
    outcome: rt1.outcome, retrieval_method: rt1.retrieval_method,
    bytes: rt1.data?.bytes ?? rt1.data?.total_bytes, error: rt1.error,
    text_head: String(rt1.data?.text ?? rt1.data?.preview ?? "").slice(0, 60),
  }));
  // 6) offset 续读
  const rt2 = await call("read_text", { ref, offset: 100 });
  console.log("RT2 read_text offset=100:", JSON.stringify({
    outcome: rt2.outcome, error: rt2.error,
    text_head: String(rt2.data?.text ?? rt2.data?.preview ?? "").slice(0, 60),
    bytes: rt2.data?.bytes,
  }));
  // 7) 坏 ref
  const rt3 = await call("read_text", { ref: "@o999" });
  console.log("RT3 bad ref:", JSON.stringify({ outcome: rt3.outcome, error: rt3.error, retrieval_method: rt3.retrieval_method }));
}

await transport.close().catch(() => {});
process.exit(0);
