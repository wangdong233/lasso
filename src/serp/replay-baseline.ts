/**
 * replay-baseline（parse11 §3.2 v1.0 Phase C 录制回放回归 runner）
 *
 * 职责（单一）：读 fixtures/serp-baseline/<engine>/*.html + .json sidecar →
 * 用当前 src/serp/extract.ts 的 extractResultsFromSnapshot 抽结果 → 比对
 * expected_count → 输出 BaselineResult[]。
 *
 * **核心价值（parse11 §3.2）**：把 v0.7 SerpHealthMonitor 的「运行时命中率告警」
 * 升级为「CI 时历史 fixture 回归」—— selector 改版 / 抽取逻辑破坏时，
 * push 阶段 CI 就知道，不用等真实 query 流。
 *
 * 不做的事（守简单性 R-CI-02 + INV-62 红线）：
 *  - **不录 browse_logged_in 真 cookie 场景**（INV-62 + 08 §5.1 cookie=身份）；
 *    本 runner 只消费 search + browse_headless 兜底抽链路径的脱敏 fixture
 *  - 不重写 RecordingStore（v0.9 已实装；本 runner 复用 extractResultsFromSnapshot
 *    抽取逻辑，fixture 落盘是普通 fs 操作；运行时录制仍由 RecordingStore 管）
 *  - 不自动推 fixture 上游（parse11 §1.2 「不做：自动推送新 fixture 上游」）
 *  - 不触网（纯本地 fixture 回放；CI 不依赖外网）
 *
 * 与 RecordingStore 关系（parse11 §3.2 决策）：
 *  - v0.9 RecordingStore 是**运行时录制 + 全源熔断回放**（~/.cache/lasso/recordings/）
 *  - v1.0 replay-baseline 是 **CI 时历史基线回归**（fixtures/serp-baseline/，签入仓库）
 *  - 两者互补：CI 抓 selector 改版早信号（push 时就知道），运行时抓新 query 改版
 *    （CI 没见过的 pattern）
 *
 * INV-62 衍生：本文件 grep 不出现 logged_in / cookie / session / BROWSERBASE_API_KEY 字面量。
 *
 * macOS-only 现实红线（parse11 §1.3）：本 runner 纯 TS，三平台同构可证；
 * 不 spawn 浏览器 / 不读真 cookie，CI 跨平台跑无障碍。
 *
 * 借鉴：parse11 §3.2 + 08 §3.8 F3.8.14；v0.7 SerpHealthMonitor shape 比对范式。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { extractResultsFromSnapshot } from "./extract.js";

// ============================================================
// 类型
// ============================================================
/**
 * 单条 fixture 的回放结果。
 *
 *  - engine         ：baidu / google / bing
 *  - fixture_name   ：fixture 文件名（无扩展名；debug 用）
 *  - query          ：fixture 录制时的 query（从 sidecar 读）
 *  - expected_count ：录制时抽取的结果数（从 sidecar 读）
 *  - actual_count   ：当前 extractResultsFromSnapshot 抽的结果数
 *  - hit_rate       ：actual / expected（0.0-1.0；expected=0 时记 1.0 防 div-by-zero）
 *  - status         ：pass / warn / fail（按阈值分级）
 *  - first_diff_url：第一个 diff 的结果 URL（debug 用；actual 与 expected 完全一致时 undefined）
 */
export interface BaselineResult {
  engine: string;
  fixture_name: string;
  query: string;
  expected_count: number;
  actual_count: number;
  hit_rate: number;
  status: "pass" | "warn" | "fail";
  first_diff_url?: string;
}

/**
 * 整体跑批结果。
 */
export interface ReplayBaselineSummary {
  total: number;
  pass: number;
  warn: number;
  fail: number;
  results: BaselineResult[];
  /** fixture 目录（echo back；debug 用） */
  fixturesDir: string;
  /** sidecar missing 计数（fixture .html 存在但 .json sidecar 缺） */
  sidecar_missing: number;
}

/**
 * runReplayBaseline 入参。
 *
 *  - fixturesDir : fixture 根目录（默认 <cwd>/fixtures/serp-baseline）
 *  - strict      : true 时 fail > 0 → exit 1（CI gate）
 *  - extractFn   : 测试注入（生产路径走 extractResultsFromSnapshot）
 */
export interface ReplayBaselineOptions {
  fixturesDir?: string;
  strict?: boolean;
  extractFn?: typeof extractResultsFromSnapshot;
}

// ============================================================
// 命中率阈值（parse11 §3.2）
// ============================================================
/**
 * 命中率分级阈值（parse11 §3.2）：
 *  - >= 0.8 → pass（selector 健康）
 *  - >= 0.5 → warn（轻微改版；selector 是债不是 bug）
 *  - <  0.5 → fail（selector 改版严重；strict 模式 exit 1）
 */
export const HIT_RATE_THRESHOLD_PASS = 0.8;
export const HIT_RATE_THRESHOLD_WARN = 0.5;

// ============================================================
// 主入口
// ============================================================
/**
 * 扫 fixturesDir → 逐条回放 → 返 BaselineResult[]。
 *
 * 流程（parse11 §3.2）：
 *  1. fs.readdir(fixturesDir) → 取所有 <engine>/ 子目录
 *  2. 对每个 <engine>/：
 *     a. fs.readdir(<engine>/) → 取所有 *.html 文件
 *     b. 对每个 *.html：读同名 .json sidecar（不存在记 sidecar_missing，跳过）
 *     c. 读 .html 内容 → extractResultsFromSnapshot(html, query)
 *     d. actual_count vs expected_count → hit_rate → status
 *  3. summary 汇总 pass/warn/fail
 *
 * 容错（不抛错，tri-state 诚实）：
 *  - fixturesDir 不存在 → 返 { total: 0, ..., sidecar_missing: 0 }（caller 决定是否 fail）
 *  - 单条 fixture 读失败 → 记 status="fail" + actual_count=0 + continue
 *  - sidecar 缺 → sidecar_missing++ + continue（不当 fail；这是数据缺失不是代码错）
 *
 * @param opts 见 ReplayBaselineOptions
 * @returns ReplayBaselineSummary
 */
export async function runReplayBaseline(
  opts: ReplayBaselineOptions = {},
): Promise<ReplayBaselineSummary> {
  const fixturesDir =
    opts.fixturesDir ??
    path.join(process.cwd(), "fixtures", "serp-baseline");
  const extractFn = opts.extractFn ?? extractResultsFromSnapshot;
  const results: BaselineResult[] = [];
  let sidecarMissing = 0;

  // 1. 扫 engine 子目录
  let engineDirs: import("node:fs").Dirent[];
  try {
    engineDirs = await fs.readdir(fixturesDir, { withFileTypes: true });
  } catch {
    // fixturesDir 不存在 / 不可读 → 返空 summary（caller 决定是否 fail）
    return {
      total: 0,
      pass: 0,
      warn: 0,
      fail: 0,
      results,
      fixturesDir,
      sidecar_missing: 0,
    };
  }

  // 2. 逐 engine 处理
  for (const engineDir of engineDirs) {
    if (!engineDir.isDirectory()) continue;
    const engine = engineDir.name;
    const enginePath = path.join(fixturesDir, engine);

    let files: string[];
    try {
      files = await fs.readdir(enginePath);
    } catch {
      continue;
    }

    // 3. 逐 *.html 处理（按字母序保稳定输出）
    for (const f of files.sort()) {
      if (!f.endsWith(".html")) continue;
      const fixtureName = f.slice(0, -5); // 去掉 .html
      const htmlPath = path.join(enginePath, f);
      const sidecarPath = path.join(enginePath, `${fixtureName}.json`);

      // 3a. 读 sidecar
      let sidecar: {
        engine?: string;
        query?: string;
        expected_count?: number;
      } | null = null;
      try {
        const sidecarText = await fs.readFile(sidecarPath, "utf8");
        sidecar = JSON.parse(sidecarText);
      } catch {
        sidecarMissing++;
        continue;
      }

      const query = sidecar?.query ?? "";
      const expectedCount = sidecar?.expected_count ?? 0;

      // 3b. 读 HTML + 抽取
      let actualCount = 0;
      let firstDiffUrl: string | undefined;
      let readFailed = false;
      try {
        const html = await fs.readFile(htmlPath, "utf8");
        const extracted = extractFn(html, query);
        actualCount = extracted.count;
        // 取第一条 URL（diff debug 用；expected=0 时 first_diff_url 留 undefined）
        if (actualCount > 0 && expectedCount > 0) {
          const firstActual = extracted.results[0]?.url;
          if (firstActual) firstDiffUrl = firstActual;
        }
      } catch {
        readFailed = true;
      }

      // 3c. 计算 hit_rate + status
      const hitRate =
        expectedCount === 0
          ? actualCount === 0
            ? 1.0
            : 0.0
          : Math.min(actualCount / expectedCount, 1.0);

      let status: BaselineResult["status"];
      if (readFailed) {
        status = "fail";
      } else if (hitRate >= HIT_RATE_THRESHOLD_PASS) {
        status = "pass";
      } else if (hitRate >= HIT_RATE_THRESHOLD_WARN) {
        status = "warn";
      } else {
        status = "fail";
      }

      results.push({
        engine,
        fixture_name: fixtureName,
        query,
        expected_count: expectedCount,
        actual_count: actualCount,
        hit_rate: hitRate,
        status,
        ...(firstDiffUrl ? { first_diff_url: firstDiffUrl } : {}),
      });
    }
  }

  // 4. summary
  const summary: ReplayBaselineSummary = {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    warn: results.filter((r) => r.status === "warn").length,
    fail: results.filter((r) => r.status === "fail").length,
    results,
    fixturesDir,
    sidecar_missing: sidecarMissing,
  };
  return summary;
}

// ============================================================
// CLI 入口（`npm run replay-baseline` 或 `lasso replay-baseline`）
// ============================================================
/**
 * CLI 入口：调 runReplayBaseline + 打印 JSON + 按 strict exit。
 *
 * 用法（parse11 §3.2）：
 *   npm run replay-baseline                  # 默认 strict=false；fail 仅 console 标
 *   npm run replay-baseline -- --strict      # strict 模式；fail > 0 → exit 1（CI gate）
 *
 * 经 index.ts 子命令路由时（`lasso replay-baseline [--strict]`），
 * argv 已剥掉前 2 个元素（node + script + "replay-baseline"），caller 传 slice(3)。
 *
 * exit code：
 *  - 0 → 总 fixture 数 > 0 且（非 strict 或 strict 模式 fail=0）
 *  - 1 → strict 模式且 fail > 0；或 fixture 数 = 0（无基线，CI 红灯提醒补 fixture）
 */
export async function runReplayBaselineCli(
  argv: string[] = process.argv.slice(3),
): Promise<void> {
  const strict = argv.includes("--strict");
  const summary = await runReplayBaseline({ strict });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (summary.total === 0) {
    process.stderr.write(
      `[replay-baseline] no fixtures found in ${summary.fixturesDir}\n`,
    );
    process.exit(1);
  }
  if (strict && summary.fail > 0) {
    process.exit(1);
  }
  process.exit(0);
}
