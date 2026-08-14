// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * chrome.loadTimes evasion（parse13 §3.1 路 7）
 *
 * headless Chromium 默认 window.chrome.loadTimes 不存在 —— sannysoft 检测点。
 * 本脚本注入 chrome.loadTimes() 返 protocolInfo（h2/spdy）+ timingInfo（PerformanceTiming 映射）。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const CHROME_LOADTIMES_SCRIPT = `(function(){
  try {
    window.chrome = window.chrome || {};
    if (window.chrome.loadTimes) return;
    window.chrome.loadTimes = function loadTimes() {
      var nav = (window.performance && window.performance.timing) || {};
      var start = nav.navigationStart || Date.now();
      var toSec = function(ms) { return typeof ms === "number" && ms > 0 ? ms / 1000 : start / 1000; };
      return {
        requestTime: toSec(nav.navigationStart || start),
        startLoadTime: toSec(nav.navigationStart || start),
        commitLoadTime: toSec(nav.responseStart || start),
        finishDocumentLoadTime: toSec(nav.domContentLoadedEventEnd || start),
        finishLoadTime: toSec(nav.loadEventEnd || start),
        firstPaintTime: toSec(nav.responseStart || start),
        firstPaintAfterLoadTime: 0,
        navigationType: "Other",
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: "h2",
        wasAlternateProtocolAvailable: false,
        connectionInfo: "h2",
      };
    };
  } catch (e) {}
})();`;
