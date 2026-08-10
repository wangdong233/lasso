// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * chrome.csi evasion（parse13 §3.1 路 6）
 *
 * headless Chromium 默认 window.chrome.csi 不存在 —— sannysoft 检测点。
 * 本脚本注入 chrome.csi() 返 performance.timing 映射（onloadT/startE/pageT/tran:15）。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const CHROME_CSI_SCRIPT = `(function(){
  try {
    window.chrome = window.chrome || {};
    if (window.chrome.csi) return;
    window.chrome.csi = function csi() {
      var nav = (window.performance && window.performance.timing) || {};
      var start = nav.navigationStart || Date.now();
      return {
        onloadT: Date.now(),
        startE: start,
        pageT: (Date.now() - start) > 0 ? (Date.now() - start) : 0,
        tran: 15,
      };
    };
  } catch (e) {}
)();`;
