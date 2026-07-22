/**
 * chrome-paths（parse11 §3.3 v1.0 Phase D 跨平台 launcher）
 *
 * 职责（单一，简单）：列举三平台 Chrome / Chromium 候选路径，
 * 供 launch-chrome.ts 顺序 existsSync 探测。
 *
 * 不做的事（守 R-CI-02 + INV-64）：
 *  - 不引新 npm dep（仅 node:fs / node:path / node:process；INV-64 grep 守）
 *  - 不下载 / 自动安装 Chrome（parse11 §1.2 「不做：自动安装 Chrome」；用户手动装）
 *  - 不缓存探测结果（每次 launch 都重新探测；用户可能装到不同路径）
 *  - 不 fork 第二套探测机制（与 doctor.ts #5 chrome_binary 复用思路；只是 doctor
 *    只报存在性，launcher 多一步 spawn）
 *
 * INV-21 衍生：本文件无平台 AX / UIA / AT-SPI 字面量（只 process.platform 字符串）。
 *
 * 候选路径来源（parse11 §3.3 + 实践）：
 *  - macOS ：/Applications/Google Chrome.app/Contents/MacOS/Google Chrome（默认装位）
 *  - Linux ：/usr/bin/google-chrome（Debian/Ubuntu）/ /usr/bin/google-chrome-stable /
 *            /usr/bin/chromium / /usr/bin/chromium-browser（社区包名变体）
 *  - Windows：Program Files\Google\Chrome\Application\chrome.exe（64-bit 默认）+
 *             Program Files (x86)\Google\Chrome\Application\chrome.exe（32-bit 兼容）+
 *             LOCALAPPDATA\Google\Chrome\Application\chrome.exe（用户级安装）
 *
 * macOS-only 现实红线（parse11 §1.3）：本机 macOS-only 可证；
 * Win/Linux 路径仅静态列出 + CI Linux runner 验 shape；真机手测留 parse11-acceptance.md
 * #W7（Windows）/ #L7（Linux）pending。
 *
 * 借鉴：parse11 §3.3 + puppeteer 的 Chrome 测试时路径表（不引 puppeteer，只用其归纳）。
 */
import process from "node:process";
import * as path from "node:path";

// ============================================================
// 类型
// ============================================================
/**
 * 候选路径条目（路径 + 来源标签 + 描述）。
 *
 *  - path    : 绝对路径（探测时直接 fs.access(p, X_OK)）
 *  - source  : "default" | "user-install" | "canary" | "chromium-fork"
 *              （帮助调试：用户问「为什么没找到 Chrome」时 doctor / launch-chrome 可报 source）
 *  - desc    : 人类可读描述（detail 字段用）
 */
export interface ChromePathCandidate {
  path: string;
  source:
    | "default"
    | "user-install"
    | "canary"
    | "chromium-fork";
  desc: string;
}

// ============================================================
// 三平台候选路径表
// ============================================================
/**
 * macOS Chrome 候选路径（按优先级降序）。
 *
 * 1. Google Chrome（默认装到 /Applications）
 * 2. Chromium（开源 fork；部分开发者装）
 * 3. Google Chrome Canary（开发者预览；少数装）
 */
export const MACOS_CHROME_CANDIDATES: readonly ChromePathCandidate[] = [
  {
    path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    source: "default",
    desc: "Google Chrome（默认装位 /Applications）",
  },
  {
    path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    source: "chromium-fork",
    desc: "Chromium（开源 fork）",
  },
  {
    path:
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    source: "canary",
    desc: "Google Chrome Canary（开发者预览）",
  },
] as const;

/**
 * Linux Chrome 候选路径（按优先级降序）。
 *
 * Debian/Ubuntu：/usr/bin/google-chrome（官方 .deb 装位）
 *               /usr/bin/google-chrome-stable（同上，stable 别名）
 * Fedora/RHEL ：同 /usr/bin（包名相同）
 * 社区 fork  ：/usr/bin/chromium（Debian chromium 包）/ /usr/bin/chromium-browser（旧 Ubuntu 包名）
 *
 * 不覆盖 snap / flatpack 装位（path 复杂 + 用户少；parse11 §1.3 手测 #L7 留 corner case）。
 */
export const LINUX_CHROME_CANDIDATES: readonly ChromePathCandidate[] = [
  {
    path: "/usr/bin/google-chrome",
    source: "default",
    desc: "google-chrome（Debian/Ubuntu/Fedora 默认包名）",
  },
  {
    path: "/usr/bin/google-chrome-stable",
    source: "default",
    desc: "google-chrome-stable（stable 别名；同上二进制）",
  },
  {
    path: "/usr/bin/chromium",
    source: "chromium-fork",
    desc: "chromium（Debian/Ubuntu chromium 包；开源 fork）",
  },
  {
    path: "/usr/bin/chromium-browser",
    source: "chromium-fork",
    desc: "chromium-browser（旧 Ubuntu 包名；保留兼容）",
  },
] as const;

/**
 * Windows Chrome 候选路径（按优先级降序）。
 *
 * 64-bit Windows：C:\Program Files\Google\Chrome\Application\chrome.exe（默认）
 * 32-bit Windows / WOW64：C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
 * 用户级安装：%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe（不在 Program Files）
 *
 * 不覆盖 winget 装到非默认路径（parse11 §1.3 手测 #W7 留 corner case）。
 */
export function windowsChromeCandidates(opts: {
  programFiles?: string;
  programFilesX86?: string;
  localAppData?: string;
} = {}): ChromePathCandidate[] {
  // process.env.PROGRAMFILES 在 Windows Node 进程里由系统注入（C:\Program Files）
  // process.env["PROGRAMFILES(X86)"] 同上（WOW64；32-bit 兼容路径）
  // process.env.LOCALAPPDATA 是用户级（C:\Users\<user>\AppData\Local）
  const pf =
    opts.programFiles ??
    process.env.PROGRAMFILES ??
    "C:\\Program Files";
  const pfX86 =
    opts.programFilesX86 ??
    process.env["PROGRAMFILES(X86)"] ??
    "C:\\Program Files (x86)";
  const la =
    opts.localAppData ??
    process.env.LOCALAPPDATA ??
    path.join(
      process.env.USERPROFILE ?? "C:\\Users\\Default",
      "AppData",
      "Local",
    );
  return [
    {
      path: path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      source: "default",
      desc: "Program Files\\Google\\Chrome\\Application\\chrome.exe（64-bit 默认）",
    },
    {
      path: path.join(
        pfX86,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      source: "default",
      desc: "Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe（32-bit / WOW64）",
    },
    {
      path: path.join(
        la,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      source: "user-install",
      desc: "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe（用户级安装）",
    },
  ];
}

// ============================================================
// 平台 → 候选路径表（dispatch）
// ============================================================
/**
 * 按平台返候选路径列表。
 *
 * @param opts 可注入 platform（测试 mock 用）；生产路径走 detectPlatform().platform
 * @returns ChromePathCandidate[]（已按优先级降序排好）
 *
 * INV-21 衍生：本函数只按平台返路径列表，不做存在性 / 可执行性检查（那在 launch-chrome.ts）。
 */
export function chromeCandidatesForPlatform(opts: {
  platform?: "mac" | "win" | "linux" | "unknown";
  programFiles?: string;
  programFilesX86?: string;
  localAppData?: string;
} = {}): ChromePathCandidate[] {
  const platform = opts.platform ?? detectPlatformSimple();
  switch (platform) {
    case "mac":
      return [...MACOS_CHROME_CANDIDATES];
    case "linux":
      return [...LINUX_CHROME_CANDIDATES];
    case "win":
      return windowsChromeCandidates({
        programFiles: opts.programFiles,
        programFilesX86: opts.programFilesX86,
        localAppData: opts.localAppData,
      });
    default:
      return [];
  }
}

/**
 * process.platform 简化探测（launcher 内部用；platform-detect.ts 是 desktop 用的版本）。
 *
 * 守 R-CI-02：launcher 与 desktop 都用同样的 process.platform → Platform 收敛；
 *            不复用 platform-detect.ts 是为了 launcher 模块零跨依赖（INV-64 守：
 *            launcher/*.ts 只 import node:* 内置）。
 */
function detectPlatformSimple(): "mac" | "win" | "linux" | "unknown" {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}
