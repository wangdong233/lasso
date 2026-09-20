/**
 * download-ytdlp.spec.ts（doc/bugs/12 D14/D15——yt-dlp 机读进度/退出码映射/
 * json3→srt 滚动去重/argv 模板）
 *
 * progress fixture=progress-template 真实输出形态（`|` 分隔 6 字段；
 * Unknown %/NA 边界）；json3 fixture 构造滚动重复尾部样本（luceo §2.3
 * 陷阱的剥除面）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseYtDlpProgress,
  interpretYtDlpExit,
  json3ToSrt,
  stripRollingOverlap,
  finalizeSubtitles,
  buildYtDlpArgs,
  YTDLP_PROGRESS_TEMPLATE,
  resolveYtDlpPath,
} from "../../src/download/engines/ytdlp.js";

const MiB = 1024 * 1024;

describe("parseYtDlpProgress", () => {
  it("满字段行（真实模板形态）", () => {
    const log = [
      "download:dQw4w9WgXcQ|  5.0%|  18253611|   365211840|    1.20MiB/s|    05:03",
      "download:dQw4w9WgXcQ| 50.0%| 182605920|   365211840|    2.50MiB/s|    01:02",
    ].join("\n");
    const snap = parseYtDlpProgress(log);
    expect(snap.downloadedBytes).toBe(182605920);
    expect(snap.totalBytes).toBe(365211840);
    expect(snap.progress).toBeCloseTo(0.5, 5);
    expect(snap.speedBps).toBe(Math.round(2.5 * MiB));
    expect(snap.etaSec).toBe(62);
    expect(snap.exitCode).toBeNull();
  });

  it("未知百分比 `Unknown %` + NA 总量 → null 字段（百分比空边界）", () => {
    const snap = parseYtDlpProgress(
      "download:abc| Unknown %|  1234567| NA|    1.00MiB/s| Unknown",
    );
    expect(snap.progress).toBeNull();
    expect(snap.totalBytes).toBeNull();
    expect(snap.downloadedBytes).toBe(1234567);
    expect(snap.speedBps).toBe(MiB);
    expect(snap.etaSec).toBeNull();
  });

  it("时钟式 ETA 三形态（mm:ss / hh:mm:ss）", () => {
    expect(parseYtDlpProgress("download:x|  1.0%| 1| 100| 1B/s| 00:30").etaSec).toBe(30);
    expect(parseYtDlpProgress("download:x|  1.0%| 1| 100| 1B/s| 01:00:30").etaSec).toBe(3630);
  });

  it("日志噪声行（yt-dlp 前后文）不干扰——只锚 download: 行；空文本全 null", () => {
    const snap = parseYtDlpProgress(
      "[youtube] dQw4w9WgXcQ: Downloading webpage\n[youtube] Downloading 1 format(s)\ndownload:x| 99.0%| 99| 100| 1B/s| 00:01\n[download] Destination: a.mp4\n",
    );
    expect(snap.progress).toBeCloseTo(0.99, 5);
    const empty = parseYtDlpProgress("[youtube] nothing here\n");
    expect(empty.progress).toBeNull();
    expect(empty.downloadedBytes).toBeNull();
  });
});

describe("interpretYtDlpExit（退出码定谳映射）", () => {
  it("0=completed；2=参数错误；101=cancelled；null=信号杀死", () => {
    expect(interpretYtDlpExit(0).state).toBe("completed");
    expect(interpretYtDlpExit(2).state).toBe("failed");
    expect(interpretYtDlpExit(2).diagnosis).toMatch(/参数错误/);
    expect(interpretYtDlpExit(101).state).toBe("cancelled");
    expect(interpretYtDlpExit(null).state).toBe("failed");
    expect(interpretYtDlpExit(null).diagnosis).toMatch(/信号/);
  });

  it("exit 1+extractor 失效特征词 → 引擎过期诊断（重引导提示）", () => {
    const v = interpretYtDlpExit(1, "ERROR: [youtube] abc: Unable to extract player response");
    expect(v.state).toBe("failed");
    expect(v.diagnosis).toMatch(/extractor 失效/);
    expect(interpretYtDlpExit(1, "some other error").diagnosis).toBeNull();
  });

  it("≥1000 → failed", () => {
    expect(interpretYtDlpExit(1000).state).toBe("failed");
  });
});

describe("json3ToSrt（D15 滚动去重 + 句级聚合）", () => {
  it("滚动重复尾部剥除：下一行重复上一行尾巴 → 去重不膨胀", () => {
    const doc = {
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "hello world" }] },
        { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: "world this is fine" }] },
      ],
    };
    const srt = json3ToSrt(doc);
    // 事件 2 的词前缀 "world" 与事件 1 尾词重合 → 剥除
    expect(srt).toContain("hello world this is fine");
    // 去重证据：两个词各只出现一次（无滚动膨胀）
    expect(srt.match(/hello/g)?.length).toBe(1);
    expect(srt.match(/world/g)?.length).toBe(1);
  });

  it("无重复 → 原样句级聚合（terminator 断句）", () => {
    const doc = {
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "first sentence." }] },
        { tStartMs: 1200, dDurationMs: 1000, segs: [{ utf8: "second one" }] },
        { tStartMs: 2400, dDurationMs: 1000, segs: [{ utf8: "here" }] },
      ],
    };
    const srt = json3ToSrt(doc);
    // 事件 1 以 . 结尾断句；事件 2/3 无 terminator 且 <6s → 聚合成一句
    expect(srt).toContain("first sentence.");
    expect(srt).toContain("second one here");
    // 序号 + 时间戳形态
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:01,000\nfirst sentence\.\n/m);
  });

  it("多词重叠取最长匹配；换行平化；空事件跳过", () => {
    expect(stripRollingOverlap("a b c d", "c d e")).toBe("e");
    expect(stripRollingOverlap("a b", "x y")).toBe("x y"); // 无重合原样
    expect(stripRollingOverlap("", "x")).toBe("x");
    const doc = {
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "line\nbreak" }, { utf8: " kept" }] },
        { tStartMs: 5000, dDurationMs: 0, segs: [] }, // 无 segs → 跳过
        { tStartMs: 60000, dDurationMs: 1000, segs: [{ utf8: "later" }] }, // >6s 新句
      ],
    };
    const srt = json3ToSrt(doc);
    expect(srt).toContain("line break kept");
    expect(srt).toContain("later");
  });

  it("finalizeSubtitles 落盘兜底：.json3 → 同名 .srt；损坏文件跳过不炸", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lasso-json3-"));
    try {
      writeFileSync(
        join(tmp, "video.en.json3"),
        JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "hi there" }] }],
        }),
      );
      writeFileSync(join(tmp, "broken.json3"), "{not json");
      const out = finalizeSubtitles(tmp);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/video\.en\.srt$/);
      const srt = readFileSync(out[0], "utf8");
      expect(srt).toContain("hi there");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("buildYtDlpArgs（D14/D15 模板锚）", () => {
  const base = {
    taskId: "t1",
    source: "https://youtu.be/x",
    outDir: "/tmp/out",
    filename: null,
    subs: false,
    audioOnly: false,
    proxy: null,
  };

  it("基础形态：--newline + 机读模板 + --js-runtimes node + --no-playlist", () => {
    const args = buildYtDlpArgs(base);
    expect(args).toContain("--newline");
    expect(args).toContain("--no-playlist");
    const i = args.indexOf("--progress-template");
    expect(args[i + 1]).toBe(YTDLP_PROGRESS_TEMPLATE);
    const j = args.indexOf("--js-runtimes");
    expect(args[j + 1]).toBe("node");
    // 模板自一致性：download: 前缀 + 5 个 | 分隔（6 字段）
    expect((YTDLP_PROGRESS_TEMPLATE.match(/\|/g) ?? []).length).toBe(5);
    expect(YTDLP_PROGRESS_TEMPLATE.startsWith("download:")).toBe(true);
  });

  it("audioOnly → -f bestaudio -x", () => {
    const args = buildYtDlpArgs({ ...base, audioOnly: true });
    const f = args.indexOf("-f");
    expect(args[f + 1]).toBe("bestaudio");
    expect(args).toContain("-x");
  });

  it("subs → json3 源格式 + convert srt + zh,en（D15 三件套）", () => {
    const args = buildYtDlpArgs({ ...base, subs: true });
    const expectPair = (flag: string, val: string) => {
      const i = args.indexOf(flag);
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe(val);
    };
    expectPair("--sub-format", "json3");
    expectPair("--convert-subs", "srt");
    expectPair("--sub-langs", "zh,en");
    expect(args).toContain("--write-auto-subs");
  });

  it("proxy 透传 --proxy；无 proxy 不出现", () => {
    expect(buildYtDlpArgs({ ...base, proxy: "http://127.0.0.1:7890" })).toContain(
      "--proxy",
    );
    expect(buildYtDlpArgs(base).includes("--proxy")).toBe(false);
  });
});

describe("resolveYtDlpPath 检测序", () => {
  it("LASSO_YTDLP_PATH 第一优先（用户显式意志直信）", () => {
    expect(resolveYtDlpPath({ LASSO_YTDLP_PATH: "/opt/custom/yt-dlp", PATH: "" })).toBe(
      "/opt/custom/yt-dlp",
    );
  });
  it("全缺 → null（无 PATH 无 bin）", () => {
    expect(resolveYtDlpPath({ LASSO_YTDLP_PATH: "", LASSO_BIN_DIR: "/nonexistent-bin", PATH: "/nonexistent" })).toBeNull();
  });
});
