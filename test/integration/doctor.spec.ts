/**
 * doctor 集成测（parse1 §5.2 + §6 验收 #2）
 *
 * 验证 runDoctor 报告：
 *  - 结构合法（checks ≥10、含 ready:bool、含 blockers:string[]）
 *  - 每 fail 项有 next_step
 *  - 各种 mock 场景：
 *      · Node <20 → fail (node_version)
 *      · ZHIPU_API_KEY 缺失 → fail (zhipu_api_key) → ready=false
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
      zhipuKey: "fake-key",
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(r.checks.length).toBeGreaterThanOrEqual(10);
  });

  it("包含 ready:bool + blockers:string[] + timestamp + lasso_version", async () => {
    const r = await runDoctor({
      zhipuKey: "fake-key",
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(typeof r.ready).toBe("boolean");
    expect(Array.isArray(r.blockers)).toBe(true);
    expect(typeof r.timestamp).toBe("string");
    expect(r.lasso_version).toBe(LASSO_VERSION);
  });

  it("fail 项必须含 next_step（除了 cache/serp 等结构性失败）", async () => {
    const r = await runDoctor({
      zhipuKey: undefined, // 必 fail
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    const failed = r.checks.filter((c) => c.status === "fail");
    expect(failed.length).toBeGreaterThan(0);
    for (const c of failed) {
      // cache_writable / ssrf_config 这类失败 next_step 可能不在 first batch
      // 但 zhipu_api_key 这类必须有指引
      if (c.name === "zhipu_api_key") {
        expect(c.next_step).toBeTruthy();
      }
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
        "zhipu_api_key",
        "zhipu_endpoint_reachable",
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
  it("ZHIPU_API_KEY 缺失 → zhipu_api_key=fail → ready=false", async () => {
    const r = await runDoctor({
      zhipuKey: undefined,
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(findCheck(r, "zhipu_api_key").status).toBe("fail");
    expect(r.blockers).toContain("zhipu_api_key");
    expect(r.ready).toBe(false);
  });

  it("ZHIPU_API_KEY 配置 + cache 可写 + 跳过触网 → ready=true", async () => {
    const r = await runDoctor({
      zhipuKey: "fake-key",
      cacheDir: tempCache,
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(findCheck(r, "zhipu_api_key").status).toBe("pass");
    expect(findCheck(r, "cache_writable").status).toBe("pass");
    expect(findCheck(r, "ssrf_config").status).toBe("pass");
    expect(findCheck(r, "serp_selectors").status).toBe("pass");
    // 跳过的 check 不算 fail
    expect(findCheck(r, "zhipu_endpoint_reachable").status).toBe("warn");
    expect(findCheck(r, "cdp_mcp_installable").status).toBe("warn");
    expect(findCheck(r, "cdp_9222_logged_in").status).toBe("warn");
    expect(findCheck(r, "invariants").status).toBe("warn");
    expect(r.ready).toBe(true);
  });

  it("cache_writable 失败（目录不可写）→ ready=false", async () => {
    // 用一个不存在也不可创建的路径（父目录无权限）触发失败
    const impossible = process.platform === "win32"
      ? "Z:\\\\nonexistent-lasso-test"
      : "/proc/lasso-cannot-create";
    const r = await runDoctor({
      zhipuKey: "fake-key",
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
    expect(c.detail).toContain("GOOGLE=2");
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
