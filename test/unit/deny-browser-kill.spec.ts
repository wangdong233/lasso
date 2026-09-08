/**
 * deny-browser-kill.spec.ts —— BUG-04 附录E 交付样例向量测试（E4 验收门：
 * 样例测试不绿不算交付）。
 *
 * 载体（09-08 回修教训「交付物必须自带测试载体」）：样例以可执行文件落仓
 * scripts/hooks/deny-browser-kill.mjs，本 spec 是其测试面——附录E 初版只在
 * 文档内嵌无测试样例，两缺陷（options 层漏读 / JSON 序列化不命中正则）正是
 * 从这个缺口逃逸的（cc-control 深检定罪，台账 §38）。
 *
 * 覆盖：
 *  - T1-T7：附录E §3c 向量表（mock ps 经 deps.psCommand 注入，不动真实系统）
 *  - B1-B5：回写时加严的补充边界
 *  - 文档同步锚：doc/bugs/04-附录E 内嵌样例块 ↔ scripts/hooks 权威副本逐字节一致
 *    （文档快照漂移即红——防「仓内修了、文档样例还是坏的」再犯）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../../scripts/hooks/deny-browser-kill.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const CHROME_CMD = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VITEST_CMD = "/usr/local/bin/vitest run";

/** mock ps 工厂：pid → command 映射；failPids → {ok:false}（工具级失败）；deadPids → {ok:false,dead:true} */
const mockPs = (map: Record<number, string>, { failPids = [], deadPids = [] } = {}) =>
  (pid: number): { ok: boolean; dead?: boolean; command?: string } => {
    if (failPids.includes(pid)) return { ok: false };
    if (deadPids.includes(pid)) return { ok: false, dead: true };
    if (pid in map) return { ok: true, command: map[pid] };
    return { ok: true, command: "" }; // 未配置：空 command（不匹配浏览器）——ps 层正常
  };

// ============================================================
// 附录E §3c 向量表（T1-T7）
// ============================================================
describe("deny-browser-kill · 附录E 向量表（E4 门）", () => {
  it("T1 事故原形：kill <chrome-pid> → deny", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "kill 11633" } },
      { psCommand: mockPs({ 11633: CHROME_CMD }) },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/11633 resolves to a browser/);
  });

  it("T2 同形无害：kill <vitest-pid> → allow", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "kill 12345" } },
      { psCommand: mockPs({ 12345: VITEST_CMD }) },
    );
    expect(out.decision).toBe("allow");
  });

  it("T3 名字型：pkill -f puppeteer_dev_chrome_profile → deny（无 ps）", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "pkill -f puppeteer_dev_chrome_profile" } },
      { psCommand: () => ({ ok: true, command: "" }) },
    );
    expect(out.decision).toBe("deny");
  });

  it("T4 名字型：killall Google Chrome → deny", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: 'killall "Google Chrome"' } },
      { psCommand: () => ({ ok: true, command: "" }) },
    );
    expect(out.decision).toBe("deny");
  });

  it("T5 desktop 向量：hotkey meta+q（真实形状 tool_input.options.actions[]）→ deny", () => {
    // 🔴附录E 初版缺陷①②的回归锚：真实入参形状在 options.actions 下、keys 数组
    // 扁平化 "meta+q" 才命中——初版读 tool_input.actions + JSON.stringify 双漏。
    const out = runHook(
      {
        tool_name: "mcp__lasso__desktop",
        tool_input: { action: "act", options: { actions: [{ kind: "hotkey", keys: ["meta", "q"] }] } },
      },
      { psCommand: () => ({ ok: true, command: "" }) },
    );
    expect(out.decision).toBe("deny");
  });

  it("T6 失效安全：ps 工具级失败 → deny", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "kill 99999" } },
      { psCommand: mockPs({}, { failPids: [99999] }) },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/fail-safe/);
  });

  it("T7 已死进程：ps 空+ESRCH → allow", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "kill 99998" } },
      { psCommand: mockPs({}, { deadPids: [99998] }) },
    );
    expect(out.decision).toBe("allow");
  });
});

// ============================================================
// 补充边界（B1-B5，交付包外回写时加严）
// ============================================================
describe("deny-browser-kill · 补充边界", () => {
  it("B1 信号形态：kill -9 <chrome-pid> → deny", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "kill -9 542" } },
      { psCommand: mockPs({ 542: CHROME_CMD }) },
    );
    expect(out.decision).toBe("deny");
  });

  it("B2 多 pid 混合：chrome+vitest 同命令 → deny（任一命中即拦）", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "kill 100 200" } },
      { psCommand: mockPs({ 100: VITEST_CMD, 200: "/Applications/Chromium.app/Contents/MacOS/Chromium" }) },
    );
    expect(out.decision).toBe("deny");
  });

  it("B3 lasso profile 标记：chrome-profile-default 进程 → deny", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "kill 777" } },
      {
        psCommand: mockPs({
          777: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/.cache/lasso/chrome-profile-default",
        }),
      },
    );
    expect(out.decision).toBe("deny");
  });

  it("B4 非 kill 命令：普通 Bash → allow", () => {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "npm test && echo done" } },
      { psCommand: () => ({ ok: true, command: "" }) },
    );
    expect(out.decision).toBe("allow");
  });

  it("B5 desktop 非 Cmd+Q hotkey → allow（E3 边界）", () => {
    const out = runHook(
      {
        tool_name: "mcp__lasso__desktop",
        tool_input: { action: "act", options: { actions: [{ kind: "hotkey", keys: ["meta", "c"] }] } },
      },
      { psCommand: () => ({ ok: true, command: "" }) },
    );
    expect(out.decision).toBe("allow");
  });

  it("B6 press 单键形态：tool_input.options.key 直达（初版漏读的第三种形状）→ deny", () => {
    // desktop press 形态真实形状：{action:"act", options:{actions:[{kind:"press", key:"cmd+q"}]}}
    // 与顶层 {options:{key}} 兜底两层都须覆盖
    const pressForm = runHook(
      {
        tool_name: "mcp__lasso__desktop",
        tool_input: { action: "act", options: { actions: [{ kind: "press", key: "cmd+q" }] } },
      },
      { psCommand: () => ({ ok: true, command: "" }) },
    );
    expect(pressForm.decision).toBe("deny");

    const topKeyForm = runHook(
      { tool_name: "mcp__lasso__desktop", tool_input: { action: "press", options: { key: "cmd+q" } } },
      { psCommand: () => ({ ok: true, command: "" }) },
    );
    expect(topKeyForm.decision).toBe("deny");
  });
});

// ============================================================
// 文档同步锚（防「仓内修了、文档样例还是坏的」再犯）
// ============================================================
describe("deny-browser-kill · 文档同步锚", () => {
  it("附录E §3a 内嵌样例块 == scripts/hooks/deny-browser-kill.mjs（逐字节）", () => {
    const docPath = path.join(ROOT, "doc/bugs/04-附录E-cc-control答复与hook交付包.md");
    const doc = readFileSync(docPath, "utf8");
    // §3a 的 ```js 围栏块（文档中唯一 js 围栏——提取第一个）
    const m = doc.match(/```js\r?\n([\s\S]*?)```/);
    expect(m, "附录E 文档中未找到 ```js 围栏样例块").toBeDefined();
    // 围栏捕获不含收尾换行、文件以 \n 收尾——两侧各剥一个尾换行后须逐字节一致
    const stripTnl = (s: string) => s.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const embedded = stripTnl(m![1]);
    const file = stripTnl(readFileSync(path.join(ROOT, "scripts/hooks/deny-browser-kill.mjs"), "utf8"));
    expect(embedded).toBe(file);
  });
});
