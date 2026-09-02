/**
 * render-flags.spec.ts（v1.19 渲染档设计决议 裁决二 —— 冻结快照 tripwire + 常量）
 *
 * 守护点：
 *  1. RENDER_DETERMINISTIC_FLAGS 与 test/fixtures/render-flags-snapshot.txt
 *     **逐字同序**比对（顺序敏感 tripwire——任何无意改动先红；有意变更流程 =
 *     重导出 + 更新 fixture + 消费方 golden 验证）
 *  2. fixture 形状：行 0 = 二进制路径；行尾 = --remote-debugging-port=0（per-instance
 *     尾标记）；不含 --user-data-dir= / 裸 about:blank（per-instance 项已剥）
 *  3. 消费方 8 条确定性旗标逐字在冻结集中
 *  4. 指纹对判定（命中 / 真身 Chrome 不命中 / 单旗标不命中）
 *  5. 端口 / idle / profile 前缀常量 + env 覆盖
 *  6. chrome-stop.ts 的 rmSync 前缀镜像与本真源一致（跨文件 tripwire）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RENDER_DETERMINISTIC_FLAGS,
  RENDER_CDP_PORT_DEFAULT,
  RENDER_PROFILE_PREFIX,
  RENDER_IDLE_DEFAULT_MS,
  renderCdpPort,
  renderCdpPortScope,
  type RenderCdpPortScope,
  renderIdleDefaultMs,
  renderFingerprintMatch,
  RENDER_FINGERPRINT_FLAG_A,
  RENDER_FINGERPRINT_FLAG_B,
} from "../../src/render/render-flags.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../../test/fixtures/render-flags-snapshot.txt", import.meta.url)),
  "utf8",
);

/** 消费方 DETERMINISTIC_FLAGS（media-gen-mcp browser-pool.ts @ da7ffd3 逐字同序）。 */
const CONSUMER_DETERMINISTIC_FLAGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--font-render-hinting=full",
  "--force-color-profile=srgb",
  "--run-all-compositor-stages-before-draw",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
] as const;

/** 真身（用户日常）Chrome 命令行样本——不得命中指纹。 */
const REAL_CHROME_CMDLINE =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check --user-data-dir=/Users/x/.cache/lasso/chrome-profile-default --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --mute-audio";

describe("render-flags —— 冻结快照 tripwire（裁决二）", () => {
  it("RENDER_DETERMINISTIC_FLAGS 与 fixture 逐字同序（顺序敏感）", () => {
    const lines = FIXTURE.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(10);
    // 行 0 = 二进制路径（信息性）
    expect(lines[0]).toContain("Chrome");
    // 行尾 = per-instance 尾标记（remote-debugging-port；值 0 = 导出时 puppeteer 临时值）
    expect(lines[lines.length - 1]).toBe("--remote-debugging-port=0");
    // 中段 = 冻结集（减去行 0 二进制与行尾 per-instance 项）
    const frozen = lines.slice(1, lines.length - 1);
    expect(frozen).toEqual([...RENDER_DETERMINISTIC_FLAGS]);
  });

  it("fixture 不含 per-instance 项（user-data-dir 已剥；起始 URL 已剥）", () => {
    expect(FIXTURE).not.toContain("--user-data-dir=");
    // 裸 about:blank 行（起始 URL）已剥
    expect(FIXTURE.split("\n")).not.toContain("about:blank");
  });

  it("消费方 8 条确定性旗标逐字在冻结集中（browser-pool.ts @ da7ffd3）", () => {
    for (const f of CONSUMER_DETERMINISTIC_FLAGS) {
      expect(RENDER_DETERMINISTIC_FLAGS).toContain(f);
    }
  });

  it("冻结集含 headless 新模式 + puppeteer 注入面代表项", () => {
    expect(RENDER_DETERMINISTIC_FLAGS).toContain("--headless=new");
    expect(RENDER_DETERMINISTIC_FLAGS).toContain("--mute-audio");
    expect(RENDER_DETERMINISTIC_FLAGS).toContain("--hide-scrollbars");
    expect(RENDER_DETERMINISTIC_FLAGS).toContain("--disable-dev-shm-usage");
    expect(RENDER_DETERMINISTIC_FLAGS).toContain("--enable-automation");
  });
});

describe("render-flags —— 指纹对判定（设计决议 3.9）", () => {
  it("渲染档命令行（指纹对齐）→ 命中", () => {
    const renderCmdline = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ...RENDER_DETERMINISTIC_FLAGS,
      "--user-data-dir=/Users/x/.cache/lasso/render-chrome-profile-123-abc",
      "--remote-debugging-port=9224",
      "about:blank",
    ].join(" ");
    expect(renderFingerprintMatch(renderCmdline)).toBe(true);
  });

  it("真身 Chrome 命令行 → 不命中（零误伤）", () => {
    expect(renderFingerprintMatch(REAL_CHROME_CMDLINE)).toBe(false);
  });

  it("单旗标命中（撞他家用法）→ 不命中（成对证据）", () => {
    expect(renderFingerprintMatch(`chrome ${RENDER_FINGERPRINT_FLAG_A}`)).toBe(false);
    expect(renderFingerprintMatch(`chrome ${RENDER_FINGERPRINT_FLAG_B}`)).toBe(false);
  });
});

describe("render-flags —— 常量与 env（设计决议 3.2/3.10/3.11）", () => {
  beforeEach(() => {
    delete process.env.LASSO_RENDER_PORT;
    delete process.env.LASSO_RENDER_IDLE_MS;
  });
  afterEach(() => {
    delete process.env.LASSO_RENDER_PORT;
    delete process.env.LASSO_RENDER_IDLE_MS;
  });

  it("端口默认 9224（R-INT-08：9222 lasso 日常档 / 9223 media-gen Flow / 9224 空闲）", () => {
    expect(RENDER_CDP_PORT_DEFAULT).toBe(9224);
    expect(renderCdpPort()).toBe(9224);
  });

  it("LASSO_RENDER_PORT 覆盖；非法值降级默认", () => {
    process.env.LASSO_RENDER_PORT = "19224";
    expect(renderCdpPort()).toBe(19224);
    process.env.LASSO_RENDER_PORT = "not-a-port";
    expect(renderCdpPort()).toBe(9224);
    process.env.LASSO_RENDER_PORT = "-1";
    expect(renderCdpPort()).toBe(9224);
  });

  it("idle 默认 600_000（渲染档无人值守默认必须能自动退场——与日常档 CLI 默认 0 刻意不同）", () => {
    expect(RENDER_IDLE_DEFAULT_MS).toBe(600_000);
    expect(renderIdleDefaultMs()).toBe(600_000);
  });

  it("LASSO_RENDER_IDLE_MS 覆盖；≤0 是合法 opt-out（不 clamp——禁抄日常档语义）", () => {
    process.env.LASSO_RENDER_IDLE_MS = "30000";
    expect(renderIdleDefaultMs()).toBe(30_000);
    process.env.LASSO_RENDER_IDLE_MS = "0";
    expect(renderIdleDefaultMs()).toBe(0);
    process.env.LASSO_RENDER_IDLE_MS = "-1";
    expect(renderIdleDefaultMs()).toBe(-1);
    process.env.LASSO_RENDER_IDLE_MS = "abc";
    expect(renderIdleDefaultMs()).toBe(600_000);
  });

  it("profile 前缀常量 + chrome-stop.ts rmSync 守卫镜像一致（跨文件 tripwire）", () => {
    expect(RENDER_PROFILE_PREFIX).toBe("render-chrome-profile-");
    const stopSrc = readFileSync(
      fileURLToPath(new URL("../../src/launcher/chrome-stop.ts", import.meta.url)),
      "utf8",
    );
    expect(stopSrc).toContain(`"${RENDER_PROFILE_PREFIX}"`);
  });
});

describe("renderCdpPortScope —— 提案 §6.1 三态 + 同谓词等价 tripwire（2026-09-02）", () => {
  beforeEach(() => {
    delete process.env.LASSO_RENDER_PORT;
  });
  afterEach(() => {
    delete process.env.LASSO_RENDER_PORT;
  });

  it("四态：未设/空串 → unset；显式合法 → {explicit,port}；显式非法 → {invalid,raw}", () => {
    delete process.env.LASSO_RENDER_PORT;
    expect(renderCdpPortScope()).toEqual({ scope: "unset" });
    process.env.LASSO_RENDER_PORT = "";
    expect(renderCdpPortScope()).toEqual({ scope: "unset" });
    process.env.LASSO_RENDER_PORT = "9234";
    expect(renderCdpPortScope()).toEqual({ scope: "explicit", port: 9234 });
    process.env.LASSO_RENDER_PORT = "not-a-port";
    expect(renderCdpPortScope()).toEqual({ scope: "invalid", raw: "not-a-port" });
  });

  // 🔴 提案 §6.1 修订轮同谓词硬约束：renderCdpPort 与 renderCdpPortScope 必须共享
  // 同一接受集（render-flags.ts 私有 parseRenderPortRaw 同源调用）。单一不变量钉死
  // 两函数永不分叉：对任意 env 值，renderCdpPort() === (scope 显式合法 ? scope.port
  // : 默认)。语料 = 提案 §6.1 真机 node 实证集：parseInt 语义边角（"+9224"/" 9224"/
  // "09224"/"9224.5"/"9224 " 均 → explicit:9224）+ 非法族（"0x2406" parseInt 停在 x
  // 得 0 / 越界 / 负 / 非数）+ 纯空白（unset）。裂脑机理：消费方 execFileAsync 全量
  // 继承 env，同一字符串同时到达 ensure（renderCdpPort）与 stop（scope）——谓词分叉
  // 即「ensure 在 9224 运行 / stop exit 1 拒收」。
  it("等价语料 tripwire：renderCdpPort() ≡ (scope 显式 ? scope.port : 默认)——两函数接受集永不分叉", () => {
    const corpus: Array<[string, RenderCdpPortScope]> = [
      ["+9224", { scope: "explicit", port: 9224 }],
      [" 9224", { scope: "explicit", port: 9224 }],
      ["09224", { scope: "explicit", port: 9224 }],
      ["9224.5", { scope: "explicit", port: 9224 }],
      ["9224 ", { scope: "explicit", port: 9224 }],
      ["0x2406", { scope: "invalid", raw: "0x2406" }],
      ["65536", { scope: "invalid", raw: "65536" }],
      ["-1", { scope: "invalid", raw: "-1" }],
      ["not-a-port", { scope: "invalid", raw: "not-a-port" }],
      ["\t", { scope: "unset" }],
    ];
    for (const [raw, expected] of corpus) {
      process.env.LASSO_RENDER_PORT = raw;
      const s = renderCdpPortScope();
      expect(s, `raw=${JSON.stringify(raw)}`).toEqual(expected);
      expect(renderCdpPort(), `raw=${JSON.stringify(raw)}`).toBe(
        s.scope === "explicit" ? s.port : RENDER_CDP_PORT_DEFAULT,
      );
    }
  });
});
