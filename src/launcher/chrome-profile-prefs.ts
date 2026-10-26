/**
 * chrome-profile-prefs（R1，2026-10-26 需求单——doc/提案-需求单R1-R4裁定与R1实施 v2）
 *
 * 职责（单一）：lasso 托管 profile 的 locale 偏好写入器——spawn 前把
 * `intl.accept_languages` / `intl.selected_languages` 写入
 * `<profileDir>/Default/Preferences`。
 *
 * 为什么必须写 profile 而非命令行（需求单实测三条命令行路径全灭的根因）：
 * Chrome 155 起 profile Preferences 的 intl 两键优先级高于 `--lang` /
 * `--accept-lang` / 系统 locale。本机佐证：chrome-profile-default 的
 * Preferences 实测即 `intl: {accept_languages, selected_languages}` 形态。
 * 该 profile 属 lasso 托管（外部禁改第三方 APP 配置——hook 拦截），
 * 写入的合规属主只有 lasso。
 *
 * 契约（提案 §2.2 第 1 步——诚实三档，v2 审查 E-F1/A 修订）：
 *  - 调用点：两档 launcher 的 freshLaunch 内、spawn 前（结构执法——调用方无
 *    绕过面）；写前的「profile 是否被在跑 Chrome 持有」台账守卫在调用点
 *    （launcher 侧已有 readLedgerSync / alive 判定，本模块不查台账）。
 *  - best-effort 非门禁：不可解析 / 写失败 → ok:false（调用方记结构化日志后
 *    继续启动——损坏 Preferences 不应永久锁死启动；locale 缺位可见于日志）。
 *  - 原子写（tmp + renameSync）：登录档 profile 是跨会话登录态资产，半写态
 *    Preferences 会被 Chrome 判损坏重置全部 prefs（审查 E-F6/A-7）——
 *    Chrome 自写 Preferences 的同款惯例。
 *
 * 不做的事（INV-64：仅 node:fs / node:path；提案 R4 拒绝清单）：
 *  - 不建 reused 路径补写器 / 配置变更监听器（以调用点诚实日志替代）
 *  - 不做 locale 探活 / 回读验证子系统（验收脚本属需求方）
 *  - 不引 logger（调用方经 opts.logFn 出口打点——launcher 惯例）
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

// ============================================================
// 类型
// ============================================================
export interface ProfileLocalePrefs {
  /** Accept-Language 值，如 "zh-CN,zh;q=0.9"（写入 intl.accept_languages）。 */
  acceptLanguages: string;
  /** 选定语言，如 "zh-CN"（写入 intl.selected_languages）。 */
  selectedLanguages: string;
}

/** best-effort 结果（瘦身形态——审查 C-4：砍无消费方的 file/created 死表面）。 */
export type ProfilePrefsWriteResult = { ok: true } | { ok: false; error: string };

// ============================================================
// locale tag → Preferences 两键值推导
// ============================================================
/**
 * locale tag（如 `zh-CN`）→ Preferences 两键值；非法 tag 返 null（调用方打
 * `chrome_locale_prefs_failed{reason:invalid_tag}` 日志后放行——一行可观测性
 * 防「静默失效即事故复发」不可诊断，审查 C-2：需求方系统 locale 恰是
 * `zh_CN.UTF-8` 下划线形态，误配概率真实）。
 *
 * 推导规则 = 需求单方案 A 指名映射（验收字符串逐字节一致）：
 *  - `zh-CN` → accept `"zh-CN,zh;q=0.9"` + selected `"zh-CN"`
 *  - 大小写规范化（审查 A-6）：primary 小写、region 子 tag 大写（`zh-cn` →
 *    `zh-CN`）——真实 Chrome 永远规范大小写，非规范形态本身即指纹异型。
 *  - 无区域子 tag（`en`）→ `"en;q=0.9"`（兜底形态；文档推荐区域限定 tag
 *    如 en-US——真实 Chrome 恒为区域限定首 tag）。
 */
export function localePrefValues(tag: string): ProfileLocalePrefs | null {
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(tag)) return null;
  const norm = tag
    .split("-")
    .map((p, i) => (i === 0 ? p.toLowerCase() : p.toUpperCase()))
    .join("-");
  const primary = norm.split("-")[0];
  const base = norm.includes("-")
    ? `${norm},${primary};q=0.9`
    : `${norm};q=0.9`;
  return { acceptLanguages: base, selectedLanguages: norm };
}

// ============================================================
// 写入器
// ============================================================
/**
 * spawn 前读-改-写 `<profileDir>/Default/Preferences` 的 intl 两键。
 *
 * 四路径（spec 六用例逐条锚定）：
 *  - Preferences 不存在（新 profile）→ mkdir Default + 初始 `{intl:{...}}`
 *  - 存在且合法 JSON → 读-改-写（intl 既有子键与顶层其余键原样保留；
 *    既有 accept/selected 值被覆盖——需求方第一真实路径）
 *  - 存在但不可解析 → ok:false `prefs_unparsable:<file>`（**不覆盖原文件**）
 *  - 任何 fs 错误 → ok:false `prefs_write_failed:<err>`（永不抛）
 */
export function writeProfileLocalePrefs(
  profileDir: string,
  prefs: ProfileLocalePrefs,
): ProfilePrefsWriteResult {
  const file = path.join(profileDir, "Default", "Preferences");
  try {
    const existed = existsSync(file);
    let root: Record<string, unknown> = {};
    if (existed) {
      const raw = readFileSync(file, "utf8");
      if (raw.trim() !== "") {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
          ) {
            return { ok: false, error: `prefs_unparsable:${file}` };
          }
          root = parsed as Record<string, unknown>;
        } catch {
          return { ok: false, error: `prefs_unparsable:${file}` };
        }
      }
    } else {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
      } catch {
        /* Chrome 首启自建；写入失败由下方 writeFileSync 兜住 */
      }
    }
    const intl = (
      root.intl &&
      typeof root.intl === "object" &&
      !Array.isArray(root.intl)
        ? root.intl
        : {}
    ) as Record<string, unknown>;
    intl.accept_languages = prefs.acceptLanguages;
    intl.selected_languages = prefs.selectedLanguages;
    root.intl = intl;
    // 原子写：同目录 tmp + rename（跨设备 rename 不存在——tmp 与目标同目录）。
    const tmp = `${file}.lasso-tmp`;
    writeFileSync(tmp, JSON.stringify(root), "utf8");
    renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `prefs_write_failed:${String(e).slice(0, 120)}` };
  }
}
