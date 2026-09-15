/**
 * vitest 孤儿探针（BUG-08 F 夹具——被 test/unit/vitest-orphan-governance.spec.ts
 * 嵌套拉起，永不进主套件：文件名形态 probe.ts 不匹配主套件的 spec/test 通配
 * include，且本 config 只在以本目录为 cwd 的嵌套运行中被发现）。
 *
 * 行为：测试体先落 marker 文件（内容 = 自己的 pid——threads 池下 == vitest 主进程
 * pid，forks 池下 == worker 子进程 pid，这是两种池身份判定的真源），然后睡满长窗
 * （模拟 marathon 形态的"忙测试"：对外部事件无感，主进程死亡不会唤醒它）。
 */
import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";

it(
  "orphan probe — hang until killed",
  async () => {
    const marker = process.env.LASSO_ORPHAN_PROBE_MARKER;
    if (!marker) throw new Error("LASSO_ORPHAN_PROBE_MARKER not set by harness spec");
    writeFileSync(marker, String(process.pid));
    // 长睡：外层 spec 会先 SIGKILL vitest 主进程——本测试的存在意义就是
    // 「主进程死后我还活着吗」这一观测本身。
    await new Promise((r) => setTimeout(r, 120_000));
    expect(true).toBe(true);
  },
  120_000,
);
