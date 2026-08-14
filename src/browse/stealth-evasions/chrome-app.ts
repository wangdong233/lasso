// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * chrome.app evasion（parse13 §3.1 路 5）
 *
 * headless Chromium 默认 window.chrome 无 app 子对象 —— sannysoft 检测点。
 * 本脚本注入 chrome.app STATIC_DATA + getDetails/getIsInstalled/runningState mock。
 *
 * 顶级 const JS 字符串（INV-30 衍生：纯数据，不从 env/config 读）。
 * 在浏览器页面上下文 via CDP evaluate 执行。
 */

export const CHROME_APP_SCRIPT = `(function(){
  try {
    // chrome.app evasion（parse13 §3.1 路 5；port from puppeteer-extra chrome.app）
    window.chrome = window.chrome || {};
    if (window.chrome.app) return;
    var app = {
      isInstalled: false,
      InstallState: {
        DISABLED: "disabled",
        INSTALLED: "installed",
        NOT_INSTALLED: "not_installed",
      },
      RunningState: {
        CANNOT_RUN: "cannot_run",
        READY_TO_RUN: "ready_to_run",
        RUNNING: "running",
      },
      getDetails: function getDetails() {
        return null;
      },
      getIsInstalled: function getIsInstalled() {
        return false;
      },
      runningState: function runningState() {
        return "cannot_run";
      },
    };
    app.GetDetails = app.getDetails;
    app.GetIsInstalled = app.getIsInstalled;
    app.InstallState = app.InstallState;
    app.RunningState = app.RunningState;
    window.chrome.app = app;
  } catch (e) {}
})();`;
