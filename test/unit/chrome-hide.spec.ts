/**
 * chrome-hide.spec.ts（v1.10 parse18 §7.1 机制二保险丝 18-20）
 *
 * 守护 macOS 隐藏保险丝（PID 定向红线——E8 实测按名 hide 误伤用户日常 Chrome）：
 *  18. AppleScript 片段含目标 pid 数字且含 `unix id`（PID 定向）
 *  19. osascript 非零退（含 -1743 无 TCC）→ { ok:false } 不抛（降级不 fail）
 *  20. platform=win / pid undefined → no-op（execFn 零调用）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  hideChromeByPid,
  hideChromeByPidAsync,
  showChromeByPidAsync,
} from "../../src/launcher/chrome-hide.js";

describe("chrome-hide —— macOS PID 定向隐藏保险丝（parse18 §3.3）", () => {
  it("18. AppleScript 片段含目标 pid 数字且含 unix id（永不按进程名裸 hide）", () => {
    const execCalls: Array<string[]> = [];
    const r = hideChromeByPid(54321, {
      platform: "darwin",
      execFn: (args) => {
        execCalls.push(args);
        return { status: 0 };
      },
    });
    expect(r.ok).toBe(true);
    expect(execCalls.length).toBe(1);
    const script = execCalls[0].join("\n");
    expect(script).toContain("unix id");
    expect(script).toContain("54321");
    expect(script).toContain("set visible of p to false");
    // 红线：不含按进程名裸 hide 形态（E8 事故）
    expect(script).not.toContain('set visible of process "Google Chrome" to false');
  });

  it("19. osascript 非零退 → { ok:false, reason } 不抛（TCC 缺失降级）", () => {
    const r = hideChromeByPid(54321, {
      platform: "darwin",
      execFn: () => ({ status: 1743, stderr: "execution error: Not authorized" }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("1743");
    // 不抛错（保险丝永不阻断 launch 主流程）
    expect(() =>
      hideChromeByPid(1, {
        platform: "darwin",
        execFn: () => ({ status: null }),
      }),
    ).not.toThrow();
  });

  it("20. platform=win / pid undefined → no-op（execFn 零调用）", () => {
    const execCalls: Array<string[]> = [];
    const execFn = (args: string[]) => {
      execCalls.push(args);
      return { status: 0 };
    };
    const rWin = hideChromeByPid(54321, { platform: "win32", execFn });
    expect(rWin.ok).toBe(false);
    expect(rWin.reason).toBe("non_mac_noop");
    const rLinux = hideChromeByPid(54321, { platform: "linux", execFn });
    expect(rLinux.ok).toBe(false);
    const rNoPid = hideChromeByPid(undefined, { platform: "darwin", execFn });
    expect(rNoPid.ok).toBe(false);
    expect(rNoPid.reason).toBe("no_pid");
    expect(execCalls).toEqual([]); // 三种 no-op 形态都不触 osascript
  });
});

/**
 * P31（v1.18.3 同类横扫 S3/S4）：server 进程内 hide 原语异步化。
 *
 * 背景：reaper autoHide tick（server 常驻 15s timer）与 MCP chrome-launch 隐藏
 * 保险丝此前走 spawnSync 同步版（2s 上限）——Chrome 忙时 System Events AX 枚举
 * 可 >2s（P27 真机实证），同步形态阻塞 server 事件循环 / MCP 请求处理。
 * 本组守护异步变体的行为面（PID 定向红线 / 降级不抛 / no-op）与形态面
 * （execFile + 4s SIGKILL；脚本体 sync/async 单一真源）。
 */
describe("chrome-hide 异步变体 —— P31（server 进程内零事件循环阻塞）", () => {
  it("P31-1. hideChromeByPidAsync：PID 定向脚本（unix id + 目标 pid + set visible false；红线不因异步松动）", async () => {
    const execCalls: Array<string[]> = [];
    const r = await hideChromeByPidAsync(54321, {
      platform: "darwin",
      execFn: (args) => {
        execCalls.push(args);
        return { status: 0 };
      },
    });
    expect(r.ok).toBe(true);
    expect(execCalls.length).toBe(1);
    const script = execCalls[0].join("\n");
    expect(script).toContain("unix id");
    expect(script).toContain("54321");
    expect(script).toContain("set visible of p to false");
    // 红线：不含按进程名裸 hide 形态（E8 事故；异步版同守）
    expect(script).not.toContain('set visible of process "Google Chrome" to false');
  });

  it("P31-2. showChromeByPidAsync：极性 true（与 hide 共用 setChromeVisibleByPidAsync 单点分发）", async () => {
    const seen: string[] = [];
    const r = await showChromeByPidAsync(54321, {
      platform: "darwin",
      execFn: (args) => {
        seen.push(args.join(" "));
        return { status: 0 };
      },
    });
    expect(r.ok).toBe(true);
    expect(seen[0]).toContain("set visible of p to true");
  });

  it("P31-3. 非零退降级不抛（TCC -1743）/ 非 mac / 无 pid → no-op（execFn 零调用）", async () => {
    const r = await hideChromeByPidAsync(54321, {
      platform: "darwin",
      execFn: () => ({ status: 1743 }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("1743");
    const execCalls: Array<string[]> = [];
    const execFn = (args: string[]) => {
      execCalls.push(args);
      return { status: 0 };
    };
    const rWin = await hideChromeByPidAsync(54321, { platform: "win32", execFn });
    expect(rWin).toEqual({ ok: false, reason: "non_mac_noop" });
    const rNoPid = await hideChromeByPidAsync(undefined, { platform: "darwin", execFn });
    expect(rNoPid).toEqual({ ok: false, reason: "no_pid" });
    expect(execCalls).toEqual([]); // no-op 形态不触 osascript
  });

  it("P31-4. 白盒：execFile 4s 超时 + SIGKILL（reassert 同款形态）；脚本体 sync/async 单一真源", () => {
    const src = readFileSync("src/launcher/chrome-hide.ts", "utf8");
    // 异步原语（reassert + visible 开关）两处都是 4s kill 上限——禁回落 spawnSync 2s 形态混用
    expect((src.match(/timeout: 4_000/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/killSignal: "SIGKILL"/);
    // 脚本体单源：setVisibleScript 定义 + sync 消费 + async 消费（极性单点三元插值）
    expect((src.match(/setVisibleScript\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/\$\{visible \? "true" : "false"\}/);
    // 异步出口双极性经同一私有实现分发（与同步版 G1-5 对称）
    expect(src).toMatch(
      /export function hideChromeByPidAsync[\s\S]{0,200}setChromeVisibleByPidAsync\(pid, opts, false\)/,
    );
    expect(src).toMatch(
      /export function showChromeByPidAsync[\s\S]{0,200}setChromeVisibleByPidAsync\(pid, opts, true\)/,
    );
  });
});
