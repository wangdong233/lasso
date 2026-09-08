# BUG-04 附录 E：给 cc-control 的答复要点 + PreToolUse hook 交付包（样例落盘）

> 定位：BUG-04 决议 E（doc/bugs/04 §9，r1 修订 E1-E4 需求规格）的**交付样例**——E4 规定交付物
> （脚本实体 + 测试载体 + settings 接线样例）落 cc-control 仓库（建议 `scripts/hooks/deny-browser-kill.mjs`
> + `test/`）；本文件是 lasso 侧的规格指针 + 可整包复制的样例，供 cc-control 回写。
> 日期：2026-09-08；来源：09-08 误杀事故（cc-control/doc/lasso-报告-2026-09-08-事故与复验.md 第一部分）。

---

## 1. 答复要点（对报告三问 + 新问题清单的处置回告）

1. **「lasso 能否拦截 agent 的 Bash kill」——诚实边界**：lasso 单侧无法硬拦（shell 不在 MCP 管辖内）。
   v1.21.0 的文案防线在事故中被证明「读到但降级为背景信息」——文案是最后防线不是强制层。
   真正的强制层只有 CC 配置层的 PreToolUse hook（本附录交付物）。
2. **lasso 侧纵深已落地（v1.21.x，BUG-04 批）**：
   - **把「归属鉴定」从 agent 手里收走**（事故四根因之首）：新命令 `lasso-mcp chrome-status [--port N] [--json]`
     与 admin 只读 action `chrome_status`——TCP/CDP/lsof 真实监听 pid/ps cmdline+etime/台账/归属验证一次查清，
     10 枚举分类 + `user_paste_pack` 上报包。**agent 侧永不输出 kill 命令**（INV-88 tripwire：全分类
     allowed_commands 无 kill 形态；唯一的清账指引是 `chrome-stop --zombie-gate --port N` 门槛变体，
     且仅「台账僵尸/台账陈留」两分支）。空输出/探针失败一律如实报 probe_failed 只上报——
     「空输出≠空属性」已结构化排除（R1）。
   - **P1 页引用僵死已根治**：上游 chrome-devtools-mcp@1.7.0 选中页死锁（结构性缺陷，tarball 逐行定罪）
     ——lasso 通道内自愈（new_page 零抢焦逃逸口 + 上游子进程 respawn），主动面（reconcile）+ 被动面
     （action catch + 单次重试）双接入，主通道不再需要 MCP 重启。
   - P3 三项已修：evaluate IIFE 第三形态 / 调用方坏 JS 不再拉响 fallback（直达错误）/ doctor detail
     如实四形态（不再笼统 404）。
3. **对消费方 agent 的两条工作约定（建议进 cc-control 契约）**：
   - 遇 `port_in_use*` / doctor `cdp_9222_logged_in` fail：**先跑 `lasso-mcp chrome-status --port N`**，
     按 agent_directive 走（只上报或门槛清账）；禁止自行 lsof/curl/osascript/ps 推断归属后 kill。
   - 浏览器一切生命周期操作只经 lasso（launch-chrome / chrome-stop / chrome-hide / chrome-show）。
4. **红线上下文**：lasso 对非账本资产维持**零 kill 逃生口**（设计不变）；`chrome-stop --zombie-gate`
   是收紧（kill 时刻重估用户认领门 + 档位门）而非放松；裸 `chrome-stop` 仍是用户本人出口。

---

## 2. E1-E4 需求规格回指

见 doc/bugs/04-2026-09-08-选中页死锁与归属鉴定chrome-status.md §9（r1 修订版）。要点：

- **E1 覆盖面**：matcher 至少 `"Bash|mcp__lasso__desktop"`（desktop 的 act hotkey/press 可发 Cmd+Q——
  不经 Bash 的真实优雅退出向量；appleScript 档经复核为 rust 静态白名单，今日不可杀，
  白名单本身作 tripwire 锚：rust-helper/src/applescript_whitelist.rs 新增含 kill/quit 的模板须重议 E 覆盖面）。
- **E2 判定规则**：名字型（killall/pkill/osascript quit + 浏览器名/lasso profile 标记）→ deny；
  **裸 pid 型**（`kill [-SIGNAL] <pid>`——事故原形 `kill 11633` 无进程名，静态 grep 恰好漏掉真事故命令）
  必须 hook 内 `ps -p <pid> -o command=` **动态解析**：解析结果匹配浏览器/lasso 模式 → deny；
  ps 查无此进程（已死，kill 无害）→ allow；**解析工具自身出错 → deny（失效安全）**。
- **E3 诚实边界**：只拦 CC 中介的工具调用；用户自己终端的 kill 不受影响；desktop 的 AX 点击/键入
  无法与合法自动化静态区分——Cmd+Q 规则只拦 hotkey/press 显式形态。
- **E4 交付要求**：脚本 + 测试载体落 cc-control 仓库 + user 级 `~/.claude/settings.json` 接线样例
  （跨全部项目会话——事故 agent 恰是另一项目会话）；**验收门：样例测试不绿不算交付**。

---

## 3. 交付样例（整包复制到 cc-control）

### 3a. 脚本：`scripts/hooks/deny-browser-kill.mjs`

```js
#!/usr/bin/env node
/**
 * deny-browser-kill.mjs —— BUG-04 决议 E（E1-E4）交付样例（放 cc-control 仓库）。
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
 *  - 其余 → allow（exit 0 无 JSON）
 *
 * deny 回馈：exit 0 + {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 * "permissionDecisionReason":"..."}}——reason 指引 agent 改走 chrome-status 上报路径。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BROWSER_MARKERS =
  /Chrome|Chromium|puppeteer_dev_chrome_profile|chrome-profile-default|render-chrome-profile-/i;
const NAME_KILL_RE = /\b(killall|pkill)\b|\bosascript\b[\s\S]*\bquit\b/i;
const CMD_Q_RE = /(^|[^a-z])(cmd\+q|⌘q|command\+q|meta\+q|key_q|"q"\s*,\s*"meta"|modifier[^"]*"meta"[^"]*"q")/i;

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          reason +
          " — never_kill_user_asset: browsers are ONLY managed via lasso (launch-chrome / chrome-stop). " +
          "For a blocked port run `lasso-mcp chrome-status --port N` and report its user_paste_pack to the user.",
      },
    }),
  );
  // exit 0：deny 决策经 JSON 回馈，非退出码
};

function psCommand(pid) {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (r.error || r.status !== 0) return { ok: false }; // 工具级失败：失效安全
    const out = (r.stdout ?? "").replace(/[\r\n]+$/, "");
    if (!out) return { ok: false, dead: true }; // 空输出≠进程属性——deny（见下）
    return { ok: true, command: out };
  } catch {
    return { ok: false };
  }
}

/** 解析 PreToolUse 入参（stdin JSON）——容错：解析失败按 allow 之外最保守处理（deny）。 */
function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

const input = readInput();
const tool = input?.tool_name ?? "";
const command = String(input?.tool_input?.command ?? "");
const action = input?.tool_input ?? {};

// ---- E1 面 2：desktop act（hotkey/press 显式 Cmd+Q 形态）----
if (/^mcp__lasso__desktop$/.test(tool)) {
  const pressed = [action.key, action.keys?.join("+"), JSON.stringify(action.actions ?? [])].join(" ");
  if (CMD_Q_RE.test(pressed)) {
    deny("Cmd+Q against the foreground app can gracefully quit the USER's browser (E1 desktop vector)");
    process.exit(0);
  }
  process.exit(0); // 其余 desktop 形态：E3 边界（AX 点击/键入不静态区分）
}

// ---- E1 面 1：Bash kill 全形态 ----
if (tool !== "Bash") process.exit(0);

// 名字型
if (NAME_KILL_RE.test(command) && BROWSER_MARKERS.test(command)) {
  deny("named kill matches a browser / lasso profile marker");
  process.exit(0);
}

// 裸 pid 型：kill [-SIGNAL] <pid> [<pid>...]
const killMatch = command.match(/\bkill\b(?:\s+-[A-Za-z0-9]+)*(?:\s+-\d+)?((?:\s+\d+)+)/);
if (killMatch) {
  const pids = killMatch[1].trim().split(/\s+/).map(Number);
  for (const pid of pids) {
    const ps = psCommand(pid);
    if (!ps.ok) {
      // 已死进程（ESRCH）= kill 无害 → 跳过；解析失败 = 失效安全 deny
      if (!ps.dead) {
        deny(`cannot verify pid ${pid} (ps failed) — fail-safe deny`);
        process.exit(0);
      }
      continue;
    }
    if (BROWSER_MARKERS.test(ps.command)) {
      deny(`pid ${pid} resolves to a browser process (${ps.command.slice(0, 80)})`);
      process.exit(0);
    }
  }
}
process.exit(0); // allow：无输出即放行
```

### 3b. 接线样例：`~/.claude/settings.json`（user 级——跨全部项目会话）

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|mcp__lasso__desktop",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/cc-control/scripts/hooks/deny-browser-kill.mjs"
          }
        ]
      }
    ]
  }
}
```

### 3c. 测试载体（最小六向量，进 cc-control 测试）

| # | 输入（tool_input 形状） | mock ps | 期望 |
|---|---|---|---|
| T1 | Bash `kill 11633` | pid 11633 → `/Applications/Google Chrome.app/.../Google Chrome` | **deny**（事故原形） |
| T2 | Bash `kill 12345` | pid 12345 → `/usr/local/bin/vitest run` | allow（同形无害进程） |
| T3 | Bash `pkill -f puppeteer_dev_chrome_profile` | （名字型，无 ps） | **deny** |
| T4 | Bash `killall "Google Chrome"` | （名字型） | **deny** |
| T5 | desktop act `{action:"act", options:{actions:[{kind:"hotkey", keys:["meta","q"]}]}}` | — | **deny** |
| T6 | Bash `kill 99999` | ps 失败（r.error） | **deny**（失效安全） |
| T7 | Bash `kill 99998` | ps 空 + ESRCH（已死） | allow |

> 实现提示：把 `spawnSync` 经参数注入（`runHook(input, deps)`）即可单测 mock，脚本底部
> `if (process.env.NODE_ENV !== "test") main()`。**验收门：六向量不绿不算交付（E4）。**

---

## 4. lasso 侧配套锚（回写时可引用）

- INV-88（chrome-status 输出契约：无 kill tripwire / 门槛变体纪律 / R1-R3）与 INV-89（wedge 自愈锚）——
  `src/invariants/check-invariants.mjs`。
- `chrome-status --zombie-gate` 行为面：`test/unit/bug04-chrome-status.spec.ts` §7。
- 事故与决议全案：doc/bugs/03（BUG-03）+ doc/bugs/04（BUG-04）+ cc-control/doc/lasso-报告-2026-09-08-事故与复验.md。
