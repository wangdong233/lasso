/**
 * proxy-egress.spec.ts（v1.11 round1 T10 —— LASSO_PROXY 出口支持）
 *
 * 验收（round1-verdict T10）：
 *  1. config：LASSO_PROXY env → config.proxy（trim；空/未设 = ""）
 *  2. headless spec 含 --proxy-server（设 proxy 时）；未设无 flag（byte-identical）
 *  3. Steel sessionProvider 收 proxyUrl（session body proxyUrl 生效）
 *  4. **browse_logged_in 永不读取 LASSO_PROXY**（负向测试钉死——用户真实
 *     Chrome 出口必须原样；源码级 + 行为级双断言）
 *  5. doctor proxy_config 回显检查项
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../src/config/config.js";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import { SteelChannel } from "../../src/channels/SteelChannel.js";
import { StealthEngine } from "../../src/browse/StealthEngine.js";
import { LockedInSpecCapture } from "../helpers/spec-capture.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import { runDoctor } from "../../src/doctor/doctor.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";

let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-t10-"));
  setStateStoreContext({ runId, cacheDir: tempCache });
  delete process.env.LASSO_PROXY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LASSO_PROXY;
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    /* teardown 尽力而为 */
  }
});

// ============================================================
// 1. config 层
// ============================================================
describe("T10 — config LASSO_PROXY", () => {
  it("env LASSO_PROXY → config.proxy（trim）", () => {
    process.env.LASSO_PROXY = "  http://127.0.0.1:7890  ";
    const cfg = loadConfig({ runId: "t", env: process.env as never });
    expect(cfg.proxy).toBe("http://127.0.0.1:7890");
  });

  it("未设 → config.proxy = ''（默认直连 byte-identical）", () => {
    const cfg = loadConfig({ runId: "t", env: process.env as never });
    expect(cfg.proxy).toBe("");
  });
});

// ============================================================
// 2. headless spec
// ============================================================
describe("T10 — headless spec --proxy-server", () => {
  it("设 proxy → spec args 含 --proxy-server=<v>", () => {
    const cap = new LockedInSpecCapture();
    new HeadlessChannel(
      cap.asSubprocessManager(),
      new StealthEngine(),
      "windows_chrome_120",
      "http://127.0.0.1:7890",
    );
    const spec = cap.get("headless");
    expect(spec.args).toContain("--proxy-server=http://127.0.0.1:7890");
  });

  it("未设 proxy → spec args 无 --proxy-server（v1.10 byte-identical）", () => {
    const cap = new LockedInSpecCapture();
    new HeadlessChannel(cap.asSubprocessManager());
    const spec = cap.get("headless");
    expect(spec.args.some((a: string) => a.startsWith("--proxy-server"))).toBe(false);
  });
});

// ============================================================
// 3. Steel session proxyUrl
// ============================================================
describe("T10 — Steel session proxyUrl", () => {
  it("proxyUrl 配置 → sessionProvider 收到 proxyUrl（session body 生效）", async () => {
    const providerCalls: Array<{ endpoint: string; proxyUrl?: string }> = [];
    const cap = new LockedInSpecCapture();
    const ch = new SteelChannel(
      cap.asSubprocessManager(),
      "http://localhost:3000",
      new StealthEngine(),
      {
        proxyUrl: "http://127.0.0.1:7890",
        sessionProvider: async (endpoint, proxyUrl) => {
          providerCalls.push({ endpoint, proxyUrl });
          return { sessionId: "s-1", status: "live" };
        },
      },
    );
    await (ch as unknown as { getMcpClient(): Promise<unknown> }).getMcpClient();
    expect(providerCalls[0]!.proxyUrl).toBe("http://127.0.0.1:7890");
  });

  it("未配 proxy → sessionProvider 收 undefined（v1.10 调用形状）", async () => {
    const providerCalls: Array<{ proxyUrl?: string }> = [];
    const cap = new LockedInSpecCapture();
    const ch = new SteelChannel(
      cap.asSubprocessManager(),
      "http://localhost:3000",
      new StealthEngine(),
      {
        sessionProvider: async (_endpoint, proxyUrl) => {
          providerCalls.push({ proxyUrl });
          return { sessionId: "s-2", status: "live" };
        },
      },
    );
    await (ch as unknown as { getMcpClient(): Promise<unknown> }).getMcpClient();
    expect(providerCalls[0]!.proxyUrl).toBeUndefined();
  });
});

// ============================================================
// 4. logged_in 永不读取（负向测试钉死）
// ============================================================
describe("T10 — browse_logged_in 永不读 LASSO_PROXY（铁律）", () => {
  it("源码级：LoggedInChannel.ts 无 LASSO_PROXY / proxy-server 字样", () => {
    const filePath = fileURLToPath(
      new URL("../../src/channels/LoggedInChannel.ts", import.meta.url),
    );
    const src = readFileSync(filePath, "utf8");
    // 去注释后检查代码本体
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly).not.toContain("LASSO_PROXY");
    expect(codeOnly).not.toMatch(/proxy-server/);
  });

  it("行为级：LASSO_PROXY env 设置时 logged_in spec 仍无 proxy flag", async () => {
    process.env.LASSO_PROXY = "http://127.0.0.1:7890";
    const cap = new LockedInSpecCapture();
    const { LoggedInChannel } = await import(
      "../../src/channels/LoggedInChannel.js"
    );
    const profiles = {
      getCurrent: () => ({ name: "default" }),
      currentName: () => "default",
      list: () => [],
      add: async () => {},
      switch: async () => {},
    } as never;
    const ch = new LoggedInChannel(
      cap.asSubprocessManager(),
      9222,
      profiles,
      () => ({}) as never,
    );
    await (ch as unknown as { getMcpClient(): Promise<unknown> }).getMcpClient();
    const spec = cap.get("logged_in:default");
    // 用户真实 Chrome 出口必须原样——永不带 proxy flag
    expect(spec.args.some((a: string) => a.startsWith("--proxy-server"))).toBe(false);
    void (ch as unknown as { subproc: SubprocessManager });
  });
});

// ============================================================
// 5. doctor 回显
// ============================================================
describe("T10 — doctor proxy_config 回显", () => {
  it("配置时：detail 回显 LASSO_PROXY 值 + 生效面说明", async () => {
    const r = await runDoctor({ skipInvariants: true, proxy: "http://127.0.0.1:7890" });
    const c = r.checks.find((x) => x.name === "proxy_config");
    expect(c).toBeTruthy();
    expect(c!.status).toBe("pass");
    expect(c!.detail).toContain("http://127.0.0.1:7890");
    expect(c!.detail).toContain("browse_logged_in 不读取");
  });

  it("未配置：detail 提示默认直连", async () => {
    const r = await runDoctor({ skipInvariants: true, proxy: "" });
    const c = r.checks.find((x) => x.name === "proxy_config");
    expect(c!.detail).toContain("未配置");
  });
});
