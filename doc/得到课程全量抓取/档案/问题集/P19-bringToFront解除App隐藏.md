# P19：CDP bringToFront 类操作会解除 macOS App 隐藏（窗口「偶尔」可见的根因）

## 现象（用户二次报告）
浏览器窗口偶尔自行出现、上面无任何操作（agent 已停/换人，窗口留前台）。

## 白盒证据
round-2 旧版探察 agent（aa65700b75，纪律注入前）transcript 含 **8 处 bringToFront** 调用——CDP 的 tab/窗口激活（Page.bringToFront / target activate / new window）在 macOS 上触发 Chrome 激活窗口 → **AppKit 解除 App 隐藏**（visible:true）。触发式而非定时——「偶尔」= 不同脚本在不同时刻做此类操作。

## 判断：产品缺陷面（P17 粘滞隐藏的第三份实证）
F-1 的 select_page 不带 bringToFront 是对的，但**无法约束外部脚本**（agent 裸 CDP）绕过。唯一工具级根治 = **desiredHidden 粘滞 + server 守护巡检自动复隐**（排队批 A 项）——窗口被任何手段掀出来，15s 内工具自动压回。本事件将 A 项从「排队」提级为「round-2 完成后第一优先」。

## 临时缓解（已执行）
PID 定向手动复隐 85359。新纪律版 agent 无 bringToFront 调用。
