/**
 * doc/governance/09-静默守则审计 G1（D-4）：chrome-hide/show 双向出口的回归防护。
 *
 * 背景（doc/governance/09 audit.md D-4）：P4（v1.17.3）「登录弹窗 → 登录后 chrome-hide
 * 转后台静默」是 browse_logged_in 登录流转的唯一**恢复静默出口**（守则 S3），
 * 但 show 方向（showChromeByPid / chrome-hideshow-cli）此前零测试覆盖——
 * 上游一次重构即可让其静默失效，B 类流转退化为永久非静默。
 *
 * 覆盖（全 mock 注入，零真机 / 零 osascript 真执行）：
 *  - showChromeByPid：脚本极性（set visible to true）、平台 no-op、无 pid no-op、
 *    TCC 缺失降级不抛（与 hide 方向 byte 对称）
 *  - chrome-hideshow-cli：归属验证红线（台账 + cmdline 验证 + pid_reused_skipped）
 *    与 --port 过滤的白盒锚点（CLI 短命路径 process.exit，按项目惯例
 *    p1-visible-chrome-lifecycle.spec.ts 同款源码锚定范式）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  hideChromeByPid,
  showChromeByPid,
} from "../../src/launcher/chrome-hide.js";

describe("chrome-hide/show —— PID 定向显隐双向（守则 S3 恢复出口）", () => {
  it("G1-1. show 方向：AppleScript 片段含目标 pid + unix id + set visible to true（极性与 hide 相反）", () => {
    const seen: string[] = [];
    const execFn = (args: string[]) => {
      seen.push(args.join(" "));
      return { status: 0 };
    };
    const r = showChromeByPid(54321, { platform: "darwin", execFn });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    // 永不按进程名裸 show：unix id 定向（chrome-hide.ts 红线双向适用）
    expect(seen[0]).toContain("unix id of p is 54321");
    expect(seen[0]).toContain("set visible of p to true");
  });

  it("G1-2. hide 方向极性对照：set visible to false（双出口共用实现、极性互反）", () => {
    const seen: string[] = [];
    const execFn = (args: string[]) => {
      seen.push(args.join(" "));
      return { status: 0 };
    };
    const r = hideChromeByPid(54321, { platform: "darwin", execFn });
    expect(r.ok).toBe(true);
    expect(seen[0]).toContain("set visible of p to false");
  });

  it("G1-3. show 方向：osascript 非零退（含 TCC -1743）→ { ok:false, reason } 不抛（恢复出口降级不 fail）", () => {
    const r = showChromeByPid(54321, {
      platform: "darwin",
      execFn: () => ({ status: 1743, stderr: "not authorized" }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("osascript_exit_1743");
  });

  it("G1-4. show 方向：非 darwin / pid 非法 → no-op（execFn 零调用，永不误碰）", () => {
    let calls = 0;
    const execFn = () => {
      calls++;
      return { status: 0 };
    };
    const rWin = showChromeByPid(54321, { platform: "win32", execFn });
    const rLinux = showChromeByPid(54321, { platform: "linux", execFn });
    const rNoPid = showChromeByPid(undefined, { platform: "darwin", execFn });
    const rBadPid = showChromeByPid(-1, { platform: "darwin", execFn });
    expect(rWin).toEqual({ ok: false, reason: "non_mac_noop" });
    expect(rLinux).toEqual({ ok: false, reason: "non_mac_noop" });
    expect(rNoPid).toEqual({ ok: false, reason: "no_pid" });
    expect(rBadPid).toEqual({ ok: false, reason: "no_pid" });
    expect(calls).toBe(0);
  });

  it("G1-5. 双向共用实现（setChromeVisibleByPid）：极性由 visible 布尔单点决定（白盒）", () => {
    const src = readFileSync("src/launcher/chrome-hide.ts", "utf8");
    // show=true / hide=false 经同一私有实现分发
    expect(src).toMatch(
      /export function showChromeByPid[\s\S]{0,200}setChromeVisibleByPid\(pid, opts, true\)/,
    );
    expect(src).toMatch(
      /export function hideChromeByPid[\s\S]{0,200}setChromeVisibleByPid\(pid, opts, false\)/,
    );
    // 脚本模板由 visible 三元插值（单点极性，无双脚本漂移面）
    expect(src).toMatch(
      /\$\{visible \? "true" : "false"\}/,
    );
  });
});

describe("chrome-hideshow-cli —— 恢复出口的红线锚点（白盒）", () => {
  it("G1-6. 归属验证在位：台账 + cmdline --user-data-dir 验证 + pid_reused_skipped 拒绝路径", () => {
    const src = readFileSync("src/launcher/chrome-hideshow-cli.ts", "utf8");
    // 只操作台账在案记录（readLedgerSync），绝不按进程名/全量 Chrome
    expect(src).toMatch(/readLedgerSync\(\)/);
    // 归属验证（与 chrome-stop 同源红线）
    expect(src).toMatch(/verifyOwnership\(rec\.pid, rec\.profileDir/);
    // 验证失败 → skip 且如实报因
    expect(src).toMatch(/pid_reused_skipped/);
  });

  it("G1-7. --port 过滤 + show/hide 双 action 出口（chrome_show / chrome_hide 结果标识）", () => {
    const src = readFileSync("src/launcher/chrome-hideshow-cli.ts", "utf8");
    expect(src).toMatch(/ledger\.filter\(\(r\) => r\.port === port\)/);
    expect(src).toMatch(/show \? "chrome_show" : "chrome_hide"/);
    expect(src).toMatch(/show\s*\?\s*showChromeByPid\(rec\.pid\)\s*:\s*hideChromeByPid\(rec\.pid\)/);
  });

  it("G1-8. CLI 路由接线：index.ts 子命令 chrome-hide / chrome-show 双出口（白盒）", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toMatch(
      /process\.argv\[2\] === "chrome-hide" \|\| process\.argv\[2\] === "chrome-show"/,
    );
    expect(src).toMatch(/runChromeHideShowCli\(process\.argv\[2\] === "chrome-show"\)/);
  });
});
