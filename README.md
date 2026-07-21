# Lasso

> CC 的**全交互**对外抓手 MCP（浏览器 + 桌面）。牛仔套索，"套住任何界面"。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Status: WIP](https://img.shields.io/badge/status-v0.1%20MVP%20WIP-orange)]()

## 这是什么

Lasso 让 Claude Code 通过这唯一一个 MCP，高效和**浏览器 + 桌面**交互。与 [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp)（图像抓手）双子星：「所有图像操作归一个 MCP」↔「所有外部交互归一个 MCP」。

**四通道**：
- `search` — 智谱 web-search-prime（结构化搜索 API，默认入口）
- `browse_headless` — chrome-devtools-mcp `--headless --isolated`（干净无头）
- `browse_logged_in` — chrome-devtools-mcp `--browser-url :9222`（复用本机已登录 Chrome）
- `desktop` — macOS AXAPI（Rust helper，v0.3.5+）

跨模态 fallback 链自动降级（search 失败 → browse_headless 实搜；desktop ax 失败 → screenshotVlm 兜底），对 CC 透明。

## 状态

🚧 **v0.1 MVP 开发中**。权威架构见 [`doc/08`](../doc/08-media-interact-功能架构.md)，排期见 [`doc/09`](../doc/09-media-interact-实施排期.md)。

## 设计原则

1. **能力导向命名**（search / browse_* / desktop，不按后端）
2. **页面/界面状态写磁盘**（不灌上下文，4× token 效率）
3. **诚实三态交付**（`worked / didnt / unknown`）—— event delivery alone is never treated as semantic success
4. **第二套做法红线**（四通道共享一套 fallback 范式 / 状态模型 / 工具风格）
5. **架构不变量脚本化**（CI 守门，防 refactor 回退）

## 安装（待发布）

```bash
# Claude Code 配置
claude mcp add lasso --scope user -- npx -y lasso-mcp

# 或全局安装
npm install -g lasso-mcp
```

## 开发

```bash
npm install      # 装依赖
npm run build    # TypeScript 编译
npm run check-invariants  # 架构不变量检查（F3.9.8）
npm test         # 测试
```

## 相关文档

- [08 功能架构](../doc/08-media-interact-功能架构.md) — 权威架构基线
- [09 实施排期](../doc/09-media-interact-实施排期.md) — v0.1 → v1.0 能力跃升
- [13 全交互重设计](../doc/13-全交互抓手重设计.md) — 桌面演进设计

## License

MIT © wangdong233
