// V5 静默 tab 真机验证：hidden Chrome(9225) 上 background:true 建塔 + navigate + click + fill
// 每步前后采 frontmost / 窗口数，全程零焦点夺取判定。
import { execSync } from "node:child_process";

const PORT = 9225;
const PID = process.argv[2];
const D = "/Users/wangdong/Documents/Project/cc-control-all/lasso/doc/17-执行记录/v1x-data";
const frontmost = () =>
  execSync(
    `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
  ).toString().trim();
const winCnt = () =>
  Number(
    execSync(
      `osascript -e 'tell application "System Events" to count windows of (first application process whose unix id is ${PID})'`,
    ).toString().trim(),
  );

const log = [];
const step = async (name, fn) => {
  const fm0 = frontmost();
  const w0 = winCnt();
  const t0 = Date.now();
  const r = await fn();
  await new Promise((r2) => setTimeout(r2, 400));
  const fm1 = frontmost();
  const w1 = winCnt();
  log.push({ step: name, frontBefore: fm0, frontAfter: fm1, focusStolen: fm0 !== fm1, winBefore: w0, winAfter: w1, ms: Date.now() - t0, result: r });
  console.error(`[${name}] front ${fm0}->${fm1} win ${w0}->${w1} (${Date.now() - t0}ms)`);
};

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let targetId;
await step("createBackgroundTarget(example.com)", async () => {
  const r = await send("Target.createTarget", { url: "https://example.com", background: true });
  targetId = r.targetId;
  return targetId;
});
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await step("Page.navigate(example.org)", () =>
  send("Page.navigate", { url: "https://example.org" }, sessionId));
await step("Runtime.evaluate(click a[href])", async () => {
  const r = await send("Runtime.evaluate", { expression: "document.querySelector('a').click(); 'clicked'", returnByValue: true }, sessionId);
  return r?.result?.value;
}, ).catch(() => {});
await step("Runtime.evaluate(fill-like: input value set)", async () => {
  const r = await send("Runtime.evaluate", {
    expression: "var i=document.createElement('input');i.id='lasso-v5';document.body.appendChild(i);i.value='silent-fill';i.value",
    returnByValue: true,
  }, sessionId);
  return r?.result?.value;
});
await step("Runtime.evaluate(title read)", async () => {
  const r = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
  return r?.result?.value;
});
await step("Target.closeTarget", () => send("Target.closeTarget", { targetId }));
ws.close();
const summary = {
  baseFront: "Code",
  steps: log,
  allStepsFocusStolen: log.every((l) => !l.focusStolen),
};
execSync(`cat > ${D}/v5-silent-tab.json <<'EOF'\n${JSON.stringify(summary, null, 2)}\nEOF`);
console.log(JSON.stringify(summary, null, 2));
