/**
 * C5（doc/bugs/09 决议 C5，2026-09-16）：logged_in CDP 端口可配 + doctor 报当前生效端口
 *
 * 现状盘点（本 spec 落地时的白盒事实，防重复覆盖）：
 *  - 三层解析已由 BUG-08 E-1 落地（config 文件键/env `LASSO_CDP_PORT` > 默认 9222；
 *    显式恒赢 + 失败时台账自动发现）——loadConfig 层测试在 config-file.spec.ts
 *    （file 键→cdpPort=9333 / NaN 越界守卫 / parseCdpPort 纯函数），通道层
 *    「显式口永不自动发现」在 bug08-e.spec.ts。本文件不重复。
 *  - 本文件钉的是决议 C5 的增量面：**doctor 检查项同步报当前生效端口**——
 *    check 名 `cdp_9222_logged_in` 是历史稳定契约（消费方按名匹配），实探口
 *    可配；名与口不一致时 detail 是唯一如实报口的面（失败 detail 前缀
 *    `CDP :<port>`，成功 detail 本就带口）。
 *  - 回归锚：runDoctor 端口解析保持 `opts.cdpPort ?? parseCdpPort(env)` 单源
 *    （装配层显式注入恒赢 > env > 默认）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCdp9222 } from "../../src/doctor/doctor.js";

// next_step 探针全注入拒连（快速 free 面，不触真机——与 a2-zombie-selfheal C3 同款）
const fastDeps = (fetchFn: (url: string) => Promise<Response>) => ({
  fetchFn,
  tcpFn: async () => false,
});

describe("C5 · doctor checkCdp9222 报当前生效端口", () => {
  it("5a. 自定义口 9333 拒连 → detail 前缀 `CDP :9333`（名口不一致时如实报口）", async () => {
    const r = await checkCdp9222(
      9333,
      fastDeps(async () => {
        throw new Error("fetch failed: Error: connect ECONNREFUSED 127.0.0.1:9333");
      }),
    );
    expect(r.name).toBe("cdp_9222_logged_in"); // 名是稳定契约，不随口改名
    expect(r.detail).toBe("CDP :9333 /json/version: connection refused");
    expect(r.next_step).toBeTruthy();
  });

  it("5b. 自定义口 9333 HTTP 非 2xx → detail 前缀同样带实探口", async () => {
    const r = await checkCdp9222(
      9333,
      fastDeps(async () => new Response("nope", { status: 503 })),
    );
    expect(r.detail).toContain("CDP :9333 /json/version returned HTTP 503");
    expect(r.status).toBe("fail");
  });

  it("5c. 自定义口 9333 健康路径 → 成功 detail 带口（措辞既有契约零回归）", async () => {
    const r = await checkCdp9222(9333, {
      fetchFn: async (url: string) =>
        url.includes("/json/version")
          ? new Response(JSON.stringify({ Browser: "Chrome/150" }), { status: 200 })
          : new Response(JSON.stringify([{ id: "t1" }]), { status: 200 }),
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("1 tabs on CDP port 9333");
    expect(r.name).toBe("cdp_9222_logged_in");
  });

  it("5d. 默认口回归锚：9222 失败 detail 前缀 `CDP :9222`（默认路径同格式——单一格式无分支）", async () => {
    const r = await checkCdp9222(
      9222,
      fastDeps(async () => {
        throw new Error("This operation was aborted due to timeout");
      }),
    );
    expect(r.detail).toBe("CDP :9222 /json/version: fetch aborted (timeout)");
  });

  it("5e. runDoctor 端口解析单源回归锚：opts.cdpPort 显式注入恒赢 > parseCdpPort(env)", async () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/doctor/doctor.ts", import.meta.url)),
      "utf-8",
    );
    // 装配层（index.ts CLI/MCP 两路）都显式传 config.cdpPort——本断言钉住该优先级
    // 不被「直读 env」回退侵蚀（doctor.spec.ts 已钉 parseCdpPort 在场，此处钉 ?? 序）
    expect(src).toMatch(/opts\.cdpPort \?\? parseCdpPort\(process\.env\.LASSO_CDP_PORT\)/);
  });
});
