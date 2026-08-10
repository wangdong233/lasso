// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * webgl.vendor evasion（parse13 §3.1 路 12）
 *
 * headless Chromium WebGL getParameter(UNMASKED_VENDOR_WEBGL=37445) 返
 * "Google Inc. (Google)" / SwiftShader —— 头号 headless 破绽。
 * 本脚本 proxy getParameter：37445 → "Intel Inc."，37446 → "Intel Iris OpenGL Engine"。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const WEBGL_VENDOR_SCRIPT = `(function(){
  try {
    var patchGetParameter = function(proto) {
      if (!proto) return;
      var origGetParameter = proto.getParameter;
      if (!origGetParameter) return;
      proto.getParameter = function getParameterPatched(p) {
        // UNMASKED_VENDOR_WEBGL = 37445
        if (p === 37445) return "Intel Inc.";
        // UNMASKED_RENDERER_WEBGL = 37446
        if (p === 37446) return "Intel Iris OpenGL Engine";
        return origGetParameter.apply(this, arguments);
      };
      try {
        proto.getParameter.toString = function() {
          return "function getParameter() { [native code] }";
        };
      } catch (e) {}
    };
    if (typeof WebGLRenderingContext !== "undefined") {
      patchGetParameter(WebGLRenderingContext.prototype);
    }
    if (typeof WebGL2RenderingContext !== "undefined") {
      patchGetParameter(WebGL2RenderingContext.prototype);
    }
  } catch (e) {}
)();`;
