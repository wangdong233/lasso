// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend
/**
 * navigator.plugins evasion（parse13 §3.1 路 8，最复杂）
 *
 * headless Chromium 默认 navigator.plugins 是空数组 —— 头号破绽（sannysoft 标红）。
 * 本脚本 port puppeteer-extra 全套 navigator.plugins mock：构造 5 个 fake Plugin
 * （PDF Viewer × 3 + Chrome PDF Viewer + Native Client）+ 对应 MimeType +
 *  refresh() / item() / namedItem() 方法 + length。data 来自 puppeteer-extra data.json。
 *
 * 顶级 const JS 字符串（INV-30 衍生：data 是静态字面量，不从 env/config 读）。
 */

export const NAVIGATOR_PLUGINS_SCRIPT = `(function(){
  try {
    // headless Chromium navigator.plugins 默认 length=0 —— 直接 mock 成 5 条
    // （puppeteer-extra data.json 标准三件套：PDF Viewer / Chrome PDF Viewer / Chromium PDF Viewer）
    var makeMimeArray = function(arr) {
      var obj = {
        length: arr.length,
        item: function(i) { return arr[i] || null; },
        namedItem: function(name) { var hit = arr.find(function(m) { return m.type === name; }); return hit || null; },
        refresh: function() {},
      };
      arr.forEach(function(m, i) { obj[i] = m; });
      return obj;
    };
    var makePluginEntry = function(p) {
      var entry = {
        name: p.name,
        filename: p.filename,
        description: p.description,
        length: p.mimes.length,
        item: function(i) { return p.mimes[i] || null; },
        namedItem: function(name) { var hit = p.mimes.find(function(m) { return m.type === name; }); return hit || null; },
      };
      p.mimes.forEach(function(m, i) {
        entry[i] = {
          type: m.type,
          suffixes: m.suffixes,
          description: m.description,
          enabledPlugin: entry,
        };
      });
      return entry;
    };

    // 5 个标准 plugin（data 来自 puppeteer-extra-plugin-stealth data.json）
    var PDF_MIMES = [
      { type: "application/pdf", suffixes: "pdf", description: "" },
      { type: "text/pdf", suffixes: "pdf", description: "" },
    ];
    var pluginsData = [
      { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", mimes: PDF_MIMES },
      { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", mimes: PDF_MIMES },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", mimes: PDF_MIMES },
      { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", mimes: PDF_MIMES },
      { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format", mimes: PDF_MIMES },
    ];

    var pluginEntries = pluginsData.map(makePluginEntry);
    var allMimes = pluginEntries.reduce(function(acc, p) {
      for (var i = 0; i < p.length; i++) { acc.push(p[i]); }
      return acc;
    }, []);

    var pluginArrayMock = {
      length: pluginEntries.length,
      item: function(i) { return pluginEntries[i] || null; },
      namedItem: function(name) { return pluginEntries.find(function(p) { return p.name === name; }) || null; },
      refresh: function() {},
    };
    pluginEntries.forEach(function(p, i) { pluginArrayMock[i] = p; });

    var mimeArrayMock = makeMimeArray(allMimes);

    Object.defineProperty(navigator, "plugins", {
      get: function() { return pluginArrayMock; },
      configurable: true,
    });
    Object.defineProperty(navigator, "mimeTypes", {
      get: function() { return mimeArrayMock; },
      configurable: true,
    });
  } catch (e) {}
)();`;
