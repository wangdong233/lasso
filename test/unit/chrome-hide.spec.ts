/**
 * chrome-hide.spec.ts（v1.10 parse18 §7.1 机制二保险丝 18-20）
 *
 * 守护 macOS 隐藏保险丝（PID 定向红线——E8 实测按名 hide 误伤用户日常 Chrome）：
 *  18. AppleScript 片段含目标 pid 数字且含 `unix id`（PID 定向）
 *  19. osascript 非零退（含 -1743 无 TCC）→ { ok:false } 不抛（降级不 fail）
 *  20. platform=win / pid undefined → no-op（execFn 零调用）
 */
import { describe, it, expect } from "vitest";
import { hideChromeByPid } from "../../src/launcher/chrome-hide.js";

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
