/**
 * chrome-hide.ts（v1.10 parse18 §3.3 机制二 —— macOS 隐藏保险丝，PID 定向）
 *
 * 红线（parse18 §3.1 E8 实测事故级结论）：**永不按进程名 hide**——
 * `tell application "Google Chrome" to set visible of front window to false`
 * 类按名形态会误伤用户自己日常在用的 Chrome（同名不同实例）。唯一安全形态是
 * System Events 里按 **unix id（PID）** 定向遍历（E8' 实证片段）。
 *
 * 定位：保险丝而非主路径——hidden 档 primary 是 `--no-startup-window`（启动级零
 * 窗口）；本函数在 spawn 成功后 1-2s 补一次 PID 定向 hide，兜「激活类操作 unhide /
 * fallback 离屏档窗口闪现」的残余。需要 Accessibility TCC 授权（System Events）；
 * 无授权（osascript -1743）→ { ok:false, reason } 降级不 fail（doctor 可查项，P2）。
 *
 * INV-64 合规：只 import node:child_process（osascript spawnSync）。
 * 非 mac 平台 / 无 pid → no-op（execFn 零调用；Windows 保险丝本版不实现——
 * 两段式 ShowWindowAsync 方案落 doc/TROUBLESHOOTING.md，#W-pending 范式）。
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

/** hide 结果：ok=false 不抛错（保险丝永不阻断 launch 主流程）。 */
export interface ChromeHideResult {
  ok: boolean;
  reason?: string;
}

export interface ChromeHideOptions {
  /** 测试注入 platform（生产走 process.platform；非 darwin no-op）。 */
  platform?: string;
  /**
   * 测试注入 osascript 执行器（生产 spawnSync osascript -e <script>）。
   * 返 { status } 即可（非零 = 含 -1743 无 TCC 在内的一切失败）。
   */
  execFn?: (args: string[]) => { status: number | null; stderr?: string };
}

/**
 * 按 unix id 定向 hide 一个 Chrome 进程（AppleScript，E8' 实证片段）。
 *
 * 脚本形态（PID 定向是红线）：
 *   tell application "System Events"
 *     repeat with p in (application processes whose name is "Google Chrome")
 *       if unix id of p is <PID> then set visible of p to false
 *     end repeat
 *   end tell
 *
 * @param pid launch-chrome spawn 返回的 Chrome 根进程 pid（台账在案）
 */
/** P4（v1.17.3）：show 变体——登录后需要再看窗口时恢复可见。 */
export function showChromeByPid(
  pid: number | undefined,
  opts: ChromeHideOptions = {},
): ChromeHideResult {
  return setChromeVisibleByPid(pid, opts, true);
}

export function hideChromeByPid(
  pid: number | undefined,
  opts: ChromeHideOptions = {},
): ChromeHideResult {
  return setChromeVisibleByPid(pid, opts, false);
}

/**
 * P4（v1.17.3）：PID 定向 visible 开关共用实现（hide=false / show=true）。
 * 「登录时弹窗、登录后 chrome-hide 转后台静默」用法的产品出口。
 */
function setChromeVisibleByPid(
  pid: number | undefined,
  opts: ChromeHideOptions,
  visible: boolean,
): ChromeHideResult {
  const platform = opts.platform ?? process.platform;
  // 非 mac no-op（Windows 保险丝本版不实现：#W-pending，文档级方案）
  if (platform !== "darwin") return { ok: false, reason: "non_mac_noop" };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "no_pid" };
  }
  const script =
    'tell application "System Events"\n' +
    "  repeat with p in (application processes whose name is \"Google Chrome\")\n" +
    `    if unix id of p is ${pid} then set visible of p to ${visible ? "true" : "false"}\n` +
    "  end repeat\n" +
    "end tell";
  const execFn =
    opts.execFn ??
    ((args: string[]) => {
      try {
        const r = spawnSync("osascript", args, { encoding: "utf8", timeout: 2_000 });
        return { status: r.status, stderr: r.stderr };
      } catch {
        return { status: -1 };
      }
    });
  const r = execFn(["-e", script]);
  if (r.status !== 0) {
    // 含 Accessibility TCC 缺失（System Events -1743）在内的一切非零退 → 降级不 fail
    return { ok: false, reason: `osascript_exit_${r.status ?? "null"}` };
  }
  return { ok: true };
}
