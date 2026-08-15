/**
 * launch-config-layering 集成测（v1.10 parse18 §7.2，例 28）
 *
 * 守 LASSO_LAUNCH_MODE / LASSO_LAUNCH_IDLE_MS 三来源优先级
 * （config.json < env < argv——§8.3 跨边界同步对 2）：
 *  28. config.json 设 visible → CLI 无 flag 时 opts.launchMode=visible（文件层生效）；
 *      argv --mode hidden 覆盖文件层（argv 最高）。
 *
 * 测 mergeLaunchDefaults 纯函数（index.ts CLI 入口的真实组合路径：
 * loadConfig(config.json+env) → defaults → parseLaunchChromeArgs(argv) → merge），
 * 不 spawn Chrome、不 process.exit。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../../src/config/config.js";
import {
  parseLaunchChromeArgs,
  mergeLaunchDefaults,
} from "../../src/launcher/launch-chrome.js";

let dir: string;
let configFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lasso-launch-layer-"));
  configFile = path.join(dir, "config.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("launch-chrome config 层叠（argv > env > config.json > 内置默认）", () => {
  it("28. config.json 设 LASSO_LAUNCH_MODE=visible → CLI 无 flag 时 opts.launchMode=visible；argv --mode hidden 覆盖", () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        LASSO_LAUNCH_MODE: "visible",
        LASSO_LAUNCH_IDLE_MS: 120000,
      }),
    );
    // index.ts CLI 入口同款组合：loadConfig（file→env 合并）→ defaults
    const cfg = loadConfig({
      runId: "launch-chrome-cli-test",
      env: { LASSO_CONFIG_PATH: configFile },
    });
    const defaults = { launchMode: cfg.launchMode, idleMs: cfg.launchIdleMs };
    expect(defaults.launchMode).toBe("visible"); // 文件层生效
    expect(defaults.idleMs).toBe(120_000);

    // CLI 无 flag → 文件层默认透传
    const noFlag = mergeLaunchDefaults(parseLaunchChromeArgs([]), defaults);
    expect(noFlag.launchMode).toBe("visible");
    expect(noFlag.idleMs).toBe(120_000);

    // argv --mode hidden / --idle-ms 5000 → 覆盖文件层（argv 最高）
    const withFlag = mergeLaunchDefaults(
      parseLaunchChromeArgs(["--mode", "hidden", "--idle-ms", "5000"]),
      defaults,
    );
    expect(withFlag.launchMode).toBe("hidden");
    expect(withFlag.idleMs).toBe(5000);
  });

  it("28b. env 覆盖 config.json（向后兼容：-e KEY=VAL / shell env 优先）", () => {
    writeFileSync(configFile, JSON.stringify({ LASSO_LAUNCH_MODE: "visible" }));
    const cfg = loadConfig({
      runId: "launch-chrome-cli-test",
      env: {
        LASSO_CONFIG_PATH: configFile,
        LASSO_LAUNCH_MODE: "hidden",
        LASSO_LAUNCH_IDLE_MS: "300000",
      },
    });
    expect(cfg.launchMode).toBe("hidden"); // env 赢
    expect(cfg.launchIdleMs).toBe(300_000); // 5min 保留语义路径
  });
});
