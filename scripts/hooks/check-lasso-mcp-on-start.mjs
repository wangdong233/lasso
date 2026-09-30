#!/usr/bin/env node
/**
 * check-lasso-mcp-on-start.mjs —— SessionStart 可选件（bugs/13 §11，2026-09-30）。
 *
 * 形态（本机 09-30 实锤）：SSD panic 引发系统重启（09-29 三次）→ 旧 CC 会话的
 * lasso stdio MCP 连接随进程死亡 → **会话 resume 不自动重连** → 工具面 lasso
 * 全消失（server 本身健康——新会话 spawn 即用，本检测不误报这种）。
 *
 * 本 hook 在 SessionStart（含 resume）跑：快检注册的 lasso server 入口能否
 * 3s 内启动（node <entry> --version）。**检测的是「入口可启动性」**——连接
 * 是否断 CC 自己知道（断了它就不调本 hook 的 MCP），我们补的是另一半：
 * 入口坏了（dist 损伤/路径漂移/Node 缺失）时当场提醒，别等用户调工具才发现。
 *
 * 输出：可启动 → 静默 exit 0；不可启动 → additionalContext 提醒（含修复出口）。
 * 装法（KEY-GUIDE §可选件 / TROUBLESHOOTING §2.25）：
 *   ~/.claude/settings.json → hooks.SessionStart 追加
 *   { "hooks": [{ "type": "command",
 *     "command": "node <lasso仓>/scripts/hooks/check-lasso-mcp-on-start.mjs",
 *     "timeout": 10 }] }
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

function main() {
  // 1) 从 ~/.claude.json 读 lasso 注册入口（全局域优先，项目域兜底）
  let entry = null;
  try {
    const cfg = JSON.parse(readFileSync(path.join(homedir(), ".claude.json"), "utf8"));
    const pick = (m) => m?.lasso?.type === "stdio" ? m.lasso : null;
    const global = pick(cfg.mcpServers);
    const fromProjects = Object.values(cfg.projects ?? {})
      .map((p) => pick(p.mcpServers)).find(Boolean);
    const reg = global ?? fromProjects;
    if (reg?.command === "node" && Array.isArray(reg.args) && reg.args[0]) entry = reg.args[0];
  } catch { /* 读不到注册 → 静默（本机未装 lasso MCP 的正常态） */ }
  if (!entry) return; // 未注册：不是本 hook 的受众

  // 2) 快检：--version 3s 内可答（dist 损伤/路径漂移/Node 崩都会当场现形）
  const r = spawnSync("node", [entry, "--version"], { timeout: 3_000, encoding: "utf8" });
  if (r.status === 0) return; // 入口健康——连接层归 CC 管，不越权提醒

  // 3) 入口不可启动 → 提醒（含三修复出口）
  const msg =
    "[LASSO-CHECK] lasso MCP entry failed to start (" + entry + " → exit " + r.status +
    "). lasso tools will be missing/broken this session. Fixes: (1) if tools vanished after a " +
    "system reboot, run /mcp reconnect first (server is likely healthy — the stale stdio " +
    "connection died with the reboot, docs: TROUBLESHOOTING §2.25); (2) if dist is damaged, " +
    "cd <lasso repo> && npm run build; (3) verify with `node " + entry + " doctor`.";
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: msg,
        },
      }),
    );
  } catch { /* 输出失败静默——hook 永不阻断会话启动 */ }
}

main();
