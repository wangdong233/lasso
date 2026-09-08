# BUG-04 附录 E：给 cc-control 的答复要点 + PreToolUse hook 交付包（样例落盘）

> 定位：BUG-04 决议 E（doc/bugs/04 §9，r1 修订 E1-E4 需求规格）的**交付样例**——E4 规定交付物
> （脚本实体 + 测试载体 + settings 接线样例）落 cc-control 仓库（`scripts/hooks/deny-browser-kill.mjs`
> + 测试）；本文件是 lasso 侧的规格指针 + 样例快照。
> 日期：2026-09-08；**09-09 回修**：初版样例两缺陷（cc-control 深检定罪，见 §3d）+ E4 教训固化
> （样例必须以可执行文件 + 测试载体落仓，文档内嵌块降级为快照指针）。
> 权威副本：`scripts/hooks/deny-browser-kill.mjs`（本仓）——测试
> `test/unit/deny-browser-kill.spec.ts` 含文档同步锚（本文件 §3a 内嵌块 ↔ 权威副本逐字节一致，
> 漂移即红）。

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
     如实四形态（不再笼统 404；09-09 追加：`/json` tabs 探测面同规——见 doc/governance/12）。
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
  🔴09-09 教训固化（初版违例的根因）：**交付物必须自带测试载体**——「文档内嵌样例、无测试」
  等于交付未验证代码，缺陷必从该缺口逃逸（§3d 两缺陷即此）。lasso 侧样例现以可执行文件
  + 测试落仓，文档内嵌块仅作快照（同步锚钉住）。

---

## 3. 交付样例（权威副本在本仓 scripts/hooks/，cc-control 整包复制）

### 3a. 脚本：`scripts/hooks/deny-browser-kill.mjs`

（以下内嵌块与仓内权威副本逐字节一致——test/unit/deny-browser-kill.spec.ts 文档同步锚钉住）

```js
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

### 3c. 测试载体（权威副本在本仓 test/unit/deny-browser-kill.spec.ts，cc-control 复制为
`scripts/hooks/deny-browser-kill.test.mjs`，载体 node:test）

| # | 输入（tool_input 形状） | mock ps | 期望 |
|---|---|---|---|
| T1 | Bash `kill 11633` | pid 11633 → `/Applications/Google Chrome.app/.../Google Chrome` | **deny**（事故原形） |
| T2 | Bash `kill 12345` | pid 12345 → `/usr/local/bin/vitest run` | allow（同形无害进程） |
| T3 | Bash `pkill -f puppeteer_dev_chrome_profile` | （名字型，无 ps） | **deny** |
| T4 | Bash `killall "Google Chrome"` | （名字型） | **deny** |
| T5 | desktop act `{action:"act", options:{actions:[{kind:"hotkey", keys:["meta","q"]}]}}` | — | **deny**（🔴真实形状在 options.actions 下——初版缺陷①的回归锚） |
| T6 | Bash `kill 99999` | ps 失败（r.error） | **deny**（失效安全） |
| T7 | Bash `kill 99998` | ps 空 + ESRCH（已死） | allow |
| B1 | Bash `kill -9 542` | pid 542 → Chrome | **deny**（信号形态） |
| B2 | Bash `kill 100 200` | 100→vitest / 200→Chromium | **deny**（多 pid 任一命中） |
| B3 | Bash `kill 777` | 777 → Chrome `--user-data-dir=.../chrome-profile-default` | **deny**（lasso profile 标记） |
| B4 | Bash `npm test && echo done` | — | allow（非 kill 命令） |
| B5 | desktop hotkey `["meta","c"]` | — | allow（非 Cmd+Q，E3 边界） |
| B6 | desktop press `{kind:"press", key:"cmd+q"}` 及顶层 `{options:{key}}` | — | **deny**（press 形态两层覆盖） |
| — | 文档同步锚 | — | 附录E §3a 内嵌块 == 仓内权威副本（逐字节） |

> 实现要点（初版缺失，09-09 补齐为交付内建）：`spawnSync` 经参数注入
> （`runHook(input, deps)`）可单测 mock；脚本底部直跑守卫用标准
> `import.meta.url === pathToFileURL(process.argv[1]).href` 判定——🔴初版建议的
> `NODE_ENV !== "test"` 守卫在 node --test 下不成立（不设该变量，导入即挂等 stdin）。
> **验收门：全向量不绿不算交付（E4）。**

### 3d. 初版样例两缺陷定罪（09-08 cc-control 深检，09-09 回修）

初版交付包样例（本文档 09-08 版内嵌块）自带两缺陷，E4 自检未发现——**因样例未附测试载体**：

1. **desktop 入参漏读 options 层**：读 `tool_input.actions`，真实形状
   `tool_input.options.actions[]` → 恒 undefined → T5（Cmd+Q）恒放行——恰是要拦的向量；
2. **JSON 序列化不命中正则**：`JSON.stringify(["meta","q"])` 产出 `"meta","q"` 不命中
   CMD_Q_RE 的 `meta\+q` 形态，须把 keys 扁平化为 `"meta+q"` 再匹配。
   另：初版建议的 `NODE_ENV !== "test"` 直跑守卫在 node --test 下不成立（挂等 stdin），
   须 `import.meta.url` 直跑判定。

**教训（已固化进 E4）**：交付物必须自带测试载体——「文档内嵌样例、无测试」等于交付
未验证代码。lasso 侧处置：样例以可执行文件落仓 `scripts/hooks/deny-browser-kill.mjs` +
向量测试 `test/unit/deny-browser-kill.spec.ts`（含文档同步锚，文档快照漂移即红）。

---

## 4. lasso 侧配套锚（回写时可引用）

- INV-88（chrome-status 输出契约：无 kill tripwire / 门槛变体纪律 / R1-R3）与 INV-89（wedge 自愈锚）——
  `src/invariants/check-invariants.mjs`。
- `chrome-status --zombie-gate` 行为面：`test/unit/bug04-chrome-status.spec.ts` §7。
- 事故与决议全案：doc/bugs/03（BUG-03）+ doc/bugs/04（BUG-04）+ cc-control/doc/lasso-报告-2026-09-08-事故与复验.md。
