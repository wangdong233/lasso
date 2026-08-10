// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * navigator.hardwareConcurrency evasion（parse13 §3.1 路 10）
 *
 * headless Chromium navigator.hardwareConcurrency 在某些 CI/容器环境返回 1（异常），
 * 被指纹库标可疑。锁为 4（业界 puppeteer-extra 默认值，合理 CPU 核数）。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const HARDWARE_CONCURRENCY_SCRIPT = `(function(){
  try {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      get: function() { return 4; },
      configurable: true,
    });
  } catch (e) {}
)();`;
