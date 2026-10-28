# lasso 升级反馈（实测于 2026-10-28，畸变协议 Web 版部署验证场景）

> 交付人：Claude Code（本项目开发代理）。按制作人指示：lasso 不满足使用或有 bug 之处，记详细文档供升级。
> 实测环境：Debian 13 无显示服务器；无预装 Chrome（仅 firefox-esr 153.5，无头 WebGL 不可用）；代理 sudo 被权限策略拦截；已自装 Chrome for Testing 156.0.8078.47 便携版（`~/tools/cft/chrome-headless-shell-linux64/chrome-headless-shell`）。

## 实测错误（原文）

`browse_headless` 首次调用即失败：
```
Error: nav_error:Could not find Google Chrome executable for channel 'stable' at:
 - /opt/google/chrome/chrome.
```

## 问题 1【高】Chrome 发现机制死板，代理无法自救

- 只按 puppeteer `channel: 'stable'` 的**固定 root 路径**探测（/opt/google/chrome/chrome 等），这些路径代理无权写入（需 sudo）。
- 不支持：① 环境变量 `CHROME_PATH`/`PUPPETEER_EXECUTABLE_PATH` **会话内**生效（MCP 服务器进程已启动，env 固化）② 每次 browse 调用传 `executablePath` ③ 用户可写位置的候选路径（如 `~/.cache/puppeteer/`、`~/tools/`）。
- **升级建议**：`browse_headless`/`browse_headed` 增加会话级浏览器路径配置——优先级建议：`options.executablePath`（per-call）> MCP 启动参数透传 chrome-devtools-mcp 的 `--executablePath` > `CHROME_PATH` 热读取（文件探针而非启动 env，如每次 spawn 前读 `~/.config/lasso/chrome-path`）。回归验证可直接用上述便携版路径。

## 问题 2【高】截图"成功"但内容是报错页——工具层无渲染正确性信号

- 实测连续三次：截图正常返回 PNG（非空白、78KB），实际内容是 Godot Web 的**特性缺失报错页**（深底+`#5b3943` 横幅）。工具与调用方都无法从返回值得知"页面没按预期渲染"。
- 本项目被迫自建两套设施才定位：① 像素断言工具（tools/png_probe.py：横幅色检测）② 特性诊断页（六项红绿带：isSecureContext/WebAssembly/WebGL/SAB/COOP/资源可达——像素即读）。
- **升级建议**：`screenshot` 结果支持可选断言参数，如 `expect: {color_absent: "#5b3943", color_present: "#1f2126", region: "full|top-left"}`，断言失败返回 didnt；或 screenshot 附带 error 级 console 摘要（本次 Godot 的特性报错就会出现在 console）。

## 问题 3【中】Firefox 通道缺失

- 机器上有 firefox-esr 时 lasso 完全不可用（CDP 生态绑死 Chrome）。若短期不做 Firefox 驱动，建议至少在错误信息里给出自助指引（如 Chrome for Testing 便携版下载与路径配置方法）。

## 问题 4【低，待确认】SSRF 白名单不可会话内调整

- 文档确认私网 IP 默认拦（127.0.0.1 在白名单内可用）。局域网 IP（192.168.x）按文档预期被拦，而 `LASSO_SSRF_ALLOW_RANGES` 是 env——MCP 服务器启动后同样无法调整。内网开发/测试是高频场景，建议支持配置文件热加载。

## 附：本项目最终闭环方式（供参考）

chrome-headless-shell CLI：`--no-sandbox --window-size=… --screenshot=… --ignore-certificate-errors URL` + png_probe 像素断言 + 双窗口尺寸采样——完成字体/自适应/HTTPS 三项验证，全部通过（见 production/qa/evidence/chrome_*.png）。
