/**
 * render-guardian-process.spec.ts（v1.19 渲染档设计决议 §8.1b —— r2 否定反查的唯一真闸门）
 *
 * 存在理由：DI 函数级单测测不出「进程真退」——reaper timer 全 unref（为 server
 * 进程内形态设计），独立执守进程若无 **ref'd keep-alive** 持活，runRenderGuardianCli
 * 返回后事件循环即空 → 毫秒级退出 = 出生死（desired-hide-enforcer.spec 即「全 DI
 * 注入零真 spawn」形态，进程语义在其边界外——本测试先红钉死该形态）。
 *
 * 端到端：spawn dist/index.js render-guardian（env 隔离 pidfile/台账 + 压缩 interval）
 *  → 断言 >1s 仍在世（出生死实现会在入口返回后毫秒级退出）
 *  → 清空台账 → 断言 2 tick 内自退 exit 0（账空自退与 keep-alive 清除联动）。
 * dist/ 不存在时 skip（stdin-eof-shutdown.spec 同范式）。
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

function describeOrSkip(name: string, fn: () => void) {
  if (!existsSync(DIST_ENTRY)) {
    describe.skip(name, fn);
    return;
  }
  describe(name, fn);
}

describeOrSkip("render-guardian —— 进程级持活与账空自退（r2 真闸门）", () => {
  it(
    "spawn 后 >1s 仍在世（无 ref'd keep-alive 的实现出生即死）→ 清台账 2 tick 内自退 exit 0",
    async () => {
      const tmpDir = path.join(
        await import("node:fs/promises").then((f) => f.mkdtemp(path.join(os.tmpdir(), "lasso-rg-proc-"))),
      );
      const ledgerPath = path.join(tmpDir, "launched-chromes.json");
      const pidPath = path.join(tmpDir, "render-guardian.json");
      // 种子：一条 render 记录（idle 1h —— 守住「不收割」，只验证进程语义）
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        ledgerPath,
        JSON.stringify([
          {
            port: 9224,
            pid: 999999,
            profileDir: path.join(tmpDir, "render-chrome-profile-seed"),
            launchedAt: Date.now(),
            status: "ready",
            launchMode: "render",
            idleMs: 3_600_000,
          },
        ]),
        "utf8",
      );

      const child = spawn(process.execPath, [DIST_ENTRY, "render-guardian"], {
        env: {
          ...process.env,
          LASSO_LAUNCHED_CHROMES_PATH: ledgerPath,
          LASSO_RENDER_GUARDIAN_PID_PATH: pidPath,
          LASSO_CHROME_TOUCH_DIR: tmpDir,
          LASSO_RENDER_IDLE_MS: "3600000",
          LASSO_RENDER_REAPER_INTERVAL_MS: "200", // 压缩 interval（测试/benchmark 旋钮）
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      // 1. 等 pidfile（执守自写 = 入口自检已过、装配完成）
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`pidfile 超时；stderr=${stderr.slice(-400)}`)),
          8_000,
        );
        const poll = setInterval(() => {
          if (existsSync(pidPath)) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          }
        }, 20);
        child.on("exit", (c) => {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(`执守提前退出 code=${c}；stderr=${stderr.slice(-400)}`));
        });
      });

      // 2. 🔴 出生死闸门：>1s 仍在世（无 ref'd keep-alive 的实现毫秒级退出）
      await new Promise((r) => setTimeout(r, 1_100));
      expect(child.exitCode).toBeNull();
      expect(child.killed).toBe(false);
      // 上线日志（stderr 单行 JSON）
      expect(stderr).toContain("render_guardian_up");

      // 3. 清空台账 → 账空 2 tick（200ms × 2 + 余量）内自退 exit 0
      writeFileSync(ledgerPath, "[]", "utf8");
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`清账后未自退；stderr=${stderr.slice(-400)}`));
        }, 5_000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code).toBe(0);
      // 自退日志（chrome_idle_reaper_idle_exit）
      expect(stderr).toContain("chrome_idle_reaper_idle_exit");
      // pidfile 里的 pid 是执守自己的（自写权威）
      const pidfile = JSON.parse(readFileSync(pidPath, "utf8")) as { pid: number };
      expect(pidfile.pid).toBe(child.pid);
    },
    20_000,
  );
});
