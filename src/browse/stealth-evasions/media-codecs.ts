// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * media.codecs evasion（parse13 §3.1 路 11）
 *
 * headless Chromium 默认 HTMLMediaElement.canPlayType 对 H.264 返空字符串
 * （headless build 不含 proprietary codec）—— 指纹库据此判 headless。
 * 本脚本 proxy canPlayType：H.264 (avc1.42E01E) / audio/aac → "probably"，
 *   其余走原生。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const MEDIA_CODECS_SCRIPT = `(function(){
  try {
    var canPlayType = HTMLMediaElement.prototype.canPlayType;
    var supportedCodecs = {
      "video/mp4; codecs=\\"avc1.42E01E\\"": "probably",
      "video/mp4; codecs=\\"avc1.42E01E, mp4a.40.2\\"": "probably",
      "audio/mp4; codecs=\\"mp4a.40.2\\"": "probably",
      "audio/aac": "probably",
      "audio/mpeg": "maybe",
      "video/webm; codecs=\\"vp8, vorbis\\"": "probably",
      "video/webm; codecs=\\"vp9\\"": "probably",
    };
    HTMLMediaElement.prototype.canPlayType = function canPlayTypePatched(type) {
      var key = String(type || "");
      if (Object.prototype.hasOwnProperty.call(supportedCodecs, key)) {
        return supportedCodecs[key];
      }
      return canPlayType.call(this, type);
    };
    // toString 伪装（防 Function.prototype.toString 检测）
    try {
      HTMLMediaElement.prototype.canPlayType.toString = function() {
        return "function canPlayType() { [native code] }";
      };
    } catch (e) {}
  } catch (e) {}
})();`;
