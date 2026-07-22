/**
 * doctor CLI × config 文件机制 端到端测（v1.3 Phase B）
 *
 * 守用户硬约束②：要新增配置时在配置文件配（不靠装时 env）。
 * 验收场景（README/KEY-GUIDE 承诺）：
 *  1. 用户跑 `lasso config init` 创建 ~/.lasso/config.json（用 LASSO_CONFIG_PATH 隔离）
 *  2. 用户在文件里填 ZHIPU_API_KEY
 *  3. 用户跑 `lasso doctor` → 报告应反映文件里的 key（zhipu_api_key: pass）
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
    // 触网 check 在 CI 不稳；doctor 默认 skipNetwork=false，但 zhipu_api_key check 不触网
    // （只判 key 是否非空字符串）。这里不设 skipNetwork —— 走真实默认路径。
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
  it("config 文件有 ZHIPU_API_KEY → doctor 报告 zhipu_api_key: pass（key 来自文件非 env）", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ ZHIPU_API_KEY: "from-config-file-key" }),
    );

    const { stdout, status } = runDoctorCliViaDist(configPath);
    expect(status).not.toBe(null);
    const report = JSON.parse(stdout);
    const zhipuCheck = report.checks.find(
      (c: { name: string }) => c.name === "zhipu_api_key",
    );
    expect(zhipuCheck).toBeDefined();
    expect(zhipuCheck.status).toBe("pass");
    expect(zhipuCheck.detail).toContain("已配置");
  });

  it("config 文件无 ZHIPU_API_KEY + env 也无 → doctor 报告 zhipu_api_key: fail（零配置搜索不可用）", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ ZHIPU_API_KEY: "" }));

    const { stdout } = runDoctorCliViaDist(configPath);
    const report = JSON.parse(stdout);
    const zhipuCheck = report.checks.find(
      (c: { name: string }) => c.name === "zhipu_api_key",
    );
    expect(zhipuCheck.status).toBe("fail");
  });

  it("env ZHIPU_API_KEY 覆盖 config 文件（向后兼容：-e KEY=VAL / shell env 优先）", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ ZHIPU_API_KEY: "from-file-should-be-overridden" }),
    );

    // env 同时传一个不同的 key —— loadConfig 合并顺序 file→env，env 应赢
    // （这里只验证 doctor 看到 pass，不区分来源；env 覆盖 file 的精确语义在 unit 测已锁）
    const { stdout } = runDoctorCliViaDist(configPath, {
      ZHIPU_API_KEY: "from-env-wins",
    });
    const report = JSON.parse(stdout);
    const zhipuCheck = report.checks.find(
      (c: { name: string }) => c.name === "zhipu_api_key",
    );
    expect(zhipuCheck.status).toBe("pass");
  });

  it("lasso_version 反映 1.3.0（INV-63 三处对齐：package.json + index.ts + doctor.ts）", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, "{}");
    const { stdout } = runDoctorCliViaDist(configPath);
    const report = JSON.parse(stdout);
    expect(report.lasso_version).toBe("1.3.0");
  });
});
