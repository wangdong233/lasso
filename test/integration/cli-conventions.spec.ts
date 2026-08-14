/**
 * cli-conventions.spec.ts（F-CLI-01 修复，v1.8 Phase D）
 *
 * 守护点：argv 白名单外一切参数此前静默落入 MCP server 模式 —— stdout 0 字节、
 * 终端挂起等 stdin（wave1 entry-cli 面板实锤）。补 CLI 惯例三分支：
 *  1. --version / -v  → 输出版本号（package.json 单一真源）exit 0
 *  2. --help / -h     → usage（含四个子命令 + flags）exit 0
 *  3. 未知子命令      → usage 到 stderr + exit 1（不再挂起等 stdin）
 *
 * 实现说明（doctor-cli-config-file.spec.ts 同范式）：
 *  - spawnSync 真 spawn `node dist/index.js`（端到端验证 CLI dispatch 路径）
 *  - dist/ 不存在时 skip（dev 工作流不强制；Phase gate 先 npm run build）
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

function describeOrSkip(name: string, fn: () => void) {
  if (!existsSync(DIST_ENTRY)) {
    describe.skip(name, fn);
    return;
  }
  describe(name, fn);
}

function runCli(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const r = spawnSync(process.execPath, [DIST_ENTRY, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    // stdin 立即关闭：若误入 MCP server 模式会立刻暴露（而非挂起等输入）
    input: "",
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

describeOrSkip("CLI 惯例（F-CLI-01：--version / --help / 未知子命令）", () => {
  const pkgVersion = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version: string };

  it("--version → 输出 package.json 版本号，exit 0", () => {
    const r = runCli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkgVersion.version);
  });

  it("-v 短flag 同 --version（exit 0 + 版本号）", () => {
    const r = runCli(["-v"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkgVersion.version);
  });

  it("--help → usage 含四个子命令 + exit 0（stdout）", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    for (const kw of [
      "doctor",
      "config",
      "launch-chrome",
      "replay-baseline",
      "--stealth-check",
    ]) {
      expect(r.stdout).toContain(kw);
    }
  });

  it("-h 短flag 同 --help（exit 0）", () => {
    const r = runCli(["-h"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage");
  });

  it("未知子命令 → usage 到 stderr + exit 1（不静默进 MCP server 挂起）", () => {
    const r = runCli(["frobnicate"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown subcommand");
    expect(r.stderr).toContain("Usage");
    // stdout 保持 0 字节（没有半截 MCP server 输出）
    expect(r.stdout).toBe("");
  });

  it("未知 flag → 同样拒（exit 1，不落入 MCP server 模式）", () => {
    const r = runCli(["--frobnicate"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown subcommand");
  });
});
