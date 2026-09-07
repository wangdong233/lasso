/**
 * r3-dual-duty-revival.spec.ts（BUG-03 adversarial r3 F1，2026-09-08）
 *
 * 事故型（真机定罪，复现链见 doc/bugs/03 §11）：runHideEnforcerCli 双职责闩的
 * 原实现中，两个调度器各自「账空 2 tick 自杀」且自杀为终态——粘滞看门狗先死
 * （chrome-stop 后 ~4.5s）而 idle 收割职责仍在计数（15s×2=30s 死窗）或台账仍有
 * 他记录（无限期）时，执守进程活着但粘滞执守已死：死窗内新 hidden launch 的
 * probe 判 already_running 跳过重生 → 新 Chrome 永无压回（v1.18.3 P27 契约
 * 静默失效）+ 粘滞账死 pid 记录永不清账（真机 3 条滞留 11 分钟）。
 *
 * 修复面：startDualDutyEnforcer 自愈监护——职责自杀后账面重填 → 复活 + 重置
 * 闩旗；退出判定 = 两职责都自杀且**退出前新鲜读**两账皆空。
 *
 * 全 DI（职责工厂/账面谓词/退出回调注入）——零真进程、零真文件。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { startDualDutyEnforcer } from "../../src/launcher/desired-hide-enforcer.js";

/** 工厂计数 + stub 注册表（每次调用新建一个职责 stub；fireIdle 模拟其自杀）。 */
function dutyFactory(): {
  n: () => number;
  stubs: Array<{ fireIdle: () => void }>;
  fn: (onIdleExit: () => void) => { stop(): void };
} {
  let calls = 0;
  const stubs: Array<{ fireIdle: () => void }> = [];
  return {
    n: () => calls,
    stubs,
    fn: (onIdleExit: () => void) => {
      calls++;
      stubs.push({ fireIdle: onIdleExit });
      return { stop() {} };
    },
  };
}

describe("R3-F1 · startDualDutyEnforcer 自愈监护", () => {
  it("1a. 死窗复现面：粘滞职责自杀 + 台账仍非空（收割职责持活）→ 粘滞账重填 → 复活（工厂二次调用）+ 不退出", () => {
    const sticky = dutyFactory();
    const reap = dutyFactory();
    let exits = 0;
    let stickyNonEmpty = false;
    const reapNonEmpty = { v: true }; // 台账仍有记录（收割职责永续计数）
    const dual = startDualDutyEnforcer({
      stickyDutyFn: sticky.fn as never,
      reapDutyFn: reap.fn as never,
      stickyNonEmptyFn: () => stickyNonEmpty,
      reapNonEmptyFn: () => reapNonEmpty.v,
      onBothIdle: () => {
        exits++;
      },
    });
    expect(sticky.n()).toBe(1); // 首启
    // chrome-stop 后粘滞账清空 2 tick → 看门狗自杀
    sticky.stubs[0]!.fireIdle();
    expect(exits).toBe(0); // 收割职责持活（台账非空）——不退出
    // 死窗内新 launch：粘滞账重填（launch_hidden_birth）
    stickyNonEmpty = true;
    dual.reconcile();
    expect(sticky.n()).toBe(2); // 🔴 修复面：复活（旧实现终态死亡→0 复活）
    expect(exits).toBe(0);
    dual.stop();
  });

  it("1b. 退出判定带新鲜读：两职责都自杀但粘滞账此刻非空 → 不退出反而复活", () => {
    const sticky = dutyFactory();
    const reap = dutyFactory();
    let exits = 0;
    let stickyNonEmpty = true; // 自杀与 reconcile 之间重填（check-then-exit 竞态）
    const dual = startDualDutyEnforcer({
      stickyDutyFn: sticky.fn as never,
      reapDutyFn: reap.fn as never,
      stickyNonEmptyFn: () => stickyNonEmpty,
      reapNonEmptyFn: () => false,
      onBothIdle: () => {
        exits++;
      },
    });
    sticky.stubs[0]!.fireIdle();
    reap.stubs[0]!.fireIdle();
    // 两旗全 true，但新鲜读 sticky 非空 → 复活而非退出
    expect(exits).toBe(0);
    expect(sticky.n()).toBe(2);
    dual.stop();
  });

  it("1c. 正常自退：两职责都自杀且两账皆空 → onBothIdle 恰一次 + stop 后不再触发", () => {
    const sticky = dutyFactory();
    const reap = dutyFactory();
    let exits = 0;
    const dual = startDualDutyEnforcer({
      stickyDutyFn: sticky.fn as never,
      reapDutyFn: reap.fn as never,
      stickyNonEmptyFn: () => false,
      reapNonEmptyFn: () => false,
      onBothIdle: () => {
        exits++;
      },
    });
    sticky.stubs[0]!.fireIdle();
    expect(exits).toBe(0); // 单职责退出不杀另一职责（既有闩语义保持）
    reap.stubs[0]!.fireIdle();
    expect(exits).toBe(1); // 两职责 + 两账空 → 退出恰一次
    dual.reconcile(); // stop 已置（onBothIdle 内 stopped）——幂等不再触发
    expect(exits).toBe(1);
    dual.stop();
  });

  it("1d. 收割职责对称死窗：reaper 自杀后台账重填 → 复活（对称面钉死）", () => {
    const sticky = dutyFactory();
    const reap = dutyFactory();
    let exits = 0;
    let reapNonEmpty = false;
    const dual = startDualDutyEnforcer({
      stickyDutyFn: sticky.fn as never,
      reapDutyFn: reap.fn as never,
      stickyNonEmptyFn: () => false,
      reapNonEmptyFn: () => reapNonEmpty,
      onBothIdle: () => {
        exits++;
      },
    });
    reap.stubs[0]!.fireIdle(); // 台账空 2 tick → reaper 自杀
    expect(exits).toBe(0);
    reapNonEmpty = true; // 新 launch 落台账
    dual.reconcile();
    expect(reap.n()).toBe(2); // 复活
    expect(exits).toBe(0);
    dual.stop();
  });

  it("1e. 收割工厂返 null（显式禁用收割 config）→ 终态不复活、不阻退出（既有 5c 语义保持）", () => {
    const sticky = dutyFactory();
    let exits = 0;
    const dual = startDualDutyEnforcer({
      stickyDutyFn: sticky.fn as never,
      reapDutyFn: () => null,
      stickyNonEmptyFn: () => false,
      reapNonEmptyFn: () => true, // 即便台账非空也不复活（用户显式禁用收割）
      onBothIdle: () => {
        exits++;
      },
    });
    sticky.stubs[0]!.fireIdle(); // 粘滞职责自杀；收割职责 done
    expect(exits).toBe(1); // 正常退出
    dual.stop();
  });

  it("1f. 复活后的新职责再自杀 → 再按账面裁决（复活语义幂等，不卡死不僵尸）", () => {
    const sticky = dutyFactory();
    const reap = dutyFactory();
    let exits = 0;
    let stickyNonEmpty = true;
    const dual = startDualDutyEnforcer({
      stickyDutyFn: sticky.fn as never,
      reapDutyFn: reap.fn as never,
      stickyNonEmptyFn: () => stickyNonEmpty,
      reapNonEmptyFn: () => false,
      onBothIdle: () => {
        exits++;
      },
    });
    sticky.stubs[0]!.fireIdle();
    dual.reconcile(); // 复活（sticky 非空）
    expect(sticky.n()).toBe(2);
    // 复活出的第二个看门狗又自杀（其守护的 Chrome 停了、账被它自己清空）
    stickyNonEmpty = false;
    sticky.stubs[1]!.fireIdle();
    reap.stubs[0]!.fireIdle(); // 收割职责也自杀（台账空 2 tick）
    expect(exits).toBe(1); // 两职责死 + 两账空 → 退出
    dual.stop();
  });

  it("1g. 白盒锚：runHideEnforcerCli 接线自愈监护 + 退出前新鲜读 + 复活日志面", () => {
    const src = readFileSync("src/launcher/desired-hide-enforcer.ts", "utf8");
    expect(src).toMatch(/startDualDutyEnforcer\(\{/);
    expect(src).toMatch(/stickyNonEmptyFn: \(\) => readDesiredHiddenSync\(\)\.length > 0/);
    expect(src).toMatch(/hide_enforcer_duty_revived/);
    // 既有闩锚保持（a1 spec 7 同源）：双旗 + startEnforcerIdleReaper 接线
    expect(src).toMatch(/stickyIdleExited && reapIdleExited/);
    expect(src).toMatch(/startEnforcerIdleReaper\(\{/);
  });
});
