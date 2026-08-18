/**
 * doctor CLI × config 文件机制 端到端测（v1.3 Phase B）
 *
 * 守用户硬约束②：要新增配置时在配置文件配（不靠装时 env）。
 * 验收场景（README/KEY-GUIDE 承诺）：
 *  1. 用户跑 `lasso config init` 创建 ~/.lasso/config.json（用 LASSO_CONFIG_PATH 隔离）
 *  2. 用户在文件里填 key（v1.17 A3 起 zhipu 已退役——用 brave/retired 键验证流向）
 *  3. 用户跑 `lasso doctor` → 报告应反映文件/env 里的 key 状态
 *
 * 实现说明：
 *  - 用 spawnSync 真 spawn `node dist/index.js doctor`（端到端验证 CLI 路径）
 *  - dist/ 必须存在；CI / Phase gate 跑 `npm run build && npm test` 保证新鲜
 *  - dist/ 不存在时 skip（dev 工作流不强制；守不阻塞其他测试）
 *  - 用 env -i 语义：只传必要 env（PATH/HOME/LASSO_CONFIG_PATH），确保 key 来自文件而非 shell 泄漏
 *
 * 与 test/unit/config-file.spec.ts 的分工：
 *  - unit 测 loadConfig / loadConfigFileEnv / writeConfigTemplate 纯函数（已覆盖合并语义）
 *  - 本 spec 验 CLI 装配链：index.ts runDoctorCli 是否真的调了 loadConfig（守回退到 process.env 直读）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs, existsSync, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "lasso-doctor-cli-"));
});

afterEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** Skip 整个 file 当 dist/index.js 不存在（dev 工作流未 build 时）。 */
function describeOrSkip(name: string, fn: () => void) {
  if (!existsSync(DIST_ENTRY)) {
    describe.skip(name, fn);
    return;
  }
  describe(name, fn);
}

/**
 * spawn `node dist/index.js doctor`，返回 stdout 解析后的 JSON 报告。
 * 用 env -i 语义：只传 PATH/HOME/LASSO_CONFIG_PATH，确保 key 来自文件。
 */
function runDoctorCliViaDist(
  configPath: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    LASSO_CONFIG_PATH: configPath,
    // 触网 check 在 CI 不稳；doctor 默认 skipNetwork=false，但 zhipu_keys_retired /
    // brave_keys 这类静态 check 不触网。这里不设 skipNetwork —— 走真实默认路径。
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [DIST_ENTRY, "doctor"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

describeOrSkip("doctor CLI × config 文件机制（v1.3 Phase B 端到端）", () => {
  it("v1.17 A3：config 文件残留 ZHIPU_API_KEY → doctor 报告 zhipu_keys_retired: warn（静态退役提示）", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ ZHIPU_API_KEY: "from-config-file-key" }),
    );

    const { stdout, status } = runDoctorCliViaDist(configPath);
    expect(status).not.toBe(null);
    const report = JSON.parse(stdout);
    const zhipuCheck = report.checks.find(
      (c: { name: string }) => c.name === "zhipu_keys_retired",
    );
    expect(zhipuCheck).toBeDefined();
    expect(zhipuCheck.status).toBe("warn");
    expect(zhipuCheck.detail).toContain("ZHIPU_API_KEY");
    expect(zhipuCheck.next_step).toBeTruthy();
    // warn 不阻塞 ready
    expect(report.blockers).not.toContain("zhipu_keys_retired");
  });

  it("config 文件无 ZHIPU_API_KEY → doctor 报告 zhipu_keys_retired: pass（常态无需配置）", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ ZHIPU_API_KEY: "" }));

    const { stdout } = runDoctorCliViaDist(configPath);
    const report = JSON.parse(stdout);
    const zhipuCheck = report.checks.find(
      (c: { name: string }) => c.name === "zhipu_keys_retired",
    );
    expect(zhipuCheck.status).toBe("pass");
  });

  it("env 键流入 doctor CLI（向后兼容：-e KEY=VAL / shell env 优先；经 BRAVE_API_KEYS 验证）", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({}));

    // v1.17 A3：zhipu 检查已退役，改用 brave_keys 验证 env → doctor CLI 流向
    // （env 覆盖 file 的精确语义在 unit 测已锁）
    const { stdout } = runDoctorCliViaDist(configPath, {
      BRAVE_API_KEYS: "brave-key-from-env",
    });
    const report = JSON.parse(stdout);
    const braveCheck = report.checks.find(
      (c: { name: string }) => c.name === "brave_keys",
    );
    expect(braveCheck).toBeDefined();
    expect(braveCheck.status).toBe("pass");
  });

  it("lasso_version 反映 1.17.0（INV-63 三处对齐：package.json + index.ts + doctor.ts）", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, "{}");
    const { stdout } = runDoctorCliViaDist(configPath);
    const report = JSON.parse(stdout);
    expect(report.lasso_version).toBe("1.17.0");
  });
});
