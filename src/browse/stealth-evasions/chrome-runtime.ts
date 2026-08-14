// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * chrome.runtime evasion（增强版，parse13 §3.1 路 4 增强）
 *
 * v1.4 现状：stealth-profiles.ts 只注入 window.chrome = { runtime: {} }（极简）。
 * v1.5 增强：port 完整 chrome.runtime（sendMessage/connect mock + error 类型 +
 *   OnInstalledReason/PlatformArch/PlatformNaclArch 等枚举 + extensionId 校验 +
 *   staticData）—— 防 chrome.runtime 极简结构被检出。
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const CHROME_RUNTIME_SCRIPT = `(function(){
  try {
    window.chrome = window.chrome || {};
    if (window.chrome.runtime && window.chrome.runtime.__patched_stealth) return;

    var STATIC_DATA = {
      OnInstalledReason: {
        CHROME_UPDATE: "chrome_update",
        INSTALL: "install",
        SHARED_MODULE_UPDATE: "shared_module_update",
        UPDATE: "update",
      },
      OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
      PlatformArch: {
        ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64",
        X86_32: "x86-32", X86_64: "x86-64",
      },
      PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
      RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
    };

    var isValidExtensionId = function(id) {
      return typeof id === "string" && /^[a-p]{32}$/.test(id);
    };
    var chromeRuntimeMockError = function(message) {
      this.message = message;
      this.stack = (new Error(message)).stack;
    };
    chromeRuntimeMockError.prototype = Object.create(Error.prototype);
    chromeRuntimeMockError.prototype.constructor = chromeRuntimeMockError;

    var sendMessage = function() {
      var id = arguments[0];
      var errorCallback = arguments[arguments.length - 1];
      if (typeof errorCallback === "function") {
        var mockError = new chromeRuntimeMockError("The message port closed before a response was received.");
        setTimeout(function() { errorCallback(mockError); }, 0);
      }
    };
    var connect = function() {
      var id = arguments[0];
      var onConnect = { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; }, hasListeners: function() { return false; } };
      var onMessage = { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; }, hasListeners: function() { return false; } };
      var port = {
        name: "",
        onDisconnect: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; }, hasListeners: function() { return false; } },
        onMessage: onMessage,
        postMessage: function() {},
        disconnect: function() {},
      };
      return port;
    };

    window.chrome.runtime = {
      __patched_stealth: true,
      // 枚举（STATIC_DATA 直展开）
      OnInstalledReason: STATIC_DATA.OnInstalledReason,
      OnRestartRequiredReason: STATIC_DATA.OnRestartRequiredReason,
      PlatformArch: STATIC_DATA.PlatformArch,
      PlatformNaclArch: STATIC_DATA.PlatformNaclArch,
      PlatformOs: STATIC_DATA.PlatformOs,
      RequestUpdateCheckStatus: STATIC_DATA.RequestUpdateCheckStatus,
      // connect / sendMessage mock
      connect: connect,
      sendMessage: sendMessage,
      // id / contextOptions
      id: undefined,
      // 事件监听器桩（sannysoft 查 onConnect / onMessage / onInstalled 存在性）
      onConnect: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; }, hasListeners: function() { return false; } },
      onMessage: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; }, hasListeners: function() { return false; } },
      onInstalled: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; }, hasListeners: function() { return false; } },
      onStartup: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; }, hasListeners: function() { return false; } },
      onSuspend: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; }, hasListeners: function() { return false; } },
      // manifest（返 undefined，与无 extension 上下文一致）
      getManifest: function() { return undefined; },
      getURL: function(path) { return "chrome-extension://invalid/" + String(path); },
      // 其它常见方法桩
      openOptionsPage: function() {},
      setUninstallURL: function() {},
      connectNative: function() { return connect(); },
      sendNativeMessage: function() {},
      getPlatformInfo: function(cb) { if (typeof cb === "function") cb({ os: "mac", arch: "x86-64", nacl_arch: "x86-64" }); },
      // 兼容 SomeName vs someName 大小写范式（puppeteer-extra 同源）
      SendMessage: sendMessage,
      Connect: connect,
    };
  } catch (e) {}
})();`;
