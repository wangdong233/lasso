/**
 * round1-review03 §2.3 真机冒烟（一次性验证脚本，不进 src/）
 * 用 v1.11 HeadlessChannel 的精确 spec 形状 spawn chrome-devtools-mcp@1.7.0，
 * 验证：①flags 被接受 ②launch 级 UA 生效（navigator.userAgent 非 HeadlessChrome）
 * ③viewport 生效 ④wait_for text 数组契约 ⑤list_network_requests/list_console_messages
 * 文本行格式与 lasso src/browse/cdp-actions.ts 解析器一致（L2 证据）。
 */
import { McpClient } from "../dist/subprocess/McpClient.js";
import { LOCKED_CDP_MCP_VERSION } from "../dist/subprocess/SubprocessManager.js";
import { STEALTH_PROFILES } from "../dist/browse/stealth-profiles.js";

const profile = STEALTH_PROFILES.windows_chrome_120;
const args = [
  "-y",
  `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
  "--headless",
  "--isolated",
  "--no-usage-statistics",
  "--chromeArg=--disable-blink-features=AutomationControlled",
  `--chromeArg=--user-agent=${profile.userAgent}`,
  `--viewport=${profile.viewport.width}x${profile.viewport.height}`,
];

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const c = await McpClient.connectStdio(
  { name: "review03-smoke", version: "1.0.0" },
  { command: "npx", args, env: process.env },
);

// ① 工具清单（工具名契约）
const tools = await c.listTools();
const names = tools.map((t) => t.name);
check("listTools 含 list_network_requests", names.includes("list_network_requests"));
check("listTools 含 list_console_messages", names.includes("list_console_messages"));
check("listTools 含 get_network_request", names.includes("get_network_request"));

// ② 导航到真实页面（example.com 轻量稳定）
const nav = await c.callTool("navigate_page", { type: "url", url: "https://example.com/" });
check("navigate_page example.com", !nav.isError);

// ③ UA：launch flag 生效性（navigator.userAgent 应为 profile UA，非 HeadlessChrome）
const uaRes = await c.callTool("evaluate_script", {
  function: "() => ({ ua: navigator.userAgent, w: innerWidth, h: innerHeight, wd: navigator.webdriver })",
});
const uaText = (uaRes.content ?? []).map((x) => x.text ?? "").join("\n");
let uaInfo;
try { uaInfo = JSON.parse(uaText.replace(/^.*?({.*}).*$/s, "$1")); } catch { uaInfo = {}; }
check("navigator.userAgent 非 HeadlessChrome", !/HeadlessChrome/i.test(uaInfo.ua ?? ""), String(uaInfo.ua ?? "").slice(0, 80));
check("navigator.userAgent === profile UA", uaInfo.ua === profile.userAgent);
check("viewport 生效（1920x1080）", uaInfo.w === 1920 && uaInfo.h === 1080, `${uaInfo.w}x${uaInfo.h}`);

// ④ wait_for text 数组契约（1.7.0 schema：array(string).min(1)）
const wf = await c.callTool("wait_for", { text: ["Example Domain"], timeout: 5000 });
check("wait_for {text:[array]} 被接受", !wf.isError);
const wfStr = await c.callTool("wait_for", { text: "Example Domain", timeout: 2000 }).catch((e) => ({ isError: true, err: String(e) }));
check("wait_for {text:string} 被拒绝（印证契约翻转）", wfStr.isError === true);

// ⑤ list_network_requests 文本行格式 → lasso 解析器
const netRes = await c.callTool("list_network_requests", {});
const netText = (netRes.content ?? []).map((x) => x.text ?? "").join("\n");
const lines = netText.split("\n").filter((l) => /^reqid=/.test(l));
check("list_network_requests 输出 reqid= 行", lines.length > 0, lines[0] ?? "(none)");

// 用 lasso 真解析器（dist 构建）解析真实上游输出
const { parseNetworkRequestLines } = await import("../dist/browse/cdp-actions.js");
const parsed = parseNetworkRequestLines(netText);
check("lasso parseNetworkRequestLines 解析真实输出 >0 条", parsed.length > 0, JSON.stringify(parsed.slice(0, 2)));
check("解析条目含 method/status（GET/200）", parsed.every((e) => e.method && e.status !== undefined), JSON.stringify(parsed[0] ?? {}));

// ⑥ list_console_messages → lasso 解析器（example.com 无 console 消息：空列表也是合法输出，验不炸）
const conRes = await c.callTool("list_console_messages", {});
const conText = (conRes.content ?? []).map((x) => x.text ?? "").join("\n");
const { parseConsoleMessageLines } = await import("../dist/browse/cdp-actions.js");
const conParsed = parseConsoleMessageLines(conText);
check("list_console_messages 调用成功 + 解析器不炸", !conRes.isError, `lines=${conText.split("\n").filter((l) => /^msgid=/.test(l)).length} parsed=${conParsed.length}`);

// ⑦ screenshot 仍可用（既有契约回归）
const shot = await c.callTool("take_screenshot", { format: "jpeg" });
check("take_screenshot 不报错", !shot.isError);

await c.close();

const fails = results.filter((r) => !r.ok);
console.log(`\n=== 冒烟结果：${results.length - fails.length}/${results.length} PASS ===`);
process.exit(fails.length ? 1 : 0);
