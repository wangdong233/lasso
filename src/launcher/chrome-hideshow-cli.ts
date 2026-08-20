/**
 * chrome-hideshow-cli（P4，v1.17.3——得到实战催生的新用法；P27 v1.18.3 扩 --pid）
 *
 * 用法：`lasso chrome-hide [--port N|--pid N|--all]` / `lasso chrome-show [...]`
 *
 * 场景：「需要登录时弹 visible 窗口 → 用户登录 → chrome-hide 转后台静默执行」。
 * 登录态留在 profile（持久），窗口隐藏后 CDP 照常工作——静默性与登录态兼得。
 *
 * 红线（与 chrome-stop 同源）：
 *  - 只操作台账在案（~/.cache/lasso/launched-chromes.json）且 cmdline 验证
 *    --user-data-dir 归属的 pid——绝不碰用户日常 Chrome
 *  - visible=false 仅隐藏窗口（进程/tab/登录态原样），chrome-show 可恢复
 *  - osascript 失败（含 TCC 缺失）降级 warn 不 throw（与 chrome-hide 保险丝同语义）
 *
 * P27（v1.18.3）`--pid N` 变体：台账缺条目（如 Chrome 由旧版启动后台账被清）时
 * 的地面真源出口——**cmdline `--user-data-dir` 必须落在 ~/.cache/lasso/ 产品命名
 * space 内**（比台账更强的结构保证：cmdline 是内核地面真源，台账可陈旧）。
 * 不满足（用户日常 Chrome / pid 复用 / 无标记）→ 拒绝（pid_not_lasso_profile）。
 */
import { hideChromeByPid, showChromeByPid } from "./chrome-hide.js";
import { readLedgerSync } from "./chrome-ledger.js";
import { verifyOwnership } from "./chrome-stop.js";
import { addDesiredHidden, removeDesiredHidden } from "./desired-hide-state.js";
import { spawnSync } from "node:child_process";
import process from "node:process";
import * as path from "node:path";
import os from "node:os";

interface HideShowResult {
  ok: boolean;
  results: Array<{ port: number; pid: number; ok: boolean; reason?: string }>;
}

/** --pid 变体的归属判定结果。 */
export interface PidTargetResolution {
  ok: boolean;
  pid: number;
  port: number;
  profileDir: string;
  reason?: string;
}

/** lasso 产品 profile 命名空间根（~/.cache/lasso/）。 */
export function lassoProfileNamespace(): string {
  return path.join(os.homedir(), ".cache", "lasso");
}

/**
 * --pid 变体归属解析（纯函数，测试直测）：
 *  1. ps 读 cmdline（空 → pid_not_found）
 *  2. 提取 --user-data-dir=X（无 → pid_not_lasso_profile——用户日常 Chrome 无此参）
 *  3. X 必须在 lassoProfileNamespace() 内（resolve 后前缀比对——pid 复用/
 *     指向别处的标记一律拒绝；E8 红线的 cmdline 地面真源版）
 *  4. 顺带提取 --remote-debugging-port=N（无 → 0，诊断用不阻断）
 */
export function resolvePidTarget(
  pid: number,
  psFn: (pid: number) => string = defaultPs,
): PidTargetResolution {
  const fail = (reason: string): PidTargetResolution => ({ ok: false, pid, port: 0, profileDir: "", reason });
  if (!Number.isInteger(pid) || pid <= 0) return fail("invalid_pid");
  const cmdline = psFn(pid);
  if (!cmdline || !cmdline.trim()) return fail("pid_not_found");
  const m = cmdline.match(/--user-data-dir=(\S+)/);
  if (!m) return fail("pid_not_lasso_profile");
  const profileDir = path.resolve(m[1]);
  const ns = lassoProfileNamespace() + path.sep;
  if (!(profileDir + path.sep).startsWith(ns)) return fail("pid_not_lasso_profile");
  const pm = cmdline.match(/--remote-debugging-port=(\d+)/);
  return { ok: true, pid, port: pm ? Number(pm[1]) : 0, profileDir };
}

function defaultPs(pid: number): string {
  try {
    return spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1_000,
    }).stdout ?? "";
  } catch {
    return "";
  }
}

/**
 * CLI runner（index.ts 子命令路由调用）。
 * @param show true=chrome-show（恢复可见）；false=chrome-hide（转后台）
 */
export async function runChromeHideShowCli(show: boolean): Promise<void> {
  const argv = process.argv.slice(3);
  const portArgIdx = argv.indexOf("--port");
  const port =
    portArgIdx !== -1 && argv[portArgIdx + 1] && /^\d+$/.test(argv[portArgIdx + 1])
      ? Number(argv[portArgIdx + 1])
      : undefined;

  // P27：--pid 变体（与 --port 互斥优先；不走台账，走 cmdline 地面真源）
  const pidArgIdx = argv.indexOf("--pid");
  const pidArg =
    pidArgIdx !== -1 && argv[pidArgIdx + 1] && /^\d+$/.test(argv[pidArgIdx + 1])
      ? Number(argv[pidArgIdx + 1])
      : undefined;

  const results: HideShowResult["results"] = [];

  if (pidArg !== undefined) {
    const t = resolvePidTarget(pidArg);
    if (!t.ok) {
      results.push({ port: 0, pid: pidArg, ok: false, reason: t.reason });
    } else {
      const r = show ? showChromeByPid(t.pid) : hideChromeByPid(t.pid);
      results.push({ port: t.port, pid: t.pid, ok: r.ok, reason: r.reason });
      if (r.ok) {
        if (show) {
          await removeDesiredHidden(t.pid);
        } else {
          await addDesiredHidden({
            pid: t.pid,
            port: t.port,
            profileDir: t.profileDir,
            hiddenAt: Date.now(),
          });
        }
      }
    }
  } else {
    const ledger = readLedgerSync();
    const targets = port !== undefined ? ledger.filter((r) => r.port === port) : ledger;

    for (const rec of targets) {
      // 归属验证红线：cmdline 无 --user-data-dir 标记（pid 复用/陈旧条目）→ skip
      let cmdline = "";
      try {
        cmdline = spawnSync("ps", ["-p", String(rec.pid), "-o", "command="], {
          encoding: "utf8",
          timeout: 1_000,
        }).stdout ?? "";
      } catch {
        /* ps 失败按不匹配处理 */
      }
      if (!verifyOwnership(rec.pid, rec.profileDir, () => cmdline)) {
        results.push({ port: rec.port, pid: rec.pid, ok: false, reason: "pid_reused_skipped" });
        continue;
      }
      const r = show
        ? showChromeByPid(rec.pid)
        : hideChromeByPid(rec.pid);
      results.push({ port: rec.port, pid: rec.pid, ok: r.ok, reason: r.reason });
      // P27（v1.18.3）粘滞账：hide 成功 → desiredHidden 记账（server 看门狗每 1.5s
      // 复隐兜「任意激活源掀出」）；show 成功 → 清账（用户明示要看，看门狗不再压回）。
      if (r.ok) {
        if (show) {
          await removeDesiredHidden(rec.pid);
        } else {
          await addDesiredHidden({
            pid: rec.pid,
            port: rec.port,
            profileDir: rec.profileDir,
            hiddenAt: Date.now(),
          });
        }
      }
    }
  }

  const anyOk = results.some((r) => r.ok);
  process.stdout.write(
    JSON.stringify(
      { ok: anyOk, action: show ? "chrome_show" : "chrome_hide", results },
      null,
      2,
    ) + "\n",
  );
  process.exit(anyOk || results.length === 0 ? 0 : 1);
}
