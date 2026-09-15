/**
 * bug08-b-subproc-wiring.spec.ts（BUG-08 决议 B-2 接线面，doc/bugs/08）
 *
 * SubprocessManager._spawnWithBackoff 的 sidecar 接线钉：
 *  - spawn 前：孤儿扫除真实触发（陈旧记录收敛；活 owner 记录豁免）
 *  - spawn 后：spawn 即登记（ownerPid = 本 server 进程）
 *  - _kill：优雅 kill 同步清登记
 *  - killAllSync：exit 钩子清本 owner 全部登记
 *
 * 真实子进程（最小 MCP stdio 服务器——mcp-client-handshake.spec MINI_MCP_SERVER
 * 同款；sweep/登记断言的是真实 spawn 通路，mock 无意义）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import { readStacksSync } from "../../src/subprocess/headless-stack-ledger.js";

/** 最小 MCP stdio 服务器（initialize + tools/list 应答即可过握手）。 */
const MINI_MCP_SERVER = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mini", version: "0.0.1" } },
      }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1 << 30);
`;

let dir: string;
let sidecar: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lasso-b08b-wire-"));
  sidecar = path.join(dir, "headless-stacks.json");
  process.env.LASSO_HEADLESS_STACKS_PATH = sidecar;
});

afterEach(() => {
  delete process.env.LASSO_HEADLESS_STACKS_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function miniSpec() {
  return {
    command: process.execPath,
    args: ["-e", MINI_MCP_SERVER],
    mcpClientName: "bug08b-wire-spec",
  };
}

describe("BUG-08 B-2 — SubprocessManager sidecar 接线（真子进程）", () => {
  it("spawn 前扫除触发：陈旧记录（owner 死+pid 死）被清；活 owner 记录豁免；spawn 后登记新条", async () => {
    const mgr = new SubprocessManager();
    // 预置两条：①陈旧（owner 死 + pid 死 → sweep 清）；②活 owner 豁免（pid 死也
    // 不清——归并第一道就是 owner 判定）
    rmSync(sidecar, { force: true });
    const { appendStackRecord } = await import(
      "../../src/subprocess/headless-stack-ledger.js"
    );
    appendStackRecord({ specName: "headless", pid: 999_901, ownerPid: 999_902, spawnedAt: Date.now() - 3_600_000 });
    appendStackRecord({ specName: "headless", pid: 999_903, ownerPid: process.pid, spawnedAt: Date.now() });

    mgr.registerSpec("bug08b-1", miniSpec());
    const c = await mgr.ensureRunning("bug08b-1");
    try {
      const after = readStacksSync();
      // 陈旧条被 spawn 前扫除清掉
      expect(after.some((r) => r.pid === 999_901)).toBe(false);
      // 活 owner 条豁免保留（归并零动作）
      expect(after.some((r) => r.pid === 999_903 && r.ownerPid === process.pid)).toBe(true);
      // 新栈已登记（spawn 即登记，owner = 本进程）
      expect(after.some((r) => r.pid === c.pid && r.ownerPid === process.pid && r.specName === "bug08b-1")).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  }, 20_000);

  it("_kill（forgetSpec/shutdown 路径）同步清该 pid 登记", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("bug08b-2", miniSpec());
    const c = await mgr.ensureRunning("bug08b-2");
    expect(readStacksSync().some((r) => r.pid === c.pid)).toBe(true);
    await mgr.forgetSpec("bug08b-2");
    // 优雅 kill 后登记即清（不留陈旧记录给 sweep 判定）
    expect(readStacksSync().some((r) => r.pid === c.pid)).toBe(false);
  }, 20_000);

  it("killAllSync（exit 钩子）清本 ownerPid 全部登记", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("bug08b-3", miniSpec());
    await mgr.ensureRunning("bug08b-3");
    expect(readStacksSync().some((r) => r.ownerPid === process.pid)).toBe(true);
    mgr.killAllSync();
    expect(readStacksSync().some((r) => r.ownerPid === process.pid)).toBe(false);
  }, 20_000);
});
