/**
 * bug11-input-guard-fixture.spec.ts（doc/bugs/11 决议 C §6-2，2026-09-17）
 *
 * 【opt-in 真 upstream + Chrome】本地保护层 fixture 回归——默认跳过：
 *   LASSO_TEST_INPUT_GUARD=1 npx vitest run test/integration/bug11-input-guard-fixture.spec.ts
 * （真 spawn chrome-devtools-mcp@1.7.0 + headless Chromium——重且依赖 npx 网络，
 *  gate 不跑；单测面覆盖见 test/unit/bug11-input-guard.spec.ts。）
 *
 * fixture：test/fixtures/input-guard/guard.html（三型机制各一元素）。
 * 断言（决议 §6-2）：
 *  1. ref 路 fill（脚本设值）→ data.input_guard_suspected 且 check 型对号
 *     （r1→react_tracker_divergence / r2→value_setter_non_native /
 *      r3→fill_readback_mismatch）
 *  2. type 动作（上游 type_text 逐字 CDP 派发）→ 三元素全存活（blur 后值在）
 *  3. uid 路 fill（fill_form 短值 = puppeteer 逐字 typing）→ blur 后存活
 *
 * 服务绑 **IPv4 loopback 127.0.0.1**（DEFAULT_ALLOW_RANGES 127.0.0.1/32 放行
 * ——零配置正门）；URL 用字面量 http://127.0.0.1:<port>/guard.html——localhost
 * 解析形态随环境可含 ::1（guard 拒 private_ip:::1，单测钉见 bug11-input-guard
 * .spec.ts D-η 段）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { newRunId } from "../../src/util/run-id.js";
import type { BrowseOptions, BrowseResult, InteractResult } from "../../src/types.js";

const OPT_IN = process.env.LASSO_TEST_INPUT_GUARD === "1";
const GUARD_HTML_PATH = fileURLToPath(
  new URL("../fixtures/input-guard/guard.html", import.meta.url),
);

describe.skipIf(!OPT_IN)("bug11 §6-2 — 本地保护层 fixture（真 upstream，opt-in）", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let subproc: SubprocessManager;
  let ch: HeadlessChannel;

  beforeAll(async () => {
    const html = await readFile(GUARD_HTML_PATH, "utf8");
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      });
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}/guard.html`; // 字面量（D-η）

    setStateStoreContext({ runId: newRunId(), cacheDir: "/tmp/lasso-bug11-fixture" });
    subproc = new SubprocessManager();
    ch = new HeadlessChannel(subproc);
    // fill/type 非 ensure-nav——先以 ensure-nav action（snapshot）建立 fixture 页
    const boot = await ch.browse(baseUrl, "snapshot", {} as BrowseOptions);
    expect(boot.outcome).toBe("worked");
    expect(boot.data?.final_url).toContain("127.0.0.1");
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    // 树杀 npx 上游子进程（永不触碰用户 Chrome——headless spec 自管 Chromium）
    subproc.killAllSync();
  }, 30_000);

  it("① ref 路 fill：三元素 check 型对号（r1→G3 / r2→G1 / r3→G2）+ hint + outcome worked", async () => {
    const r: InteractResult<BrowseResult> = await ch.browse(baseUrl, "fill", {
      selectors: { r1: "script-set-1", r2: "script-set-2", r3: "script-set-3" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked"); // advisory——不伪造失败
    const sig = r.data?.input_guard_suspected;
    expect(sig).toBeTruthy();
    expect(sig!.checks).toContain("react_tracker_divergence"); // r1
    expect(sig!.checks).toContain("value_setter_non_native"); // r2
    expect(sig!.checks).toContain("fill_readback_mismatch"); // r3
    expect(sig!.target).toContain("r1");
    expect(r.hint).toContain("suspected site input guard");
  }, 60_000);

  it("② type 动作：可信管道逐字键入 → 三元素全存活（blur 后值在；无值损失类信号）", async () => {
    // type APPENDS（Playwright page.type 语义——fill 才是 replace）：① 已 fill 过
    // 值，先换 cache-bust URL 重载干净页（type 非 ensure-nav，须借 ensure-nav
    // action 建立新页）
    await ch.browse(`${baseUrl}?t=fresh-type`, "snapshot", {} as BrowseOptions);
    const r = await ch.browse(`${baseUrl}?t=fresh-type`, "type", {
      selectors: {
        r1: "typed-1",
        r2: "typed-2",
        r3: "typed-3",
      },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // 值损失类探针（G2/G3）不得命中——typed keys 被接受。G1（安装态）在 r2 上
    // 如实仍在（accessor 劫持是安装事实，与值存活性正交——advisory 语义）
    const sig = r.data?.input_guard_suspected;
    if (sig) {
      expect(sig.checks).not.toContain("fill_readback_mismatch");
      expect(sig.checks).not.toContain("react_tracker_divergence");
    }
    // blur 后读回（TEST 主动 blur 验证存活——lasso 探针自身禁 blur，此处是断言面）
    const check = await ch.browse(`${baseUrl}?t=fresh-type`, "evaluate", {
      js: `() => {
        var out = {};
        for (var i = 1; i <= 3; i++) {
          var el = document.querySelector('[data-lasso-uid="r' + i + '"]');
          el.blur();
          out["r" + i] = el.value;
        }
        return JSON.stringify(out);
      }`,
    } as BrowseOptions);
    const vals = JSON.parse(check.data?.preview ?? "{}");
    expect(vals.r1).toBe("typed-1");
    expect(vals.r2).toBe("typed-2");
    expect(vals.r3).toBe("typed-3");
  }, 60_000);

  it("③ uid 路 fill（短值 = fill_form 逐字 typing）→ blur 后存活", async () => {
    await ch.browse(`${baseUrl}?t=fresh-uid`, "snapshot", {} as BrowseOptions);
    const snap = await ch.browse(`${baseUrl}?t=fresh-uid`, "snapshot", {} as BrowseOptions);
    expect(snap.outcome).toBe("worked");
    // 从 a11y 快照提取 react-like 的 **textbox 节点** uid（形如 `uid=1_4 textbox
    // "react-like"`——同名 StaticText label 行在上一行，须排除）
    const line = (snap.data?.preview ?? "")
      .split("\n")
      .find((l) => l.includes("textbox") && l.includes("react-like"));
    expect(line).toBeTruthy();
    const uid = (line!.match(/uid=(\d+_\d+)/) ?? [])[1];
    expect(uid).toBeTruthy();
    const r = await ch.browse(`${baseUrl}?t=fresh-uid`, "fill", {
      selectors: { [uid!]: "uid-typed" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const check = await ch.browse(`${baseUrl}?t=fresh-uid`, "evaluate", {
      js: `() => {
        var el = document.getElementById("react-like");
        el.blur();
        return el.value;
      }`,
    } as BrowseOptions);
    expect(check.data?.preview).toBe("uid-typed");
  }, 60_000);
});
