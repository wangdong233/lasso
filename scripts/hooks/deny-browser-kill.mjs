#!/usr/bin/env node
/**
 * deny-browser-kill.mjs —— BUG-04 决议 E（E1-E4）交付样例（lasso 仓权威副本）。
 *
 * cc-control 侧部署副本：cc-control 仓 scripts/hooks/deny-browser-kill.mjs（09-08 已
 * 接线 user 级 settings 并双向 live 验证）；本文件是 upstream 权威样例 + 测试载体宿主（E4：样例必须自带测试——「样例无测试=缺陷逃逸」
 * 是 09-08 附录E初版两缺陷的根因，见 doc/bugs/04-附录E §3c）。两副本由
 * test/unit/deny-browser-kill.spec.ts 的文档同步锚钉住（doc 内嵌块 ↔ 本文件逐字节一致）。
 *
 * CC PreToolUse hook：唯一真正的强制层——拦截 agent 经 CC 工具发出的浏览器 kill。
 * 事故原形（2026-09-08）：`kill 11633`（裸 pid、无进程名）——静态 grep 型 hook 恰好
 * 漏掉真事故命令，而 `kill <vitest-pid>` 与之同形。故 E2 强制动态 pid 解析。
 *
 * 判定（失效安全：解析不可得 → deny）：
 *  - 名字型：命令文本含 killall/pkill/osascript-quit 且匹配浏览器名 / lasso profile
 *    标记（Chrome|Chromium|puppeteer_dev_chrome_profile|chrome-profile-default|render-chrome-profile-）→ deny
 *  - 裸 pid 型（kill/kill -9/kill -HUP ... <pid>...）：逐 pid `ps -p <pid> -o command=`
 *    实时解析——匹配上述模式 → deny；ps 查无此进程 → allow（kill 无害）；
 *    ps 自身失败/输出为空 → deny（空输出≠进程属性——事故四根因之首）
 *  - desktop act（hotkey/press）对 Cmd+Q（⌘Q/cmd+q/Meta+q/key_q 等）→ deny
 *    （🔴入参真实形状是 tool_input.options.actions[]；漏读 options 层=恒放行——
 *    附录E初版缺陷①。keys 数组须扁平化 "meta+q" 再匹配，JSON 序列化形
 *    ["meta","q"] 不命中正则——缺陷②）
 *  - 其余 → allow（exit 0 无 JSON）
 *
 * deny 回馈：exit 0 + {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 * "permissionDecision":"deny","permissionDecisionReason":"..."}}——reason 指引 agent
 * 改走 chrome-status 上报路径（lasso 1.22+：agent_directive.allowed=[] must_report=true）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BROWSER_MARKERS =
  /Chrome|Chromium|puppeteer_dev_chrome_profile|chrome-profile-default|render-chrome-profile-/i;
const NAME_KILL_RE = /\b(killall|pkill)\b|\bosascript\b[\s\S]*\bquit\b/i;
const CMD_Q_RE = /(^|[^a-z])(cmd\+q|⌘q|command\+q|meta\+q|key_q|"q"\s*,\s*"meta"|modifier[^"]*"meta"[^"]*"q")/i;

const DENY_SUFFIX =
  " — never_kill_user_asset: browsers are ONLY managed via lasso (launch-chrome / chrome-stop). " +
  "For a blocked port run `lasso-mcp chrome-status --port N` and report its user_paste_pack to the user.";

/**
 * 可单测核心：runHook(input, deps) → { decision: 'deny'|'allow', reason?: string }。
 * deps.psCommand(pid) 注入替换 spawnSync（测试载体用，见 deny-browser-kill.spec.ts）。
 */
export function runHook(input, deps = { psCommand: realPsCommand }) {
  const tool = input?.tool_name ?? "";
  const command = String(input?.tool_input?.command ?? "");
  const action = input?.tool_input ?? {};

  // ---- E1 面 2：desktop act（hotkey/press 显式 Cmd+Q 形态）----
  if (/^mcp__lasso__desktop$/.test(tool)) {
    // 真实工具入参形状：tool_input.options.actions[]({kind:"hotkey",keys:[...]} / {kind:"press",key})
    // 🔴附录E初版样例此处漏读 options 层（读 tool_input.actions=恒 undefined→T5 恒放行）；
    // 且 JSON 序列化 ["meta","q"] 不命中 CMD_Q_RE 的 meta\+q 形态——须扁平化为 "meta+q" 再匹配
    const opts = action.options ?? {};
    const flat = (acts) =>
      (acts ?? []).map((a) => [a?.key, (a?.keys ?? []).join("+")].filter(Boolean).join("+")).join(" ");
    const pressed = [
      action.key, action.keys?.join("+"),
      opts.key, opts.keys?.join("+"),
      flat(opts.actions), flat(action.actions),
    ].filter(Boolean).join(" ");
    if (CMD_Q_RE.test(pressed)) {
      return { decision: "deny", reason: "Cmd+Q against the foreground app can gracefully quit the USER's browser (E1 desktop vector)" + DENY_SUFFIX };
    }
    return { decision: "allow" }; // 其余 desktop 形态：E3 边界（AX 点击/键入不静态区分）
  }

  // ---- E1 面 1：Bash kill 全形态 ----
  if (tool !== "Bash") return { decision: "allow" };

  // 名字型
  if (NAME_KILL_RE.test(command) && BROWSER_MARKERS.test(command)) {
    return { decision: "deny", reason: "named kill matches a browser / lasso profile marker" + DENY_SUFFIX };
  }

  // 裸 pid 型：kill [-SIGNAL] <pid> [<pid>...]
  const killMatch = command.match(/\bkill\b(?:\s+-[A-Za-z0-9]+)*(?:\s+-\d+)?((?:\s+\d+)+)/);
  if (killMatch) {
    const pids = killMatch[1].trim().split(/\s+/).map(Number);
    for (const pid of pids) {
      const ps = deps.psCommand(pid);
      if (!ps.ok) {
        // 已死进程（ESRCH）= kill 无害 → 跳过；解析失败 = 失效安全 deny
        if (!ps.dead) {
          return { decision: "deny", reason: `cannot verify pid ${pid} (ps failed) — fail-safe deny` + DENY_SUFFIX };
        }
        continue;
      }
      if (BROWSER_MARKERS.test(ps.command)) {
        return { decision: "deny", reason: `pid ${pid} resolves to a browser process (${ps.command.slice(0, 80)})` + DENY_SUFFIX };
      }
    }
  }
  return { decision: "allow" }; // allow：无输出即放行
}

function realPsCommand(pid) {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1000 });
    if (r.error || r.status !== 0) return { ok: false }; // 工具级失败：失效安全
    const out = (r.stdout ?? "").replace(/[\r\n]+$/, "");
    if (!out) return { ok: false, dead: true }; // 空输出≠进程属性——deny（见 runHook）
    return { ok: true, command: out };
  } catch {
    return { ok: false };
  }
}

/** main：读 stdin JSON → runHook → deny 时输出决策 JSON（exit 0）；allow 静默。 */
function main() {
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // 解析失败：非本 hook 关心的形态，静默放行（其余防线仍在）
    process.exit(0);
  }
  const out = runHook(input);
  if (out.decision === "deny") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: out.reason,
        },
      }),
    );
  }
  // exit 0：deny 决策经 JSON 回馈，非退出码
  process.exit(0);
}

/* 直跑守卫：仅作为脚本执行时跑 main（node --test / vitest 导入时不跑——否则
 * readFileSync(0) 挂等 stdin。🔴附录E初版建议的 NODE_ENV!=="test" 守卫在
 * node --test 下不成立（不设该变量）——缺陷③，改标准 import.meta.url 判定）。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
