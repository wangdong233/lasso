/**
 * input-guard（doc/bugs/11 决议 C，2026-09-17）
 *
 * 站点输入保护层的**诚实信号**：三探针的 in-page evaluate 表达式构造
 * （extract-refs.ts 同范式纯函数模块——expr 构造，无 SDK 依赖、无 IO）。
 *
 * 机理背景（bugs/11 §0 白盒定谳）：下午报告的「输入保护层瞬间清除」不成立；
 * 真实机制是框架/引擎的状态完整性语义——脚本写入（element.value= / 合成事件）
 * 不进框架输入管道（React onChange 不触发），blur/commit 时框架把 DOM 回写为
 * 已提交状态（值「消失」）。经可信管道（CDP Input 域逐字派发，isTrusted:true）
 * 键入的值 blur 后存活。三探针把这道墙显式化（此前 fill 报 worked、值静默消失
 * ——失败模式不可见是 lasso 的可观测性欠账）：
 *
 *  - G1 安装态 value_setter_non_native：el 自身有 value own property（实例级
 *    accessor 劫持）或原型链 value 访问器不含 [native code]
 *  - G2 生效态 fill_readback_mismatch：填充/键入后延时读回 ≠ 所设值
 *    （MutationObserver/异步重置族）
 *  - G3 受控分叉 react_tracker_divergence：React _valueTracker 分叉
 *    （tracker.getValue() !== el.value——受控回写，tm.aliyun.com 本体机理）
 *
 * 红线（决议 §C.3，驱逐哨兵同款）：
 *  - **只供信号，绝不自动改道**——检测到保护层不自动换 type/不重试/不换通道；
 *    hint 里的换路指引是指令不是行动
 *  - 探针纯读（G1/G3 纯属性检查；G2 的 250ms 等待在页内 sleep，不发事件、
 *    **不 blur**、不 focus 别处——blur 会触发提交/校验）
 *  - 信号路径零 FallbackDecider 调用、零 spawn、零页面副作用
 *
 * 值守区 = 信任阶梯第 2 层（doFill ref 路 / doType ref 路；BrowseChannel 消费）。
 * uid 路 v1 不探（第 1 层可信管道——快照解析探针的成本>增值，如实文档化边界）。
 */

/** G1：value setter 非原生（实例 own property / 原型链非 [native code] 访问器）。 */
export const GUARD_CHECK_G1 = "value_setter_non_native";
/** G2：填充/键入值延时读回不符（异步重置族）。 */
export const GUARD_CHECK_G2 = "fill_readback_mismatch";
/** G3：React _valueTracker 分叉（受控回写族）。 */
export const GUARD_CHECK_G3 = "react_tracker_divergence";

/** G2 的页内延时（ms）——异步重置族的观察窗（决议 §C.1 ~250ms）。 */
export const GUARD_READBACK_DELAY_MS = 250;

/** ref 定位片段（extract-refs.ts refQuerySnippet 同式；模块私有，禁跨文件耦合）。 */
function refQuerySnippet(refVar: string): string {
  return `document.querySelector('[data-lasso-uid="' + CSS.escape(${refVar}) + '"]')`;
}

/** G1/G3 探针函数片段（嵌入各 expr；纯读——禁事件派发/blur/focus）。 */
function probeFunctionsSnippet(): string {
  return `
    function g1(el) {
      try {
        if (Object.prototype.hasOwnProperty.call(el, "value")) return true;
        var p = Object.getPrototypeOf(el);
        while (p) {
          var d = Object.getOwnPropertyDescriptor(p, "value");
          if (d) {
            if (d.set && String(d.set).indexOf("[native code]") < 0) return true;
            break;
          }
          p = Object.getPrototypeOf(p);
        }
      } catch (e) {}
      return false;
    }
    function g3(el) {
      try {
        if ("_valueTracker" in el && el._valueTracker &&
            typeof el._valueTracker.getValue === "function") {
          return String(el._valueTracker.getValue()) !== String(el.value);
        }
      } catch (e) {}
      return false;
    }
    function readback(el) {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || "value" in el) {
        return String(el.value == null ? "" : el.value);
      }
      if (el.isContentEditable) return String(el.textContent || "");
      return null;
    }`;
}

/**
 * 决议 C.1 三探针 expr（doFill ref 路 / doType ref 路共用——一次 in-page
 * evaluate 全探，纯读 + 页内 250ms sleep）。
 *
 * 输入：entries = [{ ref, value, pre? }]（value = 刚填充/键入的期望值；
 * pre = 键入前的元素读回——**type 追加语义专用**，见下）。
 * 返回 JSON 字符串 { ok, guards: [{ ref, checks: [...] }] }——guards 只含
 * 有命中的字段（全负 = 空数组 = 无信号）。expr 抛错 → { ok:false }（探测
 * 失败不是保护层证据，调用方按 best-effort 无信号处理）。
 *
 * G2 双语义（对抗复审 r1，2026-09-17）：type 是 **append**（describe 明示
 * "appends to existing text — fill replaces"）——非空字段上 type 后
 * cur = pre + text ≠ text，若沿用 fill 的精确读回判据（cur ≠ value）会在
 * **值完全存活**时系统性误报 G2（假信号）。故：
 *  - fill 模式（pre 缺席/null）：G2 ⇔ cur !== value（精确读回——replace 语义）
 *  - type 模式（pre 为字符串）：G2 ⇔ cur === pre（存活语义——typed keys
 *    **全拒**才报，与 hint 终态分支 "if typed keys are also rejected" 对齐；
 *    cur 有任何变化即不claim——advisory 诚实优先于覆盖率）
 */
export function buildGuardProbeExpr(
  entries: Array<{ ref: string; value: string; pre?: string | null }>,
): string {
  return `async () => {
    try {
      var entries = ${JSON.stringify(entries)};
      var DELAY_MS = ${GUARD_READBACK_DELAY_MS};${probeFunctionsSnippet()}
      await new Promise(function (res) { setTimeout(res, DELAY_MS); });
      var guards = [];
      for (var i = 0; i < entries.length; i++) {
        var ref = entries[i].ref;
        var expected = entries[i].value;
        var pre = (typeof entries[i].pre === "string") ? entries[i].pre : null;
        var el = null;
        try { el = ${refQuerySnippet("ref")}; } catch (e) { el = null; }
        if (!el) continue;
        var checks = [];
        var cur = readback(el);
        if (cur !== null) {
          if (g1(el)) checks.push(${JSON.stringify(GUARD_CHECK_G1)});
          if (pre === null) {
            if (cur !== expected) checks.push(${JSON.stringify(GUARD_CHECK_G2)});
          } else if (cur === pre) {
            checks.push(${JSON.stringify(GUARD_CHECK_G2)});
          }
          if (g3(el)) checks.push(${JSON.stringify(GUARD_CHECK_G3)});
        } else if (el.isContentEditable) {
          var curT = String(el.textContent || "");
          if (pre === null) {
            if (curT !== expected) checks.push(${JSON.stringify(GUARD_CHECK_G2)});
          } else if (curT === pre) {
            checks.push(${JSON.stringify(GUARD_CHECK_G2)});
          }
        }
        if (checks.length > 0) guards.push({ ref: ref, checks: checks });
      }
      return JSON.stringify({ ok: true, guards: guards });
    } catch (e) {
      return JSON.stringify({ ok: false, guards: [], reason: "eval_error:" + String(e) });
    }
  }`;
}

/**
 * 决议 B.1 ref 路 focus expr：定位 → el.focus() → 回读
 * document.activeElement === el 作 focus 回执（上游 type_text 的文档化前置
 * 「previously focused input」）。miss → { ok:false, reason:"ref_stale" }。
 *
 * 回执携带 pre = focus 后（= 键入前最后一刻）的元素读回（value/textContent，
 * 同 probe 的 readback 判定式；两者皆非 → null）。对抗复审 r1（2026-09-17）：
 * type 是 append 语义，G2 存活判据需要键入前的基线——pre 在 focus 后读取
 * （focus 处理器若改值也计入基线，与 type_text 的写入点零距离）。
 *
 * 注意：focus() 打在**目标自身**上（键入前置），不是探测行为——决议 §C.3
 * 禁的是「为探测合成 blur / focus 别处」。
 */
export function buildRefFocusExpr(ref: string): string {
  return `() => {
    try {
      var ref = ${JSON.stringify(ref)};
      var el = null;
      try { el = ${refQuerySnippet("ref")}; } catch (e) { el = null; }
      if (!el) return JSON.stringify({ ok: false, reason: "ref_stale" });
      el.focus();
      var pre = null;
      try {
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || "value" in el) {
          pre = String(el.value == null ? "" : el.value);
        } else if (el.isContentEditable) {
          pre = String(el.textContent || "");
        }
      } catch (e2) { pre = null; }
      return JSON.stringify({
        ok: true,
        focused: document.activeElement === el,
        tag: (el.tagName || "").toLowerCase(),
        pre: pre
      });
    } catch (e) {
      return JSON.stringify({ ok: false, reason: "eval_error:" + String(e) });
    }
  }`;
}

/**
 * 探针结果形状（parseEvalResult 解出的脚本返回值）。guards 只含有命中的字段。
 */
export interface GuardProbeResult {
  ok?: boolean;
  guards?: Array<{ ref: string; checks: string[] }>;
  reason?: string;
}

/**
 * 探针结果 → 信号对象（决议 C.2 回显形状）。无命中/探测失败 → null（best-effort：
 * 探测失败不是保护层证据）。checks = 全字段并集去重（G1→G2→G3 固定序），
 * target = 命中字段 ref 逗号连缀（ref 身份，非 uid——uid 路 v1 不探）。
 */
export function toSignal(
  v: GuardProbeResult | undefined,
  now: () => number = Date.now,
): { checks: string[]; target: string; at_ms: number } | null {
  if (!v?.ok || !Array.isArray(v.guards) || v.guards.length === 0) return null;
  const order = [GUARD_CHECK_G1, GUARD_CHECK_G2, GUARD_CHECK_G3];
  const seen = new Set<string>();
  for (const g of v.guards) for (const c of g.checks ?? []) seen.add(c);
  const checks = order.filter((c) => seen.has(c));
  if (checks.length === 0) return null;
  const refs = v.guards.map((g) => g.ref).filter(Boolean);
  if (refs.length === 0) return null;
  return { checks, target: refs.join(","), at_ms: now() };
}
