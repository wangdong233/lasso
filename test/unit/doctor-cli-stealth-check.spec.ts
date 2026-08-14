/**
 * doctor-cli-stealth-check.spec.ts（D11 修复，v1.8 Phase D）
 *
 * 守护点：`lasso doctor --stealth-check` 的 flag 解析 + provider 装配。
 * v1.7 main() 完全忽略该 flag（wave1 T-CLI-05：flag 对输出零影响，
 * #38 两模式恒 warn-skip）→ README「跑 lasso doctor --stealth-check 看 creepjs
 * 检测对比」承诺不真实。
 *
 * 测试策略：buildDoctorCliOptions 是纯装配函数（DI 注入 headless 句柄），
 * 不真 spawn chrome-devtools-mcp（npx 冷启动 11-13s + 网络依赖，CI 不友好）：
 *  1. 无 flag → 零回归（无 provider / 无 shutdown）
 *  2. 有 flag → stealthCheck=true + provider 注入；provider 返 mock client
 *  3. ensureRunning 抛错 → provider 返 null（#38 warn 语义，不 fail）
 *  4. shutdown 联动句柄清理（W1-DEF-6 教训：不留孤儿子进程）
 *  5. flag 解析只认 --stealth-check（argv 切片，不误吞其它 doctor flag）
 */
import { describe, it, expect, vi } from "vitest";
import { buildDoctorCliOptions } from "../../src/doctor/doctor-cli.js";
import type { HeadlessClientHandle } from "../../src/doctor/doctor-cli.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

function makeFakeHandle(impl?: {
  ensureRunning?: () => Promise<McpClient>;
}): {
  handle: HeadlessClientHandle;
  ensureRunning: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
} {
  const ensureRunning = vi.fn(
    impl?.ensureRunning ??
      (async () => ({ listTools: vi.fn() }) as unknown as McpClient),
  );
  const shutdown = vi.fn(async () => {});
  return {
    handle: { ensureRunning, shutdown },
    ensureRunning,
    shutdown,
  };
}

describe("buildDoctorCliOptions — D11 --stealth-check 装配", () => {
  it("无 --stealth-check → stealthCheck=false + 无 provider + 无 shutdown（零回归）", () => {
    const r = buildDoctorCliOptions(["--json"]);
    expect(r.stealthCheck).toBe(false);
    expect(r.doctorOpts.stealthCheck).toBeUndefined();
    expect(r.doctorOpts.stealthCheckClientProvider).toBeUndefined();
    expect(r.shutdown).toBeNull();
  });

  it("有 --stealth-check → stealthCheck=true + provider 注入（provider 返 headless client）", async () => {
    const { handle, ensureRunning } = makeFakeHandle();
    const r = buildDoctorCliOptions(["--stealth-check"], {
      headless: () => handle,
    });
    expect(r.stealthCheck).toBe(true);
    expect(r.doctorOpts.stealthCheck).toBe(true);
    expect(r.doctorOpts.stealthCheckClientProvider).toBeTypeOf("function");
    // provider 契约（doctor.ts #38）：返已连的 McpClient（此处为 mock 句柄返回值）
    const client = await r.doctorOpts.stealthCheckClientProvider!();
    expect(client).toBeTruthy();
    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });

  it("flag 在 doctor 子命令 argv 切片任意位置都能识别（--stealth-check 不必是首参）", () => {
    const { handle } = makeFakeHandle();
    const r1 = buildDoctorCliOptions(["--stealth-check"], {
      headless: () => handle,
    });
    const r2 = buildDoctorCliOptions(["--skip-network", "--stealth-check"], {
      headless: () => handle,
    });
    expect(r1.stealthCheck).toBe(true);
    expect(r2.stealthCheck).toBe(true);
  });

  it("ensureRunning 抛错 → provider 返 null（#38 warn 语义；不向上抛）", async () => {
    const { handle } = makeFakeHandle({
      ensureRunning: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    const r = buildDoctorCliOptions(["--stealth-check"], {
      headless: () => handle,
    });
    const client = await r.doctorOpts.stealthCheckClientProvider!();
    expect(client).toBeNull();
  });

  it("shutdown 联动句柄清理（doctor 跑完 kill headless 子进程，不留孤儿）", async () => {
    const { handle, shutdown } = makeFakeHandle();
    const r = buildDoctorCliOptions(["--stealth-check"], {
      headless: () => handle,
    });
    expect(r.shutdown).toBeTypeOf("function");
    await r.shutdown!();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("默认依赖路径真装配（不传 deps → 真 SubprocessManager + HeadlessChannel spec 注册）", async () => {
    // 不真 spawn：只验证 build 出的形状完整（provider 懒启动——构造期无子进程副作用）
    const r = buildDoctorCliOptions(["--stealth-check"]);
    expect(r.stealthCheck).toBe(true);
    expect(r.doctorOpts.stealthCheck).toBe(true);
    expect(r.doctorOpts.stealthCheckClientProvider).toBeTypeOf("function");
    expect(r.shutdown).toBeTypeOf("function");
    // 不调 provider（会真 npx spawn）；仅断言构造期零副作用成立
  });
});
