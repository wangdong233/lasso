// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * UA client hints evasion（parse13 §3.1 路 15 + §4.5）
 *
 * 现代反爬查 navigator.userAgentData.brands 是否与 navigator.userAgent 的 Chrome 版本
 * 一致 —— 头号检测点（doc/16 §1.3 P2）。chrome-devtools-mcp 不暴露 CDP
 * Network.setUserAgentOverride / setExtraHTTPHeaders，故 HTTP header 侧 sec-ch-ua 无法
 * 经 JS 注入（网络层）；本脚本只补 JS 侧 navigator.userAgentData（sec-ch-ua 的 JS 投影）。
 *
 * 设计（parse13 §4.5 v1.5 MVP）：
 *  - 读取 navigator.userAgent（**应在 buildUserAgentOverrideScript 之后执行**，此时 UA 已
 *    override 为 profile UA），解析 Chrome major 版本
 *  - 若 UA 不含 Chrome/Chromium（Safari/Firefox profile）→ 跳过（Safari 无 userAgentData）
 *  - 否则构造 navigator.userAgentData = { brands, mobile, platform }，brands 版本与 UA 一致
 *
 * 顶级 const JS 字符串（INV-30 衍生）。
 */

export const UA_CLIENT_HINTS_SCRIPT = `(function(){
  try {
    if (navigator.userAgentData) return; // 已有则不覆盖
    var ua = navigator.userAgent || "";
    var m = ua.match(/Chrom(?:e|ium)\\/(\\d+)/);
    if (!m) return; // Safari/Firefox profile：无 userAgentData，跳过
    var major = parseInt(m[1], 10);
    // 三件套 brands（Google Chrome / Chromium / ghost brand），版本与 UA 一致。
    // ghost brand 按 Chrome 版本 seed %4 取（puppeteer-extra _getBrands 范式），
    // Chrome 130 → "Not?A_Brand"（与 STEALTH_PROFILES.secChUa 字面量对齐）。
    var ghostBrands = ["Not.A/Brand", "Not)A;Brand", "Not?A_Brand", "Not_A Brand"];
    var ghostBrand = ghostBrands[major % 4];
    var brands = [
      { brand: "Google Chrome", version: String(major) },
      { brand: ghostBrand, version: "99" },
      { brand: "Chromium", version: String(major) },
    ];
    // platform 推断（与 UA 一致）
    var platform = "Windows";
    if (/Macintosh|Mac OS X/i.test(ua)) platform = "macOS";
    else if (/Linux/i.test(ua)) platform = "Linux";
    else if (/Android/i.test(ua)) platform = "Android";
    var uaData = {
      brands: brands,
      mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(ua),
      platform: platform,
    };
    // getHighEntropyValues mock（返 fullVersionList / platform / architecture 等）
    uaData.getHighEntropyValues = function(hints) {
      return Promise.resolve({
        architecture: "x86",
        bitness: "64",
        brands: brands,
        fullVersionList: brands.map(function(b) {
          return { brand: b.brand, version: b.brand.indexOf("Not") === 0 ? "99.0.0.0" : String(major) + ".0.0.0" };
        }),
        mobile: uaData.mobile,
        model: "",
        platform: platform,
        platformVersion: "10.0.0",
        uaFullVersion: String(major) + ".0.0.0",
        wow64: false,
      });
    };
    uaData.toJSON = function() {
      return { brands: brands, mobile: uaData.mobile, platform: platform };
    };
    Object.defineProperty(navigator, "userAgentData", {
      get: function() { return uaData; },
      configurable: true,
    });
  } catch (e) {}
)();`;
