// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * window.outerdimensions evasion（parse13 §3.1 路 14）
 *
 * headless Chromium window.outerWidth/outerHeight 默认 0 —— 检测点（headed 浏览器
 * outerWidth=innerWidth，outerHeight=innerHeight+浏览器 chrome 工具栏高度）。
 * 本脚本 patch outerWidth=innerWidth，outerHeight=innerHeight+85（业界默认工具栏高度）。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const OUTER_DIMENSIONS_SCRIPT = `(function(){
  try {
    if (window.outerWidth && window.outerHeight) return;
    Object.defineProperty(window, "outerWidth", {
      get: function() { return window.innerWidth; },
      configurable: true,
    });
    Object.defineProperty(window, "outerHeight", {
      get: function() { return window.innerHeight + 85; },
      configurable: true,
    });
  } catch (e) {}
)();`;
