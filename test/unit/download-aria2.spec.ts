/**
 * download-aria2.spec.ts（doc/bugs/12 D14 机读进度——aria2 summary 解析 + argv 构建）
 *
 * fixture 来源：2026-09-20 本机 aria2 1.37.0 真实捕获（Range 服务器 + chunked
 * 服务器两形态，cat -v 验证无 ANSI 残留）；带 ETA/SEED 边界为 aria2 文档形态
 * 合成样本。守护面：无 ETA 段（本机快下载实测不含 ETA——必须可选）/未知大小
 * （0B 占位无百分比）/多行块取最后 summary/非 summary 行忽略/argv 模板逐字锚
 * /BT 冻结常量。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import {
  parseAria2Progress,
  parseAria2SummaryLine,
  buildAria2Args,
  planAria2Spawn,
  BT_DHT_BOOTSTRAP_ENTRIES,
  BT_TRACKERS,
  isAria2ZeroPeerSnapshot,
} from "../../src/download/engines/aria2.js";

const MiB = 1024 * 1024;

describe("parseAria2SummaryLine（真实捕获样本）", () => {
  it("已知大小+百分比+连接数（本机 Range 服务器实测行）", () => {
    const f = parseAria2SummaryLine("[#128c91 31MiB/38MiB(81%) CN:4 DL:31MiB]");
    expect(f).not.toBeNull();
    expect(f!.downloadedBytes).toBe(31 * MiB);
    expect(f!.totalBytes).toBe(38 * MiB);
    expect(f!.progress).toBeCloseTo(0.81, 5);
    expect(f!.connections).toBe(4);
    expect(f!.speedBps).toBe(31 * MiB);
    expect(f!.etaSec).toBeNull(); // 快下载无 ETA 段（实测确认可选）
    expect(f!.seeding).toBe(false);
  });

  it("未知大小 chunked（本机实测：总量 0B 占位、无百分比）", () => {
    const f = parseAria2SummaryLine("[#979bb8 1.1MiB/0B CN:1 DL:1.0MiB]");
    expect(f!.downloadedBytes).toBe(Math.round(1.1 * MiB));
    expect(f!.totalBytes).toBeNull();
    expect(f!.progress).toBeNull();
    expect(f!.speedBps).toBe(Math.round(1.0 * MiB));
  });

  it("带 ETA 的合成边界（aria2 文档形态 ETA:30s / 1m30s）", () => {
    expect(
      parseAria2SummaryLine("[#abc 45MiB/120MiB(37%) CN:8 DL:2.5MiB ETA:30s]")!.etaSec,
    ).toBe(30);
    expect(
      parseAria2SummaryLine("[#abc 45MiB/120MiB(37%) CN:8 DL:2.5MiB ETA:1m30s]")!.etaSec,
    ).toBe(90);
  });

  it("SEED 态（做种）标记", () => {
    const f = parseAria2SummaryLine("[#abc SEED 128MiB(98%) DL:0B]");
    expect(f!.seeding).toBe(true);
    expect(f!.progress).toBeCloseTo(0.98, 5);
  });

  it("BT 元数据期 0B/0B：全 null 不产 NaN", () => {
    const f = parseAria2SummaryLine("[#abc 0B/0B CN:0 DL:0B]");
    expect(f!.downloadedBytes).toBe(0);
    expect(f!.totalBytes).toBeNull();
    expect(f!.progress).toBeNull();
  });

  it("非 summary 行返 null（FILE:/页眉/错误行）", () => {
    expect(parseAria2SummaryLine("FILE: /tmp/x/big.bin")).toBeNull();
    expect(parseAria2SummaryLine(" *** Download Progress Summary as of Sun Sep 20 15:27:27 2026 *** ")).toBeNull();
    expect(parseAria2SummaryLine("===============================================================================")).toBeNull();
    expect(parseAria2SummaryLine("09/20 15:26:44 [ERROR] CUID#8 - Download aborted.")).toBeNull();
    expect(parseAria2SummaryLine("")).toBeNull();
  });

  it("零 peer 诊断观测：CN=0 且 DL=0B", () => {
    expect(isAria2ZeroPeerSnapshot(parseAria2SummaryLine("[#a 1MiB/0B CN:0 DL:0B]"))).toBe(true);
    expect(isAria2ZeroPeerSnapshot(parseAria2SummaryLine("[#a 1MiB/0B CN:3 DL:1.0MiB]"))).toBe(false);
    expect(isAria2ZeroPeerSnapshot(null)).toBe(false);
  });
});

describe("parseAria2Progress（全文 tail 语义）", () => {
  it("完整 summary 块（页眉/FILE:/分隔线混排）取最后一个 summary", () => {
    const block = [
      " *** Download Progress Summary as of Sun Sep 20 15:27:27 2026 *** ",
      "===============================================================================",
      "[#128c91 10MiB/38MiB(26%) CN:4 DL:20MiB]",
      "FILE: /tmp/x/big.bin",
      "-------------------------------------------------------------------------------",
      "",
      "[#128c91 31MiB/38MiB(81%) CN:4 DL:31MiB]",
    ].join("\n");
    const snap = parseAria2Progress(block);
    expect(snap.downloadedBytes).toBe(31 * MiB);
    expect(snap.progress).toBeCloseTo(0.81, 5);
    expect(snap.exitCode).toBeNull(); // 退出态=pid 轮询层职责
  });

  it("空文本/纯噪声 → 全 null 快照", () => {
    const snap = parseAria2Progress("");
    expect(snap).toEqual({
      progress: null,
      speedBps: null,
      etaSec: null,
      downloadedBytes: null,
      totalBytes: null,
      exitCode: null,
    });
  });
});

describe("buildAria2Args（决议模板逐字锚）", () => {
  const base = {
    taskId: "t1",
    source: "https://example.com/a.bin",
    kind: "http" as const,
    outDir: "/tmp/out",
    filename: "a.bin",
    maxConn: 8,
    proxy: null,
  };

  it("HTTP 形态含全部决议参数", () => {
    const args = buildAria2Args(base);
    const joined = args.join(" ");
    for (const anchor of [
      "-x 8",
      "-s 8",
      "-k 1M",
      "--file-allocation=none",
      "--summary-interval=5",
      "--download-result=hide",
      "--console-log-level=warn",
      "-c",
      "--auto-file-renaming=false",
      "--allow-overwrite=true",
    ]) {
      expect(joined).toContain(anchor);
    }
    // 无 proxy 时不得出现 --all-proxy
    expect(joined).not.toContain("--all-proxy");
    // BT 参数不进 HTTP 形态
    expect(joined).not.toContain("--enable-dht");
    expect(joined).not.toContain("--bt-tracker");
  });

  it("HTTP+proxy → --all-proxy 透传", () => {
    const args = buildAria2Args({ ...base, proxy: "http://127.0.0.1:7890" });
    const i = args.indexOf("--all-proxy");
    expect(args[i + 1]).toBe("http://127.0.0.1:7890");
  });

  it("maxConn 夹取 1-16", () => {
    expect(buildAria2Args({ ...base, maxConn: 99 }).join(" ")).toContain("-x 16");
    expect(buildAria2Args({ ...base, maxConn: 0 }).join(" ")).toContain("-x 1");
  });

  it("BT 形态：DHT 直写 + bundled tracker + seed-time=0", () => {
    const args = buildAria2Args({ ...base, kind: "torrent", source: "magnet:?xt=urn:btih:x" });
    const joined = args.join(" ");
    expect(joined).toContain("--enable-dht=true");
    expect(joined).toContain("--seed-time 0");
    const i = args.indexOf("--bt-tracker");
    const trackers = args[i + 1].split(",");
    expect(trackers.length).toBe(BT_TRACKERS.length);
    expect(trackers.length).toBeLessThanOrEqual(15); // 冻结精选 ≤15
    expect(trackers[0]).toBe("udp://tracker.opentrackr.org:1337/announce");
    // DHT bootstrap：每个 entry 都成对出现
    for (const entry of BT_DHT_BOOTSTRAP_ENTRIES) {
      const j = args.indexOf("--dht-entry-point");
      expect(args).toContain(entry);
      expect(j).toBeGreaterThan(-1);
    }
    // IP 直写解 DNS 污染（§二定谳锚）
    expect(BT_DHT_BOOTSTRAP_ENTRIES.every((e) => /^\d+\.\d+\.\d+\.\d+:6881$/.test(e))).toBe(true);
  });
});

describe("planAria2Spawn（staging 标记 + stdioFile）", () => {
  it("argv 含 staging/<taskId>（cancel 杀谓词 cmdline 锚）+ env 双保险", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lasso-dl-plan-"));
    try {
      const plan = planAria2Spawn(
        {
          taskId: "task-abc123",
          source: "https://example.com/a.bin",
          kind: "http",
          outDir: "/tmp/out",
          filename: "a.bin",
          maxConn: 4,
          proxy: null,
          env: { ...process.env, LASSO_DOWNLOADS_PATH: join(tmp, "downloads", "tasks") },
        },
        "/usr/local/bin/aria2c",
      );
      const dirIdx = plan.spec.args.indexOf("--dir");
      expect(plan.spec.args[dirIdx + 1]).toBe(plan.stagingDir);
      expect(plan.stagingDir).toContain(`staging${path.sep}task-abc123`);
      expect(plan.spec.env.LASSO_DOWNLOAD_TASK).toBe("task-abc123");
      expect(plan.spec.stdioFile).toMatch(/logs[/\\]task-abc123\.log$/);
      // source 在 argv 末位
      expect(plan.spec.args.at(-1)).toBe("https://example.com/a.bin");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
