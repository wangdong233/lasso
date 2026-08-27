# parse14-acceptance — Lasso v1.6 SteelChannel 手测验收清单

> **版本**：v1.6.0（Phase A + Phase B 完成）
> **基线**：74 invariants + 1593 TS + 179 Rust；rust-helper/零改；version 1.6.0
> **上游**：doc/parse/parse14.md（实施计划）+ doc/16 §0 #3 / §5 建议 2（Steel 选型）
> **审查**：03 §1 六维度审查全过（§1.1-§1.7 逐项；无 🔴 阻断 / 无 🟡 必修）
> **执行人**：用户（本机 macOS / Docker 环境）
> **预计耗时**：30-60 min（Docker 镜像 ~1GB+ 首次拉取占大头）

---

## 0. 前置条件（环境就绪）

### 0.1 Docker Desktop

```bash
docker --version          # Docker version 20+, any recent
docker ps                 # 应返空列表（dockerd 在跑）
```

未装 Docker → 跳到本文件 §5（无 Docker 降级路径）。

### 0.2 Lasso v1.6.0 build 已就位

```bash
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
npm run build && npm test && npm run check-invariants
# 期望：88 test files passed (1593 tests) + 74/74 invariants passed
```

### 0.3 LASSO env（暂时不要 export，下面步骤逐项设）

```bash
# 默认 OFF：steel tool 不注册（INV-25/INV-74 双重解锁）
unset LASSO_ALLOW_CLOUD_BROWSER
unset STEEL_ENDPOINT
unset STEEL_CDP_ENDPOINT
```

---

## 1. Steel Docker 本地启动（parse14 §4.3）

### 1.1 拉镜像 + 启容器

```bash
docker run -d --name steel-browser \
  -p 3000:3000 \
  -p 9223:9223 \
  ghcr.io/steel-dev/steel-browser
```

**端口契约**（parse14 §3.2 表 + §4.3 路径表）：
- `3000` = Steel REST API（POST /v1/sessions 创建 session；GET /health 健康检查）
- `9223` = Chrome CDP nginx proxy（chrome-devtools-mcp `--browser-url=http://localhost:9223` 连此；nginx 内部转发到 Chrome 9222）

### 1.2 等待 Steel 就绪

```bash
# 轮询 /health 直到返 {"status":"ok"}
for i in {1..30}; do
  resp=$(curl -s http://localhost:3000/health 2>/dev/null)
  if echo "$resp" | grep -q '"ok"'; then
    echo "Steel ready: $resp"
    break
  fi
  echo "waiting... ($i/30)"
  sleep 2
done
```

**期望输出**：
```json
{"status":"ok"}
```

如果 30s 后仍未就绪：
```bash
docker logs steel-browser | tail -50
# Chrome 启动期可能慢；首启拉 chromium 二进制约 10-30s
```

### 1.3 验 9223 CDP nginx proxy 可达

```bash
curl -s http://localhost:9223/json/version
```

**期望**：返 Chrome CDP 版本元数据 JSON（含 `Browser`、`webSocketDebuggerUrl`）。
**失败可能**：nginx 9223 proxy 未启 / Chrome 内部 9222 未启 → `docker logs steel-browser` 查。

---

## 2. doctor #37 steel_endpoint_reachable 自检

### 2.1 默认 OFF：cloud 关 → pass（不阻塞 ready）

```bash
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
node dist/index.js doctor | python3 -c "import json,sys;r=json.load(sys.stdin);print([c for c in r['checks'] if c['name']=='steel_endpoint_reachable'])"
```

**期望**：
```json
[{"name":"steel_endpoint_reachable","status":"pass","detail":"LASSO_ALLOW_CLOUD_BROWSER=false（默认；Steel 通道未启用；PolicyGate 将阻断 browse_cloud_steel）"}]
```

### 2.2 双重解锁：endpoint 配 + manual-switch 开 → pass（Steel 可达）

```bash
LASSO_ALLOW_CLOUD_BROWSER=true STEEL_ENDPOINT=http://localhost:3000 \
  node dist/index.js doctor | \
  python3 -c "import json,sys;r=json.load(sys.stdin);print([c for c in r['checks'] if c['name']=='steel_endpoint_reachable'])"
```

**期望**：
```json
[{"name":"steel_endpoint_reachable","status":"pass","detail":"STEEL_ENDPOINT=http://localhost:3000 GET /health → 200 OK; body.status=ok"}]
```

### 2.3 manual-switch ON 但 endpoint 缺 → warn（双重解锁未满足）

```bash
LASSO_ALLOW_CLOUD_BROWSER=true \
  node dist/index.js doctor | \
  python3 -c "import json,sys;r=json.load(sys.stdin);print([c for c in r['checks'] if c['name']=='steel_endpoint_reachable'])"
```

**期望**：
```json
[{"name":"steel_endpoint_reachable","status":"warn","detail":"LASSO_ALLOW_CLOUD_BROWSER=true 但 STEEL_ENDPOINT 未配（PolicyGate 将阻断 browse_cloud_steel）","next_step":"export STEEL_ENDPOINT=http://localhost:3000..."}]
```

### 2.4 endpoint 不可达（Steel Docker 停）→ warn（不 fail）

```bash
docker stop steel-browser
LASSO_ALLOW_CLOUD_BROWSER=true STEEL_ENDPOINT=http://localhost:3000 \
  node dist/index.js doctor | \
  python3 -c "import json,sys;r=json.load(sys.stdin);print([c for c in r['checks'] if c['name']=='steel_endpoint_reachable'])"
docker start steel-browser  # 重启供后续步骤用
```

**期望**：`status=warn` + detail 含「不可达」+ next_step 含 `docker run` 启动命令。**永不 fail**（守 parse14 §5.5：Steel 是可选 fallback 链尾）。

---

## 3. SteelChannel 端到端真实 browse（MCP 客户端视角）

### 3.1 启 Lasso MCP server（双重解锁）

```bash
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
export LASSO_ALLOW_CLOUD_BROWSER=true
export STEEL_ENDPOINT=http://localhost:3000
node dist/index.js 2>lasso-v16-steel.log &
LASO_PID=$!
sleep 2
```

### 3.2 验 steel tool 已注册

用 CC / MCP inspector 连 lasso，调 `tools/list`：

**期望**：tools 数组含 `{name: "steel", description: "Self-hosted cloud Chrome via Steel..."}`。

**默认 OFF 对照**：`unset STEEL_ENDPOINT && node dist/index.js` → tools/list 不含 "steel"（INV-25/INV-74 双重解锁守门）。

### 3.3 真实 navigate https://example.com/

经 MCP 调：
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "steel",
    "arguments": {
      "url": "https://example.com/",
      "action": "snapshot"
    }
  },
  "id": 1
}
```

**期望响应**：
```json
{
  "content": [{
    "type": "text",
    "text": "{\n  \"outcome\": \"worked\",\n  \"served_by\": \"browse_cloud_steel\",\n  \"retrieval_method\": \"cloud_steel\",\n  ...\n}"
  }]
}
```

**值级断言**（parse14 §5.3 smoke 项 1）：
- `outcome === "worked"`
- `served_by === "browse_cloud_steel"`
- `retrieval_method === "cloud_steel"`
- `data.preview` 含 "Example Domain"

### 3.4 真实 extract https://example.com/

```json
{"name": "steel", "arguments": {"url": "https://example.com/", "action": "extract"}}
```

**期望**：`outcome=worked` + `retrieval_method=cloud_steel` + data.preview 含页面正文。

### 3.5 真实 screenshot https://example.com/

```json
{"name": "steel", "arguments": {"url": "https://example.com/", "action": "screenshot"}}
```

**期望**：`outcome=worked` + data.screenshot 路径非空（PNG 落盘到 cache dir）。

### 3.6 单例 session 并发（parse14 §5.3 smoke 项 5）

并发 2 个 steel 调用（不 await 第一个）：
```bash
# 在两个并行 MCP 客户端 / 两个 shell 同时调 steel tool
# 期望：两个都 outcome=worked；SteelChannel 内 mutex 保护 sessionProvider 只调 1 次
```

**验**：日志 `lasso-v16-steel.log`：
```bash
grep "steel_session_acquired" lasso-v16-steel.log | wc -l
# 期望：1（mutex 守护：并发调用只激活 1 次 session）
```

---

## 4. cookie 不出本地验证（parse14 §6.1 #2 红线）

### 4.1 在 Steel 容器内查看 cookie 落盘路径

```bash
# 先 navigate 一个登录态站点（公开站，example.com 不设置 cookie，换 github.com 验）
# 经 MCP：steel tool navigate https://github.com/

docker exec steel-browser find / -name "Cookies" -o -name "*.cookie" 2>/dev/null
# 期望：cookie 落盘路径都在容器内（如 /app/.../Default/Cookies 或 userDataDir）
```

### 4.2 验 cookie 没出本机（外网抓包对照）

```bash
# 在另一终端用 wireshark / tcpdump 抓本机 3000/9223 之外的网出流量
# 期望：Steel 容器出网流量是 Chrome 加载目标站点（github.com）；
#       没有任何流量把 cookie 数据发到 Steel 云端（Steel 是自托管，无云端）
```

**对照 BrowserbaseChannel**：Browserbase Chrome 在云端，cookie 物理离开本机。Steel cookie 留在用户 Docker 容器内（对 INV-48..53 cookie=身份红线极友好）。

---

## 5. Steel 自带反检测可见（parse14 §6.1 #6）

### 5.1 steel tool 访问 bot.sannysoft.com

```json
{"name": "steel", "arguments": {"url": "https://bot.sannysoft.com/test_data/", "action": "extract"}}
```

**期望**：data.preview 含 `WebDriver: Na (pass)` 等 13 项基础检测通过指标（Steel 自带 fingerprint-generator + stealth plugins 强于 Browserbase 依赖 Lasso StealthEngine 注入）。

### 5.2 对照 v1.5 HeadlessChannel + StealthEngine

```json
{"name": "browse_headless", "arguments": {"url": "https://bot.sannysoft.com/test_data/", "action": "extract"}}
```

**期望**：HeadlessChannel + StealthEngine 16 路（v1.5）通过基础检测；SteelChannel 应至少同等水平（parse14 §4.4 Steel 自带 fingerprint-generator）。

---

## 6. 与 BrowserbaseChannel 切换（parse14 §1.2 痛点对照）

### 6.1 两个 cloud 通道并存

```bash
export LASSO_ALLOW_CLOUD_BROWSER=true
export STEEL_ENDPOINT=http://localhost:3000
export BROWSERBASE_API_KEY=<your-browserbase-key>  # 可选；无 key 则只 steel 注册
node dist/index.js 2>lasso-v16-both.log &
```

**期望**：`tools/list` 含 `browserbase` + `steel` 两个工具（双重解锁下都注册）。

### 6.2 切换使用

CC / 用户据需求选：
- **browserbase**：当本机不能跑 Docker / 需云端弹性（付费 SaaS）
- **steel**：当要零成本 + cookie 不出本地（自托管 Docker）

### 6.3 痛点 1 对照（per-session 费）

```bash
# 用 browserbase 调 10 次 → 看 browserbase credits 减少
# 用 steel 调 10 次 → Steel 不计费（自托管 Docker；session.service.ts sessionStats.creditsUsed=0）
```

**期望**：steel 调用对 Lasso 用户零成本（仅本机 Docker 资源）。

### 6.4 痛点 2 对照（cookie 出本地）

```bash
# browserbase：Chrome 在云端，cookie 物理离开本机
# steel：Chrome 在本机 Docker，cookie 留在容器内
docker exec steel-browser ls -la /app/data/user-data-dir/Default/Cookies 2>/dev/null
# 期望：cookies 文件在容器内（用户域），不在外部云
```

---

## 7. 回滚验证（生产就绪闸门 parse14 §1.5 项 5）

### 7.1 删 STEEL_ENDPOINT → 行为等价 v1.5

```bash
unset STEEL_ENDPOINT
node dist/index.js 2>lasso-v16-rollback.log &
# 期望：steel tool 不注册；其他 13 工具 byte-identical v1.5 行为
```

### 7.2 删 LASSO_ALLOW_CLOUD_BROWSER → cloud 全关（v1.5 默认）

```bash
unset LASSO_ALLOW_CLOUD_BROWSER
node dist/index.js 2>lasso-v16-cloud-off.log &
# 期望：browserbase + steel 都不注册；byte-identical v0.3.5 cloud off 行为
```

---

## 8. INV-74 零回归守卫验证

### 8.1 grep 验 SteelChannel extends BrowseChannel

```bash
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
grep "class SteelChannel extends BrowseChannel" src/channels/SteelChannel.ts
# 期望：1 行命中（INV-74 (d) 守）
```

### 8.2 grep 验 STEEL 不进 BUILTIN_PROVIDERS

```bash
grep -A 7 "BUILTIN_PROVIDERS.*=" src/config/providers.ts | grep -E "STEEL|BROWSERBASE|STAGEHAND"
# 期望：无命中（STEEL/BROWSERBASE/STAGEHAND 都不进 BUILTIN_PROVIDERS；零回归承诺）
```

### 8.3 INV-74 自动化检查

```bash
npm run check-invariants 2>&1 | grep "INV-74"
# 期望：PASS  INV-74-steel-cloud-channel-zero-regression
```

---

## 9. 通过判定

| 项 | 通过标准 | 状态 |
|---|---|---|
| §1 Steel Docker 启动 | /health 返 {status:ok} + 9223 CDP 可达 | ☐ |
| §2 doctor #37 | 默认 OFF pass / 双重解锁 pass / 未配 warn / 不可达 warn | ☐ |
| §3.3 真实 navigate | outcome=worked + served_by=browse_cloud_steel | ☐ |
| §3.4 真实 extract | retrieval_method=cloud_steel | ☐ |
| §3.5 真实 screenshot | data.screenshot 路径非空 | ☐ |
| §3.6 单例 session mutex | 日志 steel_session_acquired 仅 1 次 | ☐ |
| §4 cookie 不出本地 | cookie 落盘路径在容器内 | ☐ |
| §5 Steel 反检测可见 | bot.sannysoft 基础检测通过 | ☐ |
| §6 与 BrowserbaseChannel 切换 | 两通道并存 + 切换正常 | ☐ |
| §7 回滚验证 | 删 env → 行为等价 v1.5 | ☐ |
| §8 INV-74 守卫 | grep + check-invariants 全绿 | ☐ |

全过 → v1.6.0 SteelChannel 生产可用。

---

## 10. 失败排查

| 症状 | 可能原因 | 排查 |
|---|---|---|
| doctor #37 status=warn "不可达" | Steel Docker 未启 / 3000 端口未暴露 | `docker ps` + `curl http://localhost:3000/health` |
| steel tool 调用返 cloud_browser_requires_manual_switch | LASSO_ALLOW_CLOUD_BROWSER=false | `echo $LASSO_ALLOW_CLOUD_BROWSER` 应是 true |
| steel tool 调用返 cloud_browser_missing_api_key:steel | STEEL_ENDPOINT 未设 | `echo $STEEL_ENDPOINT` 应是 http://localhost:3000 |
| steel tool 调用返 steel_no_endpoint | SteelChannel 构造时 endpoint 为空（装配期读 env 失败） | 重启 Lasso 前确认 env 在 shell 中 export |
| 并发调用日志含多次 steel_session_acquired | mutex 失效（不应发生） | 查 SteelChannel.ts sessionLock + acquireSessionLock 实现；上报 bug |
| chrome-devtools-mcp 连 9223 失败 | nginx 9223 proxy 未启 / Chrome 内部 9222 down | `docker logs steel-browser` + `curl http://localhost:9223/json/version` |
| cookie 落盘路径在容器外 | 用户配 STEEL_CDP_ENDPOINT 指外部 Steel / Steel 挂载 userDataDir 到主机（用户主动配） | 查 docker run -v 挂载；正常路径在容器 /app 内 |

---

**手测完成后**：勾选 §9 表 + 签名 + 日期。本清单归档为 v1.6.0 release 证据（类比 v1.0/v1.5 acceptance 清单）。

parse14-acceptance 结束。
