/**
 * chrome-hideshow-cli（P4，v1.17.3——得到实战催生的新用法）
 *
 * 用法：`lasso chrome-hide [--port N|--all]` / `lasso chrome-show [...]`
 *
 * 场景：「需要登录时弹 visible 窗口 → 用户登录 → chrome-hide 转后台静默执行」。
 * 登录态留在 profile（持久），窗口隐藏后 CDP 照常工作——静默性与登录态兼得。
 *
 * 红线（与 chrome-stop 同源）：
 *  - 只操作台账在案（~/.cache/lasso/launched-chromes.json）且 cmdline 验证
 *    --user-data-dir 归属的 pid——绝不碰用户日常 Chrome
 *  - visible=false 仅隐藏窗口（进程/tab/登录态原样），chrome-show 可恢复
 *  - osascript 失败（含 TCC 缺失）降级 warn 不 throw（与 chrome-hide 保险丝同语义）
 */
import { hideChromeByPid, showChromeByPid } from "./chrome-hide.js";
import { readLedgerSync } from "./chrome-ledger.js";
import { verifyOwnership } from "./chrome-stop.js";
import { spawnSync } from "node:child_process";
import process from "node:process";

interface HideShowResult {
  ok: boolean;
  results: Array<{ port: number; pid: number; ok: boolean; reason?: string }>;
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

  const ledger = readLedgerSync();
  const targets = port !== undefined ? ledger.filter((r) => r.port === port) : ledger;

  const results: HideShowResult["results"] = [];
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
