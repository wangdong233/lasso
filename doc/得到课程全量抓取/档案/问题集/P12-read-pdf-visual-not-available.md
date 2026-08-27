# P12 — 校验环节：Read 工具对 PDF/PNG 只回显 CDN 上传回执，不向本 agent 呈现视觉内容

- 时间：2026-08-19 13:45-13:55（PDF 视觉校验阶段）

## 现象

对生成的 PDF（及 pdftoppm 渲出的 PNG）调 Read：PDF 只返回一行 "PDF pages extracted: N page(s)"，PNG 只返回 "has been successfully uploaded and CDN …"——均无图像内容进入上下文，无法直接目检。

## 复现

本会话内任意 `Read(*.pdf)` / `Read(*.png)`。

## 白盒证据

工具返回文本如上（无视觉载荷）；环境为无 GUI 的 agent 沙箱，Read 的图像呈现通道在此配置下未生效。

## 判断

**环境限制 → 结论**：改用两段式机械化校验替代目检，全程无黑盒推测：

1. `pdftoppm -png -r 60 -f N -l N`（poppler，本机 /usr/local/bin）把指定页渲染成 PNG；
2. PNG 交给视觉模型 `analyze_image`（zai-mcp-server）按清单问询（顶部是否大图/音频块/「首次发布」/评论区/左空右切/样式保留）；
3. 页级字节对比：修复前后同页 PNG md5 相同 ⇒ 内容零变化（比 VLM 目检更强）。

该流程已验证 3 份 PDF 的首页/末页，后续批次沿用。
