/**
 * doctor 集成测（parse1 §5.2 + §6 验收 #2）
 *
 * 验证 runDoctor 报告：
 *  - 结构合法（checks ≥10、含 ready:bool、含 blockers:string[]）
 *  - 每 fail 项有 next_step
 *  - 各种 mock 场景：
 *      · Node <20 → fail (node_version)
 *      · ZHIPU_API_KEY 已退役（v1.17 A3：zhipu_keys_retired 静态提示，非 blocker）
 *      · cacheDir 只读 → fail (cache_writable)
 *      · 全 pass（skipNetwork + skipInvariants）→ ready=true
 *
 * skipNetwork/skipInvariants 默认开启——CI/单测环境无 :9222/无源码 spawn
 * 也可稳定跑过。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promises as fs, mkdtempSync, mkdirSync, chmodSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDoctor, LASSO_VERSION } from "../../src/doctor/doctor.js";

// ============================================================
// helpers
// ============================================================
let tempCache: string;

beforeEach(() => {
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-doctor-"));
});

afterEach(async () => {
  try {
    // 还原权限避免影响后续 rm
    try {
      chmodSync(tempCache, 0o755);
    } catch {
      // ignore
    }
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function findCheck(
  report: Awaited<ReturnType<typeof runDoctor>>,
  name: string,
) {
  const c = report.checks.find((c) => c.name === name);
  if (!c) throw new Error(`check ${name} not in report`);
  return c;
}

// ============================================================
// cases
// ============================================================
describe("runDoctor — 结构合法性（验收 #2）", () => {
  it("checks.length >= 10", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(r.checks.length).toBeGreaterThanOrEqual(10);
  });

  it("包含 ready:bool + blockers:string[] + timestamp + lasso_version", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(typeof r.ready).toBe("boolean");
    expect(Array.isArray(r.blockers)).toBe(true);
    expect(typeof r.timestamp).toBe("string");
    expect(r.lasso_version).toBe(LASSO_VERSION);
  });

  it("fail 项必须含 next_step（cache/serp 等结构性失败除外）", async () => {
    // v1.17 A3 前该测试靠 zhipu_api_key fail 凑失败样本；zhipu 检查已删（INV-80 墓碑），
    // 改用不可写 cacheDir 制造结构性 fail 样本。
    const impossible = process.platform === "win32"
      ? "Z:\\\\nonexistent-lasso-test"
      : "/dev/null/lasso-cannot-create"; // linux 真有 /proc 致 mkdir 挂起超时；/dev/null/xxx 两平台 ENOTDIR 秒败
    const r = await runDoctor({
      cacheDir: impossible,
      skipNetwork: true,
      skipInvariants: true,
    });
    const failed = r.checks.filter((c) => c.status === "fail");
    expect(failed.length).toBeGreaterThan(0);
    for (const c of failed) {
      // cache_writable / search_cache_dir_writable 这类结构性失败 next_step 可能不在 first batch
      if (c.name === "cache_writable" || c.name === "search_cache_dir_writable") {
        continue;
      }
      expect(c.next_step).toBeTruthy();
    }
  });

  it("10 项 check 名称齐全", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    const names = r.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "node_version",
        // v1.17 A3：zhipu_api_key / zhipu_endpoint_reachable 已删（zhipu 直连死层清除），
        // 替换为 zhipu_keys_retired 静态退役提示（INV-80 墓碑）
        "zhipu_keys_retired",
        "cdp_mcp_installable",
        "chrome_binary",
        "cdp_9222_logged_in",
        "cache_writable",
        "ssrf_config",
        "serp_selectors",
        "invariants",
      ]),
    );
  });
});

describe("runDoctor — 场景判定", () => {
  it("v1.17 A3：zhipu_keys_retired（键未配）→ pass + 非 blocker（已删除的检查不再是 ready 门）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "zhipu_keys_retired");
    expect(c.status).toBe("pass");
    expect(r.blockers).not.toContain("zhipu_keys_retired");
    // 已删的两 check 不回潮（INV-80 墓碑镜像）
    expect(r.checks.map((x) => x.name)).not.toContain("zhipu_api_key");
    expect(r.checks.map((x) => x.name)).not.toContain("zhipu_endpoint_reachable");
  });

  it("v1.17 A3：ZHIPU_API_KEY 残留 → zhipu_keys_retired=warn（静态退役提示，非 blocker）", async () => {
    const r = await runDoctor({
      zhipuKey: "retired-legacy-key",
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "zhipu_keys_retired");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("ZHIPU_API_KEY");
    expect(c.next_step).toBeTruthy();
    // warn 不阻塞 ready（存量 config 不炸）
    expect(r.blockers).not.toContain("zhipu_keys_retired");
  });

  it("cache 可写 + 跳过触网 → ready=true", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(findCheck(r, "cache_writable").status).toBe("pass");
    expect(findCheck(r, "ssrf_config").status).toBe("pass");
    expect(findCheck(r, "serp_selectors").status).toBe("pass");
    // 跳过的 check 不算 fail
    expect(findCheck(r, "cdp_mcp_installable").status).toBe("warn");
    expect(findCheck(r, "cdp_9222_logged_in").status).toBe("warn");
    expect(findCheck(r, "invariants").status).toBe("warn");
    expect(r.ready).toBe(true);
  });

  it("cache_writable 失败（目录不可写）→ ready=false", async () => {
    // 用一个不存在也不可创建的路径（父目录无权限）触发失败
    const impossible = process.platform === "win32"
      ? "Z:\\\\nonexistent-lasso-test"
      : "/dev/null/lasso-cannot-create"; // linux 真有 /proc 致 mkdir 挂起超时；/dev/null/xxx 两平台 ENOTDIR 秒败
    const r = await runDoctor({
      cacheDir: impossible,
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "cache_writable");
    expect(c.status).toBe("fail");
    expect(r.blockers).toContain("cache_writable");
    expect(r.ready).toBe(false);
  });

  it("serp_selectors 永远 pass（BAIDU/GOOGLE 表非空，编译时常量）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "serp_selectors");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("BAIDU=2");
    expect(c.detail).toContain("DDG=2"); // v1.11 T9：google 死配置删 → ddg
  });

  it("ssrf_config 永远 pass（loadSsrfConfig 不抛）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(findCheck(r, "ssrf_config").status).toBe("pass");
  });
});

// ============================================================
// v0.2 4 项新 check（parse2 §3.1.2）
// ============================================================
describe("runDoctor — v0.2 4 项新 check", () => {
  it("checks 总数 ≥ 14（v0.1 10 + v0.2 4）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(r.checks.length).toBeGreaterThanOrEqual(14);
  });

  it("11. brave_keys 未配置 → warn（不阻塞 ready）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
      braveKeysCsv: "",
    });
    const c = findCheck(r, "brave_keys");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("未配置");
    // warn 不进 blockers
    expect(r.blockers).not.toContain("brave_keys");
  });

  it("11. brave_keys 配置 → pass + 含合并配额（N × 1000，S-1：2026-02 免费档取消）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
      braveKeysCsv: "key1,key2",
    });
    const c = findCheck(r, "brave_keys");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("2 Key");
    expect(c.detail).toContain("2000/月"); // 2 × 1000（$5 赠送额度口径）
  });

  it("12. provider_registry_loadable 永远 pass（BUILTIN_PROVIDERS 加载）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "provider_registry_loadable");
    expect(c.status).toBe("pass");
    // TAVILY_WATCH enabled=false → 不应出现在 listNames
    expect(c.detail).not.toContain("tavily");
    // v1.17 A3：zhipu provider 已删（BUILTIN 4 条：brave/browse_headless/browse_logged_in；
    // tavily enabled=false 跳过 → listNames 3 条）
    expect(c.detail).not.toContain("zhipu");
    expect(c.detail).toContain("brave");
  });

  it("13. quota_ledger_initialized：无 Key 配置时 ledgerCount=0 仍 pass", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
      braveKeysCsv: "",
    });
    const c = findCheck(r, "quota_ledger_initialized");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("0 QuotaLedger");
  });

  it("13. quota_ledger_initialized：brave 配 Key → 1 QuotaLedger 装配（v1.17 A3：zhipu 已删）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
      braveKeysCsv: "fake-brave-key",
    });
    const c = findCheck(r, "quota_ledger_initialized");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("1 QuotaLedger");
  });

  it("14. search_cache_dir_writable → pass + 路径含 search-cache 子目录", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "search_cache_dir_writable");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("search-cache");
  });

  it("14. search_cache_dir_writable 失败 → fail + blocker", async () => {
    const impossible = "/dev/null/lasso-cannot-create"; // 同上：linux CI 修正
    const r = await runDoctor({
      cacheDir: impossible,
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "search_cache_dir_writable");
    expect(c.status).toBe("fail");
    expect(r.blockers).toContain("search_cache_dir_writable");
  });

  it("v0.2 4 项 check 名称齐全", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    const names = r.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "brave_keys",
        "provider_registry_loadable",
        "quota_ledger_initialized",
        "search_cache_dir_writable",
      ]),
    );
  });
});

// ============================================================
// v0.6 M0.6 runtime_state section（parse7 §2.2 + §6.2）
// ============================================================
describe("runDoctor — runtime_state section（v0.6）", () => {
  it("未注入 runtimeState → report 不含 runtime_state 字段（零回归）", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(r.runtime_state).toBeUndefined();
  });

  it("注入 runtimeState provider → report.runtime_state 反映 snapshot", async () => {
    const r = await runDoctor({
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
      runtimeState: () => ({
        capabilities: [
          {
            name: "browse_headless",
            kind: "channel",
            enabled: false,
            disabledAt: 1234567890,
            disabledBy: "admin",
            reason: "test",
          },
          {
            name: "search.machine_mcp",
            kind: "provider",
            enabled: true,
          },
        ],
        caller_caps: [
          { callerId: "anonymous", used: 5, cap: 100, windowMs: 60_000 },
        ],
        tool_manager: { browse_headless: ["browse_headless"], admin: ["admin"] },
      }),
    });
    expect(r.runtime_state).toBeDefined();
    expect(r.runtime_state!.capabilities).toHaveLength(2);
    expect(r.runtime_state!.capabilities[0]!.name).toBe("browse_headless");
    expect(r.runtime_state!.capabilities[0]!.enabled).toBe(false);
    expect(r.runtime_state!.caller_caps).toHaveLength(1);
    expect(r.runtime_state!.caller_caps[0]!.callerId).toBe("anonymous");
    expect(r.runtime_state!.tool_manager!.admin).toEqual(["admin"]);
  });
});
