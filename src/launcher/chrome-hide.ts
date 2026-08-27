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
 * INV-64 合规：只 import node:child_process（osascript spawnSync=CLI 短命路径 /
 * execFile=server 进程内异步路径，P27/P31）+ node:process。
 * 非 mac 平台 / 无 pid → no-op（execFn 零调用；Windows 保险丝本版不实现——
 * 两段式 ShowWindowAsync 方案落 doc/usage/02-TROUBLESHOOTING.md，#W-pending 范式）。
 */
import { spawnSync, execFile } from "node:child_process";
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
/**
 * P27（v1.18.3）：reassert 变体——desired-hidden watchdog 专用。
 * 单次 osascript 完成「查可见→可见才压回」，返回是否发生了复隐（wasVisible）：
 *  - 只在 visible=true 时 set false（对已隐藏进程零副作用、零多余写）；
 *  - wasVisible=true 即一次「unhide 闪现被看门狗压回」的实证事件——watchdog
 *    据此打 desired_hidden_reasserted 日志（产品级闪现频率观测点，P27 抓源用）。
 * 与 hideChromeByPid 的差异：后者无条件 set false；本函数先读后写（单脚本内），
 * 返回值携带信号（"hidden"=刚压回 / "already"=本就隐藏 / "nomatch"=进程不在）。
 */
export interface ChromeReassertResult {
  ok: boolean;
  /** true = 本次确实把可见压回了（一次闪现被纠正）。 */
  wasVisible?: boolean;
  reason?: string;
}

export interface ChromeReassertOptions {
  platform?: string;
  /** 测试注入（返回 stdout 以解析 "hidden"/"already"/"nomatch" 信号）。 */
  execFn?: (args: string[]) => { status: number | null; stdout?: string; stderr?: string };
}

/** reassert 的 AppleScript 脚本体（sync/async 两变体共用单一真源）。 */
function reassertScript(pid: number): string {
  return (
    'tell application "System Events"\n' +
    "  repeat with p in (application processes whose name is \"Google Chrome\")\n" +
    `    if unix id of p is ${pid} then\n` +
    "      if visible of p is true then\n" +
    "        set visible of p to false\n" +
    '        return "hidden"\n' +
    "      end if\n" +
    '      return "already"\n' +
    "    end if\n" +
    "  end repeat\n" +
    '  return "nomatch"\n' +
    "end tell"
  );
}

/** osascript stdout 信号 → 结果（sync/async 共用解析）。 */
function parseReassertSignal(
  status: number | null | undefined,
  stdout: string | undefined,
): ChromeReassertResult {
  if (status !== 0) {
    return { ok: false, reason: `osascript_exit_${status ?? "null"}` };
  }
  const sig = (stdout ?? "").trim();
  if (sig === "hidden") return { ok: true, wasVisible: true };
  if (sig === "already") return { ok: true, wasVisible: false };
  if (sig === "nomatch") return { ok: false, reason: "process_not_found" };
  return { ok: false, reason: `unexpected_signal:${sig.slice(0, 20)}` };
}

/**
 * 异步变体（P27 v1.18.3 watchdog 专用）：child_process.execFile 回调——
 * **零事件循环阻塞**。真机实证（得到引擎重负载窗口 17:09:46-17:10:32）：Chrome 忙时
 * System Events AX 枚举可 >2s，spawnSync 形态既连环超时（41s 压不回）又阻塞
 * server 的 MCP 请求处理。异步 + 4s kill 上限：慢则慢完成，不拖累请求路径。
 */
export function reassertChromeHiddenByPidAsync(
  pid: number | undefined,
  opts: ChromeReassertOptions = {},
): Promise<ChromeReassertResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return Promise.resolve({ ok: false, reason: "non_mac_noop" });
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, reason: "no_pid" });
  }
  if (opts.execFn) {
    const r = opts.execFn(["-e", reassertScript(pid)]);
    return Promise.resolve(parseReassertSignal(r.status, r.stdout));
  }
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", reassertScript(pid)],
      { encoding: "utf8", timeout: 4_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        // err 非空 = 非零退出/超时/kill——统一走信号解析（status 从 err.code 还原）
        const status = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code ?? 1) : 0;
        resolve(parseReassertSignal(typeof status === "number" ? status : 1, String(stdout ?? "")));
      },
    );
  });
}

export function reassertChromeHiddenByPid(
  pid: number | undefined,
  opts: ChromeReassertOptions = {},
): ChromeReassertResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return { ok: false, reason: "non_mac_noop" };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "no_pid" };
  }
  const execFn =
    opts.execFn ??
    ((args: string[]) => {
      try {
        const r = spawnSync("osascript", args, { encoding: "utf8", timeout: 2_000 });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      } catch {
        return { status: -1 };
      }
    });
  const r = execFn(["-e", reassertScript(pid)]);
  return parseReassertSignal(r.status, r.stdout);
}

/** visible 开关脚本体（sync/async 两变体共用单一真源；PID 定向是红线）。 */
function setVisibleScript(pid: number, visible: boolean): string {
  return (
    'tell application "System Events"\n' +
    "  repeat with p in (application processes whose name is \"Google Chrome\")\n" +
    `    if unix id of p is ${pid} then set visible of p to ${visible ? "true" : "false"}\n` +
    "  end repeat\n" +
    "end tell"
  );
}

/** osascript 退出态 → 结果（sync/async 共用解析；非零退含 TCC -1743 一切失败）。 */
function parseHideSignal(status: number | null | undefined): ChromeHideResult {
  if (status !== 0) {
    // 含 Accessibility TCC 缺失（System Events -1743）在内的一切非零退 → 降级不 fail
    return { ok: false, reason: `osascript_exit_${status ?? "null"}` };
  }
  return { ok: true };
}

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
  const script = setVisibleScript(pid, visible);
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
  return parseHideSignal(r.status);
}

/**
 * P31（v1.18.3 同类横扫 S3/S4）：setChromeVisibleByPid 的 execFile 异步变体——
 * **server 进程内**（idle-reaper autoHide tick / MCP chrome-launch 隐藏保险丝）专用，
 * 零事件循环阻塞。论据与 reassertChromeHiddenByPidAsync 同源（P27 真机实证）：
 * Chrome 忙时 System Events AX 枚举可 >2s，spawnSync 形态在 server 常驻 timer 的
 * tick 内 / MCP 请求路径上同步阻塞，会拖累并发的 MCP 请求处理。异步 + 4s kill
 * 上限：慢则慢完成，不阻塞事件循环。CLI 短命路径（chrome-hideshow / launch-chrome
 * 直跑）维持同步版（process.exit 前需拿到结果；阻塞无受害者——自身即唯一进程）。
 */
export function setChromeVisibleByPidAsync(
  pid: number | undefined,
  opts: ChromeHideOptions = {},
  visible = false,
): Promise<ChromeHideResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return Promise.resolve({ ok: false, reason: "non_mac_noop" });
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, reason: "no_pid" });
  }
  const script = setVisibleScript(pid, visible);
  if (opts.execFn) {
    const r = opts.execFn(["-e", script]);
    return Promise.resolve(parseHideSignal(r.status));
  }
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", script],
      { encoding: "utf8", timeout: 4_000, killSignal: "SIGKILL" },
      (err) => {
        // err 非空 = 非零退出/超时/kill——status 从 err.code 还原（数字码如实、
        // 字符串码如 ENOENT 归 1），与 reassert 异步变体同款还原形态
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code ?? 1) : 0;
        resolve(parseHideSignal(typeof code === "number" ? code : 1));
      },
    );
  });
}

/** P31：hide 异步出口（server 进程内 reaper autoHide / launch 保险丝默认原语）。 */
export function hideChromeByPidAsync(
  pid: number | undefined,
  opts: ChromeHideOptions = {},
): Promise<ChromeHideResult> {
  return setChromeVisibleByPidAsync(pid, opts, false);
}

/** P31：show 异步出口（与 hide 对称；CLI show 仍走同步版）。 */
export function showChromeByPidAsync(
  pid: number | undefined,
  opts: ChromeHideOptions = {},
): Promise<ChromeHideResult> {
  return setChromeVisibleByPidAsync(pid, opts, true);
}
