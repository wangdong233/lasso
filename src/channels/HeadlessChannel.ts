/**
 * HeadlessChannel（parse1 §3.6 + §4.2；v1.5 parse13 §3.4 P0 核心修复 stealth 接入）
 *
 * spawn `chrome-devtools-mcp@<LOCKED_CDP_MCP_VERSION> --headless --isolated`。
 * 干净、隔离的 headless Chromium —— 无登录态、无 cookie 持久化。
 *
 * 适合：公开页面 / JS 重的 SPA / SERP fallback / 截图。
 *
 * 构造时往 SubprocessManager 注册 "headless" 规格，之后 getMcpClient() 懒启动。
 *
 * v1.5（parse13 §3.4 P0 核心修复）：
 *  - 构造接 StealthEngine + profileName（默认 windows_chrome_120，UA 值已升 Chrome 130）
 *  - override beforeNavigate 调 StealthEngine.injectProfile —— 修复 v1.4「HeadlessChannel
 *    零 stealth override、browse_headless 零反检测注入」P0 业务缺口（parse13 §1.2 白盒）。
 *    仿 BrowserbaseChannel.ts:211-221 范式（beforeNavigate hook 由 BrowseChannel.wrapNavigate
 *    保障调用时机）。
 *
 * BUG-08 决议 C（doc/bugs/08，2026-09-15）：freshProfile 反爬逃生门——被服务端
 * 指纹拉黑后（静默假 0 形态）的「换张脸重来」唯一解：完整新一致身份（临时
 * profile 目录【归属锚编码进目录名】+ stealth 确定性轮换 + 完整栈 respawn）+
 * 四路清理（受控回收 post-kill / shutdown / 下次 freshProfile / 24h 陈年兜底）。
 * 身份生命期 = 直到 idle 回收 / 下次 freshProfile / server 退出（Crawlee Session
 * 模型；非每调用一换——会话内频繁换脸本身是异常流量信号）。
 *
 * 借鉴：08 §3.3；chrome-devtools-mcp 官方 headless 启动方式（实测）；
 *       BrowserbaseChannel beforeNavigate 范式（parse5 §3.3.1）。
 */
import { mkdir } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { StealthEngine } from "../browse/StealthEngine.js";
import {
  STEALTH_PROFILES,
  defaultHeadlessProfileForHost,
  nextHostApplicableProfile,
  type StealthProfileName,
} from "../browse/stealth-profiles.js";
import {
  buildFreshProfileDirName,
  headlessProfileBaseDir,
  rmFreshProfileDir,
  scanStaleFreshProfiles,
  type StaleProfileScanResult,
} from "./headless-fresh-profile.js";
import { logger } from "../util/logger.js";
import type { BrowseResult, InteractResult } from "../types.js";

/**
 * v1.12（round2 T2-1）：宿主平台对齐默认 profile 的选择函数在
 * browse/stealth-profiles.ts::defaultHeadlessProfileForHost（StealthProfileName
 * 定义处；review-r1 迁出本文件——doctor 不再 value-import channels）。
 */

/** freshProfile 结果（admin browser_recycle / index 装配消费）。 */
export interface FreshProfileResult {
  spec: string;
  pid: number | null;
  profileDir: string;
  stealthProfile: StealthProfileName;
}

export class HeadlessChannel extends BrowseChannel {
  readonly name = "browse_headless";

  private readonly stealth: StealthEngine;
  /** BUG-08 C：当前 stealth profile（freshProfile 轮换可变——单写者 freshProfile）。 */
  private profileName: StealthProfileName;
  /**
   * BUG-08 C：当前 fresh profile 目录（null = 默认 spec，无临时 profile——
   * 缺省行为与 v1.25.0 字节级不变）。post-kill 清理的即时路径守卫之一。
   */
  private freshProfileDir: string | null = null;
  /** BUG-08 C：陈年扫描每进程一次（首 spawn 前收敛上代崩溃残留）。 */
  private staleScanDone = false;
  /** BUG-08 C：构造注入的出口代理（freshProfile 重建 spec 复用）。 */
  private readonly proxyUrlValue: string | undefined;

  constructor(
    private readonly subproc: SubprocessManager,
    stealth?: StealthEngine,
    // v1.12（round2 T2-1）：缺省从硬编码 windows_chrome_120 改宿主对齐默认
    profileName: StealthProfileName = defaultHeadlessProfileForHost(),
    /**
     * v1.11（round1 T10）：出口代理（config.proxy；空 = 不代理）。
     * 经 1.7.0 `--proxy-server=` 传给 Chromium。**仅 headless 生效**——
     * LoggedInChannel 永不读 LASSO_PROXY（用户真实 Chrome 出口原样，铁律）。
     */
    proxyUrl?: string,
    /**
     * BUG-08 C：fresh profile 基目录（缺省 ~/.cache/lasso；测试隔离注入——
     * render-launcher profileBaseDir opts 同款先例）。
     */
    private readonly freshProfileBase: string = headlessProfileBaseDir(),
  ) {
    super();
    // stealth 可选（向后兼容：未传则内部建一个 default StealthEngine；v1.5 index.ts 装配段
    // 显式传 stealth 实例供测试注入 mock）
    this.stealth = stealth ?? new StealthEngine();
    this.profileName = profileName;
    // BUG-08 C：freshProfile 重建 spec 时复用同一出口代理（构造注入值单一真源）
    this.proxyUrlValue = proxyUrl;
    // v1.5（parse13 §3.3）：加 Chromium flag —— --disable-blink-features=AutomationControlled
    // 移除 navigator.webdriver=true 痕迹（与 JS evasion 路 1 navigator.webdriver→undefined 双保险）。
    //
    // v1.11（round1 T1）：chrome-devtools-mcp 0.3.0 → 1.7.0。
    //  - 1.7.0 有 --chromeArg 透传机制 → --disable-blink-features=AutomationControlled
    //    经 `--chromeArg=<flag>` 真正到达 Chromium（0.3.0 unknown-flag 哑弹时代结束；
    //    parse13 §8.4 L3 未验证项就此关闭）。
    //  - 1.7.0 默认采集使用统计（README L45）→ --no-usage-statistics 必加（隐私不倒退）。
    //  - v1.11（round1 T2）：launch 级 UA/viewport —— `--chromeArg=--user-agent=<profile UA>`
    //    消除网络层 HeadlessChrome UA 头（JS defineProperty 改不了 HTTP 头；UA 头↔navigator
    //    不一致即标记）。profile 构造期已选定（上方 profileName），无生命周期冲突。
    //    JS 侧 16 路 evasion 保留为双保险。
    // BUG-08 C：spec 组装抽出 registerSpecWithIdentity（freshProfile 复用同序 args——
    // 缺省路径【无 user-data-dir 注入】与 v1.25.0 字节级不变）。
    this.registerSpecWithIdentity(this.profileName, undefined, proxyUrl);
  }

  /**
   * 注册 "headless" spec（构造缺省 + freshProfile 重建共用；args 序字节级保持）。
   * profileDir 传值 = fresh identity（--user-data-dir 注入 + stealth 参数整体切换）。
   */
  private registerSpecWithIdentity(
    profileName: StealthProfileName,
    profileDir: string | undefined,
    proxyUrl?: string,
  ): void {
    const profile = STEALTH_PROFILES[profileName];
    this.subproc.registerSpec("headless", {
      command: "npx",
      args: [
        // PERF-1（2026-09-02 性能轮）：--prefer-offline 前插——npx 每次冷启动对
        // registry 做 packument 新鲜度校验（条件请求），代理拥塞时 3-17s；prefer-offline
        // 有缓存即跳过网络（首装一次付税后缓存自持）。锚定测试 cdp-mcp-170-migration
        // spec「含 --prefer-offline」。npx/npm exec 同体，flag 直通。
        "--prefer-offline",
        "-y",
        `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
        "--headless",
        "--isolated",
        "--no-usage-statistics",
        "--chromeArg=--disable-blink-features=AutomationControlled",
        `--chromeArg=--user-agent=${profile.userAgent}`,
        // T3-1（round3 v1.13）：HTTP Accept-Language 头与 JS 层对齐。--user-agent
        // 改不了 Accept-Language 头（宿主真值 zh-CN 泄漏 ↔ JS 层 profile language
        // = 同请求内自矛盾的自然不可能形状）；--accept-lang 是 Chromium 标准
        // switch，值取 profile.acceptLanguage（与 navigator.languages 同源）。
        // E1' run B/C 实测：头变 "en-US,en;q=0.9,..." ≈ 真实双语用户形态。
        `--chromeArg=--accept-lang=${profile.acceptLanguage}`,
        `--viewport=${profile.viewport.width}x${profile.viewport.height}`,
        // v1.11（round1 T10）：出口代理（LASSO_PROXY 用户显式配置；空不加 flag）
        ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
        // BUG-08 决议 C：fresh identity 的 profile 目录注入（v1.11 chromeArg 通道，
        // UA/Accept-Language 同通道先例）——缺省路径不含此 arg（字节级不变）。
        ...(profileDir ? [`--chromeArg=--user-data-dir=${profileDir}`] : []),
      ],
      mcpClientName: "lasso-browse-headless",
    });
  }

  protected async getMcpClient(): Promise<McpClient> {
    // BUG-08 决议 C 清理路径④：陈年兜底扫描每进程一次，搭首次 spawn 点（一次
    // spawn 顺带收敛上代 SIGKILL 崩溃残留——此后本进程自有目录由 owner 活闸保护）
    if (!this.staleScanDone) {
      this.staleScanDone = true;
      try {
        const r = this.scanStaleProfiles();
        if (r.removed.length > 0) {
          logger.info({
            evt: "headless_stale_profile_swept",
            removed: r.removed.length,
            kept: r.kept.length,
          });
        }
      } catch (e) {
        logger.warn({ evt: "headless_stale_profile_sweep_failed", error: String(e) });
      }
    }
    return this.subproc.ensureRunning("headless");
  }

  // ============================================================
  // BUG-08 决议 C：freshProfile 反爬逃生门
  // ============================================================
  /**
   * BUG-08 决议 C：browse() 入口的 freshProfile 钩子（HeadlessChannel = 唯一
   * 支持通道）。执行完整换脸（freshProfile()），返回 null 放行本次调用。
   */
  protected override async applyFreshProfile(): Promise<InteractResult<BrowseResult> | null> {
    await this.freshProfile();
    return null;
  }

  /**
   * 换脸重启：完整新一致身份（身份隔离铁则的直译——杜绝「旧指纹配新 profile」
   * 的部分变异检测信号）：
   *  1. 新临时 profile 目录（归属锚 `-p<ownerPid>` 编码进目录名——崩溃原子）；
   *  2. stealth profile 宿主适用集确定性轮换（禁随机；单平台退化诚实声明，
   *     stealth-profiles.ts::nextHostApplicableProfile）；
   *  3. 完整栈 respawn：forgetSpec（树杀 → post-kill hook rmSync 旧 fresh
   *     profile——先杀后删顺序铁则）+ registerSpec（新 profile + 新 stealth）+
   *     ensureRunning；
   *  4. 会话守卫自动正确：新 McpClient 实例 → navSeenClients（WeakSet）自然
   *     失效 → FRESH_PAGE_NAV 门重新武装。
   *
   * 身份生命期：服务后续所有调用，直到 idle 回收 / 下次 freshProfile / server
   * 退出（browse_logged_in 永不 freshProfile——用户真实 Chrome 红线）。
   */
  async freshProfile(): Promise<FreshProfileResult> {
    const nextName = nextHostApplicableProfile(this.profileName);
    const dir = path.join(
      this.freshProfileBase,
      buildFreshProfileDirName(process.pid, Date.now(), randomBytes(3).toString("hex")),
    );
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // best-effort：Chromium 会自建（render-launcher 同款）
    }
    // 旧栈退役：forgetSpec = _kill（树杀）→ post-kill hook（index.ts 接线
    // afterHeadlessStackKilled：rmSync 旧 fresh profile【先杀后删】+ 重注册默认
    // spec 占位）——随后本方法立即覆盖注册新身份 spec
    await this.subproc.forgetSpec("headless");
    this.registerSpecWithIdentity(nextName, dir, this.proxyUrl);
    this.profileName = nextName;
    this.freshProfileDir = dir;
    const c = await this.subproc.ensureRunning("headless");
    logger.info({
      evt: "headless_fresh_profile",
      profile_dir: dir,
      stealth_profile: nextName,
      pid: c.pid,
    });
    return { spec: "headless", pid: c.pid, profileDir: dir, stealthProfile: nextName };
  }

  /** 构造注入的出口代理（freshProfile 重建 spec 复用；只读透出）。 */
  private get proxyUrl(): string | undefined {
    return this.proxyUrlValue;
  }  /**
   * BUG-08 决议 C 清理路径①（受控回收点）：headless 栈树杀完成后的 fresh
   * profile 清理（SubprocessManager post-kill hook 接线，index.ts 装配）。
   *
   * 顺序保证：本方法只会在 `_kill` 完成后被调（_retire）——「先杀后删」铁则
   * 的机械化；pre-kill 窗口零 rmSync（INV-96④ tripwire）。清理后退回默认
   * spec（身份生命期终结——idle 回收后的下一次懒启动 = 与新 server 同形的
   * 默认身份）；freshProfile 流程随后会覆盖注册新身份 spec，不受影响。
   */
  async afterHeadlessStackKilled(): Promise<void> {
    const dir = this.freshProfileDir;
    this.freshProfileDir = null;
    // 身份生命期终结：重注册默认 spec（无 user-data-dir；stealth 维持当前名）
    this.registerSpecWithIdentity(this.profileName, undefined, this.proxyUrl);
    if (dir === null) return;
    try {
      rmFreshProfileDir(dir);
    } catch (e) {
      // best-effort 重试一次后 warn 放行，交陈年兜底
      try {
        rmFreshProfileDir(dir);
      } catch (e2) {
        logger.warn({
          evt: "headless_fresh_profile_remove_failed",
          dir,
          error: String(e2 ?? e),
        });
      }
    }
  }

  /**
   * BUG-08 决议 C 清理路径②（server exit 同步兜底）：killAllSync 完成后的
   * 同步 rmSync（exit 钩子零 await——异步 afterHeadlessStackKilled 不可达）。
   * 顺序本就先杀后删（调用方保证），保持。
   */
  cleanupFreshProfilesSync(): void {
    const dir = this.freshProfileDir;
    this.freshProfileDir = null;
    if (dir === null) return;
    try {
      rmFreshProfileDir(dir);
    } catch (e) {
      // 同步路径 best-effort：交陈年兜底
      logger.warn({ evt: "headless_fresh_profile_exit_remove_failed", dir, error: String(e) });
    }
  }

  /**
   * BUG-08 决议 C 清理路径④（崩溃孤儿陈年兜底）：扫 `headless-profile-*`
   * 目录，双闸（ownerPid 死 + age>24h）全过才删（headless-fresh-profile.ts
   * 单一真源；禁 glob 全删）。生产依赖真实 ps/stat；导出结果供观测。
   */
  scanStaleProfiles(): StaleProfileScanResult {
    return scanStaleFreshProfiles(this.freshProfileBase, {
      isPidAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      readDir: (base) => {
        try {
          return readdirSync(base, { withFileTypes: true }).map((e) => ({
            name: e.name,
            isDirectory: e.isDirectory(),
          }));
        } catch {
          return [];
        }
      },
      statAgeMs: (dir) => {
        try {
          return statSync(dir).mtimeMs;
        } catch {
          return null;
        }
      },
      remove: (dir) => rmFreshProfileDir(dir),
      now: () => Date.now(),
    });
  }

  /**
   * v1.9（parse17 §2.2 (d) 机制一）：action/step dispatch 后刷新 lastUsedAt，
   * 防 idle watchdog（默认 5min）误杀 in-flight 长 browse。默认 no-op 见基类。
   */
  protected override touchKeepalive(): void {
    this.subproc.touch("headless");
  }

  /**
   * override beforeNavigate hook（parse13 §3.4 P0 核心修复）：navigate 前注入 stealth。
   * 调用时机由 BrowseChannel.wrapNavigate 保障（actionDispatch Map navigate 入口已包一层）。
   *
   * v1.4 现状（parse13 §1.2 gap 1）：HeadlessChannel 不 override beforeNavigate →
   *   browse_headless 零 stealth 注入 → CC 访真实站被基础 bot 检测挡（「全交互抓手」名不副实）。
   *
   * 失败容忍：stealth.injectProfile 失败时仅记 log（不阻断 browse）；caller 经
   * StealthEngine.detectCloudflareChallenge 探知页面状态后再决定是否 escalateManualSwitch。
   * （仿 BrowserbaseChannel.ts:211-221 同范式，parse5 §3.3.1 铁律 4 best-effort 语义）
   */
  // W1-DEF-1c（v1.8）：从 beforeNavigate 迁到 afterNavigate——导航前注入会随
  // 文档重置全部丢失（wave2 smoke 实证 navigator.webdriver 仍 true），改为
  // navigate 完成后注入当前文档（stealth 语义 = 覆盖本次导航目标页）。
  protected override async afterNavigate(client: McpClient): Promise<void> {
    try {
      await this.stealth.injectProfile(client, this.profileName);
    } catch (e) {
      logger.warn({
        evt: "headless_stealth_inject_failed",
        profile: this.profileName,
        error: String(e),
      });
    }
  }
}
