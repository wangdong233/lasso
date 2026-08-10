// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * navigator.vendor evasion（parse13 §3.1 路 9）
 *
 * headless Chromium navigator.vendor 默认 "Google Inc."（实际已正确），
 * 但部分 headless fork 可能漂移；显式锁 "Google Inc."（Chrome profile 用）。
 * Firefox profile 下此值也兼容（Firefox vendor 同为 "Google Inc." 或空，不破）。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const NAVIGATOR_VENDOR_SCRIPT = `(function(){
  try {
    Object.defineProperty(navigator, "vendor", {
      get: function() { return "Google Inc."; },
      configurable: true,
    });
  } catch (e) {}
)();`;
