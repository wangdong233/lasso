/**
 * mcp-client-handshake.spec.ts（PERF-5，2026-09-02 perf/acc 轮 2：
 * 冷启动挂起归因与修的真闸门）
 *
 * 归因（白盒，SDK 1.30.0 实读）：Client.connect 的 initialize 请求走
 * protocol.js DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000 默认超时——此前 connectStdio
 * 无显式预算，spawn 卡死（代理黑洞下 npx 首装/registry 解析悬置）时每次尝试挂
 * 60s，叠加 _spawnWithBackoff 5 次 × 2/4/8/16s 退避 = 最坏 ~330s；且失败路径只
 * 走 SDK close（stdin/SIGTERM/SIGKILL 直子进程，G5 实证不转发下层树）→ 泄漏。
 *
 * 测试策略：真实 child_process（不 mock——超时/树杀断言的是真实进程语义）：
 *  - H1 永不应答进程 + 700ms 预算 → mcp_handshake_timeout 快速 reject + 进程树真死
 *  - H2 快速失败（exit 3）语义保持（非超时错误，毫秒级 reject）
 *  - H3 真握手成功（最小 MCP stdio 服务器回 initialize）→ connected + listTools 通
 *  - H4 env LASSO_MCP_HANDSHAKE_TIMEOUT_MS 覆盖默认（非法值回默认）
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { McpClient } from "../../src/subprocess/McpClient.js";
import {
  DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS,
  defaultHandshakeTimeoutMs,
} from "../../src/subprocess/McpClient.js";

/** 判定 pid 是否仍存活（signal 0 探测）。 */
function isAlive(pid: number | undefined | null): boolean {
  if (pid === undefined || pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitExited(pid: number | undefined | null, waitMs = 3000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

/** pgrep 判 marker 进程是否残留（树杀验证——pid 从外部不可得时用 marker 兜底）。 */
function markerAlive(marker: string): boolean {
  try {
    const out = execSync(`pgrep -f ${marker} || true`).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

const OPTS = { name: "handshake-spec", version: "0.1.0" };

describe("McpClient.connectStdio —— 握手预算 + 失败树杀（PERF-5）", () => {
  afterEach(() => {
    delete process.env.LASSO_MCP_HANDSHAKE_TIMEOUT_MS;
  });

  it("H1 永不应答 + 700ms 预算 → mcp_handshake_timeout + 子进程树真死（不泄漏）", async () => {
    const marker = "lasso-hs-orphan-probe";
    const t0 = Date.now();
    await expect(
      McpClient.connectStdio(OPTS, {
        command: process.execPath,
        args: [
          "-e",
          `process.title=${JSON.stringify(marker)}; setInterval(() => {}, 1 << 30);`,
        ],
      }, 700),
    ).rejects.toThrow(/mcp_handshake_timeout/);
    const dt = Date.now() - t0;
    // 快速失败：预算 700ms + 清理余量，绝不该等 SDK 默认 60s
    expect(dt).toBeLessThan(5_000);
    // 树杀验证：marker 进程不残留（旧实现只 SDK close——SIGTERM 直子进程，
    // 本例直子进程即唯一进程，但若只 close 不树杀且进程忽略 stdin 关闭则泄漏）
    const exited = await new Promise<boolean>((resolve) => {
      // CI 修正：树杀（kill-tree 递归 + 进程退出）在慢 runner 上可超 3s 窗
      // （本地 783ms / CI ubuntu 慢盘偶超）——10s 窗仍远小于 SDK 默认 60s 语义
      const deadline = Date.now() + 10_000;
      const poll = () => {
        if (!markerAlive(marker)) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 100);
      };
      poll();
    });
    expect(exited).toBe(true);
  });

  it("H2 快速失败（进程立即 exit 3）→ 快速 reject，非超时错误（语义保持）", async () => {
    const t0 = Date.now();
    await expect(
      McpClient.connectStdio(OPTS, {
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
      }, 20_000),
    ).rejects.toThrow();
    // 毫秒级失败（不是 20s 超时）
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("H3 真握手成功（最小 MCP stdio 服务器）→ connected + listTools 通 + pid 在", async () => {
    const c = await McpClient.connectStdio(
      OPTS,
      {
        command: process.execPath,
        args: ["-e", MINI_MCP_SERVER],
      },
      15_000,
    );
    try {
      expect(c.isConnected).toBe(true);
      expect(c.pid).not.toBeNull();
      const tools = await c.listTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(0);
    } finally {
      const pid = c.pid;
      await c.close();
      expect(await waitExited(pid)).toBe(true);
    }
  });

  it("H4 env 覆盖默认预算；非法值回默认", () => {
    process.env.LASSO_MCP_HANDSHAKE_TIMEOUT_MS = "1234";
    expect(defaultHandshakeTimeoutMs()).toBe(1234);
    delete process.env.LASSO_MCP_HANDSHAKE_TIMEOUT_MS;
    expect(defaultHandshakeTimeoutMs()).toBe(DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS);
    process.env.LASSO_MCP_HANDSHAKE_TIMEOUT_MS = "not-a-number";
    expect(defaultHandshakeTimeoutMs()).toBe(DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS);
  });
});

/** 最小 MCP stdio 服务器：按行读 JSON-RPC，initialize 回显 protocolVersion。 */
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
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
          capabilities: {},
          serverInfo: { name: "mini-mcp", version: "0.0.1" },
        },
      }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [] },
      }) + "\\n");
    }
  }
});
setInterval(() => {}, 1 << 30);
`;
