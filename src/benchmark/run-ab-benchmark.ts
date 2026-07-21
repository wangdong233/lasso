#!/usr/bin/env node
/**
 * in-house A/B 实测 CLI（parse2 §3.7 / 验收 #1 硬指标）。
 *
 * 用法（开发态，走 ts 源码或编译后 dist 均可）：
 *   node --experimental-strip-types src/benchmark/run-ab-benchmark.ts \
 *     --queries scripts/ab-queries.json \
 *     --report reports/ab-<date>.json
 *
 *   或：node dist/benchmark/run-ab-benchmark.js --queries scripts/ab-queries.json
 *
 * 输出：
 *   reports/ab-<date>.json            结构化原始数据（per-query × provider × mode × round latency + outcome）
 *   reports/provider-matrix-<date>.md 人类可读打分表（**不写"最优"**，只列数字 + 引用 Brave 外部三项硬数据）
 *
 * 方法论（parse2 §4.4 / 10 §4.3 + 05 §0-3 否决）：
 *   - 三组：cold（首次）/ warm（同 query 第 2 次，cache 已暖）/ concurrent（5 query Promise.all）
 *   - 中文 N + 英文 N（来自 scripts/ab-queries.json；v0.2 验收只要求 ≥5+5）
 *   - 每组每 provider × 每 query 跑 `rounds` 遍取中位（默认 3，消单次抖动）
 *   - p50 / p95 latency + outcome 分布 + 配额消耗（QuotaLedger.totalRemaining）
 *   - **强制 in-house**：不引用 AIMultiple "最优"结论，只引 Brave 外部三项硬数据
 *     （669ms / 14.89 Agent Score / 2000/月，见 §4.3）。
 *
 * 简单性铁律（01）：
 *   - 本文件不引 MCP server / FallbackDecider，直接 stub 两个 channel.search 的合成本
 *     （parse2 §3.7 spec：benchmark 自己 mock 两 channel + 5 query × 3 rounds）
 *   - 不绕过 BraveChannel / ZhipuSearchChannel 的真实实现：通过 ENV 开关切换 stub vs real
 *     （LASSO_BENCH_REAL=1 时走真实 channel，需配置 BRAVE_API_KEYS + ZHIPU_API_KEY）
 *
 * 借鉴：parse2 §3.7；05 §0-3 否决；10 §4.3 Brave 三项硬数据。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { InteractResult, SearchResult } from "../types.js";

// ============================================================
// CLI 参数
// ============================================================
interface CliOpts {
  queriesPath: string;
  reportPath: string;
  rounds: number;
  concurrentBatch: number;
  /** true：走真实 channel（需 env keys 配齐）；false：用合成 stub（默认）。 */
  real: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    queriesPath: "scripts/ab-queries.json",
    reportPath: "",
    rounds: 3,
    concurrentBatch: 5,
    real: process.env.LASSO_BENCH_REAL === "1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--queries") opts.queriesPath = argv[++i] ?? opts.queriesPath;
    else if (a === "--report") opts.reportPath = argv[++i] ?? opts.reportPath;
    else if (a === "--rounds") opts.rounds = parseInt(argv[++i] ?? "3", 10);
    else if (a === "--concurrent") opts.concurrentBatch = parseInt(argv[++i] ?? "5", 10);
    else if (a === "--real") opts.real = true;
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  if (!opts.reportPath) {
    const date = new Date().toISOString().slice(0, 10);
    opts.reportPath = `reports/ab-${date}.json`;
  }
  return opts;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: run-ab-benchmark [options]",
      "  --queries <path>       固定 query 集 JSON（默认 scripts/ab-queries.json）",
      "  --report <path>        结构化 JSON 报告输出路径（默认 reports/ab-<date>.json）",
      "  --rounds <n>           每组每 query 跑几遍取中位（默认 3）",
      "  --concurrent <n>       并发组 batch size（默认 5）",
      "  --real                 走真实 channel（需 BRAVE_API_KEYS + ZHIPU_API_KEY env 配齐）",
      "                          默认 false：用合成 stub（无网络也能跑通，验收 #1 流程闭环）",
      "  -h, --help             帮助",
      "",
    ].join("\n"),
  );
}

// ============================================================
// 类型
// ============================================================
interface QuerySet {
  zh: string[];
  en: string[];
}

type ProviderName = "zhipu" | "brave";

interface LatencySample {
  query: string;
  lang: "zh" | "en";
  provider: ProviderName;
  mode: "cold" | "warm" | "concurrent";
  round: number;
  latency_ms: number;
  outcome: "worked" | "didnt" | "unknown";
}

interface BenchReport {
  timestamp: string;
  lasso_version: string;
  real_channels: boolean;
  rounds: number;
  queries: { zh: number; en: number };
  samples: LatencySample[];
  summary: Array<{
    provider: ProviderName;
    mode: "cold" | "warm" | "concurrent";
    p50_ms: number;
    p95_ms: number;
    success_rate: number;
    samples: number;
  }>;
  external_citations: {
    brave_aimultiple_p95_ms: 669;
    brave_aimultiple_agent_score: 14.89;
    brave_free_quota_per_month: 2000;
    note: string;
  };
}

// ============================================================
// 合成 channel stub（默认 mode）
// ============================================================
/**
 * 合成 channel：不触网，模拟 worked + 模拟 latency。
 * Brave 中位 ~ 669ms（AIMultiple 引用，仅作 stub 默认值），zhipu 模拟 350-800ms 区间。
 *
 * 重要：这是 stub 不是真实基准；生产决策必须 LASSO_BENCH_REAL=1 重跑。
 */
function makeStubChannel(
  provider: ProviderName,
): (q: string) => Promise<InteractResult<SearchResult>> {
  return (q: string) => {
    const baseLatency = provider === "brave" ? 600 + Math.random() * 200 : 350 + Math.random() * 400;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          outcome: "worked",
          data: {
            query: q,
            results: [
              {
                title: `[${provider}] stub result for "${q.slice(0, 40)}"`,
                url: `https://stub.${provider}.test/${encodeURIComponent(q).slice(0, 30)}`,
                snippet: "synthesized result for benchmark — not real search data",
              },
            ],
            count: 1,
            engine: provider,
            region: provider === "brave" ? "US" : "cn",
          },
          served_by: `search.${provider}`,
          fallback_used: false,
          retrieval_method: "stub",
        });
      }, baseLatency);
    });
  };
}

// ============================================================
// 真实 channel 装配（LASSO_BENCH_REAL=1）
// ============================================================
async function makeRealChannel(
  provider: ProviderName,
): Promise<(q: string) => Promise<InteractResult<SearchResult>>> {
  // 动态 import 避免无 env keys 时构造失败
  if (provider === "zhipu") {
    const { ZhipuSearchChannel } = await import("../channels/SearchChannel.js");
    const endpoint = process.env.ZHIPU_ENDPOINT ??
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
    const key = process.env.ZHIPU_API_KEY;
    if (!key) throw new Error("ZHIPU_API_KEY missing for --real mode");
    const ch = new ZhipuSearchChannel(endpoint, key);
    return (q: string) =>
      ch.search(q, { limit: 5, engine: "zhipu", region: "cn", no_cache: false });
  }
  // brave
  const { BraveChannel } = await import("../channels/BraveChannel.js");
  const { QuotaLedger } = await import("../config/quota-ledger.js");
  const keysCsv = process.env.BRAVE_API_KEYS ?? process.env.BRAVE_API_KEY ?? "";
  const keys = keysCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("BRAVE_API_KEYS missing for --real mode");
  const ledger = new QuotaLedger("brave", keys, 2000, "monthly");
  const ch = new BraveChannel(
    "https://api.search.brave.com/res/v1/web/search",
    ledger,
    { fetch: ((u: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(u, init)) as typeof fetch },
  );
  return (q: string) =>
    ch.search(q, { limit: 5, region: q.match(/[一-鿿぀-ヿ가-힯]/) ? "CN" : "US", no_cache: false });
}

// ============================================================
// 单 query 计时
// ============================================================
async function timeOne(
  q: string,
  exec: (q: string) => Promise<InteractResult<SearchResult>>,
): Promise<{ latency_ms: number; outcome: LatencySample["outcome"] }> {
  const t0 = Date.now();
  const r = await exec(q);
  return { latency_ms: Date.now() - t0, outcome: r.outcome };
}

// ============================================================
// 三组测试
// ============================================================
async function runColdWarm(
  queries: Array<{ q: string; lang: "zh" | "en" }>,
  providers: Record<ProviderName, (q: string) => Promise<InteractResult<SearchResult>>>,
  rounds: number,
): Promise<LatencySample[]> {
  const samples: LatencySample[] = [];
  for (const { q, lang } of queries) {
    for (const provider of ["zhipu", "brave"] as ProviderName[]) {
      const exec = providers[provider];
      for (let round = 0; round < rounds; round++) {
        // cold：每个 round 重置（v0.2 简化：cold = round 内第一次）
        const cold = await timeOne(q, exec);
        samples.push({ query: q, lang, provider, mode: "cold", round, ...cold });
        // warm：紧接着第二次（cache 暖 + DNS/TLS 复用）
        const warm = await timeOne(q, exec);
        samples.push({ query: q, lang, provider, mode: "warm", round, ...warm });
      }
    }
  }
  return samples;
}

async function runConcurrent(
  queries: Array<{ q: string; lang: "zh" | "en" }>,
  providers: Record<ProviderName, (q: string) => Promise<InteractResult<SearchResult>>>,
  rounds: number,
  batchSize: number,
): Promise<LatencySample[]> {
  const samples: LatencySample[] = [];
  const batch = queries.slice(0, Math.min(batchSize, queries.length));
  for (const provider of ["zhipu", "brave"] as ProviderName[]) {
    const exec = providers[provider];
    for (let round = 0; round < rounds; round++) {
      const t0 = Date.now();
      const results = await Promise.all(batch.map((q) => exec(q.q)));
      const elapsed = Date.now() - t0;
      // 记整体批次耗时为每条 query 的 latency（p95 模拟）
      const anyUnknown = results.some((r) => r.outcome !== "worked");
      for (const { q, lang } of batch) {
        samples.push({
          query: q,
          lang,
          provider,
          mode: "concurrent",
          round,
          latency_ms: Math.round(elapsed / batch.length),
          outcome: anyUnknown ? "unknown" : "worked",
        });
      }
    }
  }
  return samples;
}

// ============================================================
// 汇总
// ============================================================
function summarize(samples: LatencySample[]): BenchReport["summary"] {
  const out: BenchReport["summary"] = [];
  for (const provider of ["zhipu", "brave"] as ProviderName[]) {
    for (const mode of ["cold", "warm", "concurrent"] as const) {
      const subset = samples.filter((s) => s.provider === provider && s.mode === mode);
      if (subset.length === 0) continue;
      const lats = subset.map((s) => s.latency_ms).sort((a, b) => a - b);
      const worked = subset.filter((s) => s.outcome === "worked").length;
      out.push({
        provider,
        mode,
        p50_ms: lats[Math.floor(lats.length * 0.5)] ?? 0,
        p95_ms: lats[Math.floor(lats.length * 0.95)] ?? lats[lats.length - 1] ?? 0,
        success_rate: worked / subset.length,
        samples: subset.length,
      });
    }
  }
  return out;
}

// ============================================================
// provider-matrix markdown
// ============================================================
function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push("# Lasso A/B Provider Matrix（in-house 实测）");
  lines.push("");
  lines.push(`- 生成时间：${report.timestamp}`);
  lines.push(`- Lasso 版本：${report.lasso_version}`);
  lines.push(`- 模式：${report.real_channels ? "真实 channel（--real）" : "合成 stub（非真实基准）"}`);
  lines.push(`- 固定 query 集：${report.queries.zh} 中 + ${report.queries.en} 英`);
  lines.push(`- 每组每 query 跑 ${report.rounds} rounds 取中位`);
  lines.push("");
  lines.push("## p50 / p95 latency + success rate");
  lines.push("");
  lines.push("| provider | mode | p50_ms | p95_ms | success_rate | samples |");
  lines.push("|----------|------|--------|--------|--------------|---------|");
  for (const r of report.summary) {
    lines.push(
      `| ${r.provider} | ${r.mode} | ${r.p50_ms} | ${r.p95_ms} | ${(r.success_rate * 100).toFixed(1)}% | ${r.samples} |`,
    );
  }
  lines.push("");
  lines.push("## 外部硬数据引用（仅 Brave，**非「最优」归因**）");
  lines.push("");
  lines.push("- Brave AIMultiple p95（外部基准）：669 ms");
  lines.push("- Brave AIMultiple Agent Score：14.89");
  lines.push("- Brave 免费层配额：2000 query/月");
  lines.push("");
  lines.push("> 本表是 in-house 实测，不引用 AIMultiple 「全场最优」结论（05 §0-3 否决因果延伸）。");
  lines.push("> 生产决策请以 `LASSO_BENCH_REAL=1` 重跑本工具的真实模式结果为准。");
  lines.push("");
  return lines.join("\n");
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // 默认 version 从 package.json 读；开发态可能未编译，用 fallback
  let version = "0.2.0-dev";
  try {
    const pkgPath = path.resolve("package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    version = pkg.version ?? version;
  } catch {
    // ignore
  }

  const queriesRaw = JSON.parse(await fs.readFile(opts.queriesPath, "utf8")) as QuerySet;
  if (!Array.isArray(queriesRaw.zh) || !Array.isArray(queriesRaw.en)) {
    throw new Error("queries JSON 必须含 zh[] 和 en[]");
  }
  const queries: Array<{ q: string; lang: "zh" | "en" }> = [
    ...queriesRaw.zh.map((q) => ({ q, lang: "zh" as const })),
    ...queriesRaw.en.map((q) => ({ q, lang: "en" as const })),
  ];

  process.stderr.write(
    `[bench] mode=${opts.real ? "real" : "stub"} queries=${queries.length} rounds=${opts.rounds}\n`,
  );

  const zhipuExec = opts.real
    ? await makeRealChannel("zhipu")
    : makeStubChannel("zhipu");
  const braveExec = opts.real
    ? await makeRealChannel("brave")
    : makeStubChannel("brave");

  const providers = { zhipu: zhipuExec, brave: braveExec };

  const coldWarmSamples = await runColdWarm(queries, providers, opts.rounds);
  const concurrentSamples = await runConcurrent(
    queries,
    providers,
    opts.rounds,
    opts.concurrentBatch,
  );

  const samples = [...coldWarmSamples, ...concurrentSamples];
  const summary = summarize(samples);

  const report: BenchReport = {
    timestamp: new Date().toISOString(),
    lasso_version: version,
    real_channels: opts.real,
    rounds: opts.rounds,
    queries: { zh: queriesRaw.zh.length, en: queriesRaw.en.length },
    samples,
    summary,
    external_citations: {
      brave_aimultiple_p95_ms: 669,
      brave_aimultiple_agent_score: 14.89,
      brave_free_quota_per_month: 2000,
      note: "外部硬数据引用，非「最优」归因（parse2 §3.7 / 05 §0-3 否决）",
    },
  };

  // 写 JSON + markdown
  await fs.mkdir(path.dirname(opts.reportPath) || ".", { recursive: true });
  await fs.writeFile(opts.reportPath, JSON.stringify(report, null, 2));
  const mdPath = opts.reportPath.replace(/\.json$/, "").replace(/ab-/, "provider-matrix-") + ".md";
  await fs.writeFile(mdPath, renderMarkdown(report));

  process.stderr.write(`[bench] report → ${opts.reportPath}\n`);
  process.stderr.write(`[bench] matrix → ${mdPath}\n`);

  // stdout 简要摘要（便于 CI grep）
  for (const r of summary) {
    process.stdout.write(
      `${r.provider}\t${r.mode}\tp50=${r.p50_ms}ms\tp95=${r.p95_ms}ms\tsr=${(r.success_rate * 100).toFixed(1)}%\n`,
    );
  }
}

// ============================================================
// CLI entry guard（兼容 ts-node / node dist / bun）
// ============================================================
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (
    import.meta.url === new URL(`file://${process.argv[1]}`).href ||
    import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? "_$_")
  );

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[bench] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

// 导出供测试 / 编程调用（benchmark.spec.ts 用）
export {
  runColdWarm,
  runConcurrent,
  summarize,
  renderMarkdown,
  makeStubChannel,
  parseArgs,
  type CliOpts,
  type QuerySet,
  type LatencySample,
  type BenchReport,
};
