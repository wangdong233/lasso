/**
 * stdin-eof-shutdown.spec.ts（v1.12 round2 T2-12）
 *
 * 守护点：上游 SDK #2002（StdioServerTransport start() 只挂 data/error，不监听
 * close/end）—— CC 异常退出（崩溃/关窗）后父进程死亡、stdin EOF，但活跃
 * ChildProcess 句柄保活事件循环 → Lasso 不退出 → cdp-mcp/rust-helper 树孤儿
 * 直到 zombie reaper 1h 阈值。修复 = index.ts 停机段挂
 * process.stdin.on("end"/"close") → 幂等 shutdown("stdin_eof")。
 *
 * 端到端验证：spawn dist/index.js（MCP server 模式）→ 等 lasso_ready →
 * 关写端（stdin.end()）→ 断言 N 秒内退出 + lasso_shutdown/stdin_eof 日志。
 * dist/ 不存在时 skip（cli-conventions.spec.ts 同范式）。
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

describeOrSkip("T2-12 — stdin EOF → 优雅停机（上游 #2002 同构修复）", () => {
  it(
    "客户端关 stdin（EOF）→ server 走 stdin_eof 停机路径并在秒级退出（exit 0）",
    async () => {
      const child = spawn(process.execPath, [DIST_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      // 1. 等 lasso_ready（server 完成装配、stdin data 监听已挂 → flowing）
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`lasso_ready 超时；stderr=${stderr.slice(-500)}`)),
          10_000,
        );
        const poll = setInterval(() => {
          if (stderr.includes("lasso_ready")) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          }
        }, 50);
        child.on("exit", (c) => {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(`server 提前退出 code=${c}；stderr=${stderr.slice(-500)}`));
        });
      });

      // 2. 关写端 → 子进程 stdin 收到 EOF
      child.stdin.end();

      // 3. 断言秒级退出（T3-4 round3 注释归真：steel release / Chrome 收尾 /
      //    tab restore 三步顺序执行、各 3s 上界——本测试无 Steel 会话，steel 步
      //    no-op 瞬时；悬挂 endpoint 场景由 steel-channel.spec.ts T3-4 单测覆盖
      //    （release fetch AbortSignal 3s）+ 本文件 race 源码断言；15s 兜底防挂）
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("stdin EOF 后未退出（孤儿复现）"));
        }, 15_000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });

      expect(code).toBe(0);
      expect(stderr).toContain("lasso_shutdown");
      expect(stderr).toContain("stdin_eof");
    },
    25_000,
  );
});
