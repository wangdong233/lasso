#!/usr/bin/env node
// wave2 helper: node run.mjs <tool> <json-args> [envKey=val ...]
// spawns mcp.mjs, parses inner JSON, prints compact digest
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const [tool, argsJson] = process.argv.slice(2);
const here = "/Users/wangdong/Documents/Project/cc-control-all/lasso/doc/17-执行记录";
const out = execFileSync("node", ["mcp.mjs", tool, argsJson ?? "{}"], {
  cwd: here,
  env: { ...process.env, MCP_TIMEOUT_MS: process.env.MCP_TIMEOUT_MS ?? "180000" },
  timeout: 200000,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
// strip nvm noise lines before first '{'
const start = out.indexOf("{");
const json = out.slice(start === -1 ? 0 : start);
let res;
try { res = JSON.parse(json); } catch { console.log(out); process.exit(1); }
const inner = res.content?.[0]?.text;
if (inner === undefined) { console.log(JSON.stringify(res, null, 2)); process.exit(0); }
let t;
try { t = JSON.parse(inner); } catch { console.log(inner); process.exit(0); }
const dg = {
  outcome: t.outcome,
  served_by: t.served_by,
  data: t.data,
  status: t.status,
};
console.log(JSON.stringify(dg, null, 2).slice(0, 6000));
if (t.error) console.log("ERROR_FIELD:", JSON.stringify(t.error));
