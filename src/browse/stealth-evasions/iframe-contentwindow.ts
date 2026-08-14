// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * iframe.contentWindow evasion（parse13 §3.1 路 13）
 *
 * headless Chromium document.createElement("iframe").contentWindow 在某些版本暴露
 * chrome 属性差异 —— sannysoft HEADCHR_IFRAME 检测点。
 * 本脚本 proxy document.createElement：对 iframe tag，patch contentWindow 的
 *   navigator.webdriver / chrome 属性与父窗口一致。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const IFRAME_CONTENTWINDOW_SCRIPT = `(function(){
  try {
    var nativeCreateElement = document.createElement;
    if (!nativeCreateElement) return;
    document.createElement = function createElementPatched(tagName) {
      var el = nativeCreateElement.apply(this, arguments);
      try {
        var tag = String(tagName || "").toLowerCase();
        if (tag === "iframe") {
          // 拦截 contentWindow 访问：一旦 iframe 插入 DOM，contentWindow 内的
          // navigator.webdriver 需与父窗口一致（防 HEADCHR_IFRAME 检测）
          var origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
          if (origContentWindow && origContentWindow.get) {
            var nativeGet = origContentWindow.get;
            Object.defineProperty(el, "contentWindow", {
              get: function() {
                var cw = nativeGet.call(this);
                try {
                  if (cw && cw.navigator) {
                    Object.defineProperty(cw.navigator, "webdriver", {
                      get: function() { return undefined; },
                      configurable: true,
                    });
                  }
                } catch (e) {}
                return cw;
              },
              configurable: true,
            });
          }
        }
      } catch (e) {}
      return el;
    };
    try {
      document.createElement.toString = function() {
        return "function createElement() { [native code] }";
      };
    } catch (e) {}
  } catch (e) {}
})();`;
