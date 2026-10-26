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
import { loadConfig, loadConfigFileEnv } from "../../src/config/config.js";
import {
  parseLaunchChromeArgs,
  mergeLaunchDefaults,
  parseExtraArgsEnvValue,
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

  // R1（2026-10-26 需求单，提案 v2）：locale / EXTRA_ARGS 的 config 层默认。
  // index.ts 装配路径同款组合：loadConfigFileEnv（file 层）→ mergedEnv 同式合并
  // → parseExtraArgsEnvValue（空白拆分）→ defaults → argv merge。
  it("28c. config.json LASSO_LAUNCH_LOCALE/EXTRA_ARGS → defaults 生效；argv --locale 覆盖；window-size 逗号参数保真", () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        LASSO_LAUNCH_LOCALE: "zh-CN",
        // 需求方参数集验收锚（审查 B-F1/C-1）：window-size 含逗号——空白拆分保真
        LASSO_LAUNCH_EXTRA_ARGS: "--window-size=1920,1080 --proxy-server=127.0.0.1:7897",
      }),
    );
    const envSource = { LASSO_CONFIG_PATH: configFile } as NodeJS.ProcessEnv;
    // mergedEnv 同式：{...loadConfigFileEnv(env), ...env}
    const merged = { ...loadConfigFileEnv(envSource), ...envSource };
    const extraArgsDefault = parseExtraArgsEnvValue(merged.LASSO_LAUNCH_EXTRA_ARGS);
    expect(extraArgsDefault).toEqual([
      "--window-size=1920,1080",
      "--proxy-server=127.0.0.1:7897",
    ]);

    // CLI 无 flag → 文件层默认透传（locale argv-wins；extraArgs 叠加面）
    const noFlag = mergeLaunchDefaults(parseLaunchChromeArgs([]), {
      locale: merged.LASSO_LAUNCH_LOCALE,
      extraArgs: extraArgsDefault,
    });
    expect(noFlag.locale).toBe("zh-CN");
    expect(noFlag.extraArgs).toEqual(extraArgsDefault);

    // argv --locale ja-JP → 覆盖文件层（单值字段 argv-wins）；extraArgs 不受影响
    const withFlag = mergeLaunchDefaults(
      parseLaunchChromeArgs(["--locale", "ja-JP"]),
      { locale: merged.LASSO_LAUNCH_LOCALE, extraArgs: extraArgsDefault },
    );
    expect(withFlag.locale).toBe("ja-JP");
    expect(withFlag.extraArgs).toEqual(extraArgsDefault);
  });
});
