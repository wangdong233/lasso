# 方案：login_bridge——远端无头浏览器登录接力（v1 定稿），2026-10-17

> 需求（用户裁决的产品形态）：Linux 机跑 lasso，agent 遇登录墙 → lasso 吐一条 URL → 用户 Mac 浏览器打开亲手登录 → Linux 侧自动识别登录完成 → 无头浏览器带登录态续跑。**Mac 侧零操作是硬需求**（ssh -L 手动隧道被否）。
> 流程：飞轮制。F1 调研（doc/调研-远端无头浏览器登录接力-2026-10-17.md 四路白盒）→ F2 反方对抗（本文件§一）→ F3 简单架构判定（§四）→ F4 测试用例先行（§六）。实施待用户 GO。

## 一、F2 反方裁决（要点，全表见评审记录）

| 攻击点 | 裁决 | 后果 |
|---|---|---|
| token-in-path HTTP relay | **击穿** | Chrome 的 ws URL 从 Host 头生成——token 剥离后二次连接必 401；修复需逐 body 重写≈400 行无测试基因 → **token 门整组件砍**，哑 TCP 转发替代 |
| 哑 TCP 转发等价性 | 成立 | 字节透传使 discovery/ws 全链 Host 自洽（`grep createServer src/`=0——relay 是 lasso **首个入站监听**，posture 级变化，须 INV+默认 off） |
| 二进制来源 | **击穿** | chrome-paths.ts:9 明书不下载；stock Ubuntu chromium=snap 不覆盖；puppeteer 缓存仅 headless 通道先跑过才存在且版本随 LOCKED 漂移 → 需显式发现序+doctor 检+诚实错误 |
| UX | 收窄 | devtools-frontend 无自动 screencast 参数 → 保留三步操作（开 URL→点目标→切投屏），工具输出必须带中文指引+死穴披露；CJK/密码管理器死穴不可解 |
| 检测误报 | 收窄 | `__cf_bm`/`cf_clearance` 轮换+SSO 多跳污染按域 diff → 字段改名 `cookieDelta`+噪声名单，禁用 `loginLikely` 诱导性命名 |
| 语义漂移 | 收窄 | LoggedInChannel 头注释语义=「用户自己的 Chrome」→ 指向 lasso 自起 Chrome 是**新档**，头注释/README/doctor 三面必须同步，禁偷换 |
| token 落 transcript | 随 token 砍消解 | 哑转发无 token；tailnet 私有性=唯一防线（须文档红线+ACL 建议） |
| 生命周期 | 收窄 | 登录等待期 touch 源=status 轮询；relay 关闭条件=「无活跃 TCP+idle」而非「检测到登录」（用户可能还要登第二站） |
| 多会话并行 | 收窄 | profile 按 agent/task 命名空间化（默认同名=cookie 互相污染） |
| Google 风控 | 收窄 | 云 IP 信誉问题 Xvfb 也解不了 → phase2 承诺降级为「技术形态可用，账号区域/信誉风险自担」 |
| 新风险 N1 | 采纳 | 云 Linux 无 keyring → 登录 profile cookie 明文落盘，与 CookieStore AES-GCM（INV-48/49/51）姿势倒退 → 文档披露+可选关闭即删 |

## 二、最终架构 v1（组件级）

```
[Mac 浏览器] ←tailnet→ [lasso relay(哑TCP)] →127.0.0.1→ [登录档 Chrome(持久profile+CDP)] ←attach← [browse_logged_in 续跑]
```

### C1 登录档 Chrome（render-launcher 姊妹档）
- spawn：复用 render-launcher 骨架（ensure/单飞锁/台账/收尸委托）；旗标差：`--headless=new` + **持久 profile** `~/.cache/lasso/login-chrome-profile/<ns>` + `--remote-debugging-port=<随机高位>` + `--remote-allow-origins=http://<ts-ip>:<relay-port>`（精确 IP 字面量，launch-chrome.ts:85 extraArgs 通路）。
- 二进制发现序：chrome-paths 三平台 → puppeteer 缓存（`~/.cache/puppeteer/chrome/`，标注版本随 LOCKED_CDP_MCP_VERSION 漂移）→ 全 miss=诚实错误+安装指引（禁自动下载）。
- 多会话：`<ns>` 默认=default，`LASSO_LOGIN_BRIDGE_NS` 命名空间；同 ns 复用门沿用 render 四条件。
- touch：**status 轮询=唯一 touch 源**（spec 显式）；idle 帽沿用台账默认。

### C2 哑 TCP 转发（node:net，~30 行）
- `net.createServer` 双向 pipe；**只绑 tailscale 接口 IP（禁 0.0.0.0）**；独立 idle 计时（活跃 TCP 连接=活着；无连接+10min→自动关）；无解析无 token 无改写。
- 生命周期独立于 Chrome（relay 关≠Chrome 死）。

### C3 URL 生成与指引
- `tailscale ip -4` CLI 探测（v4 优先；v6 备选枚举）→ 失败/覆写走 `LASSO_LOGIN_BRIDGE_HOST`。
- 工具输出：`http://<ip>:<relay-port>/` + **中文操作指引**（① 点开链接 ② 点击页面目标 ③ DevTools 设备工具栏开投屏 ④ 登录后回来告诉 agent）+ 死穴披露（中文输入法/密码管理器不可用，请手输 ASCII 密码）。

### C4 登录检测（既有 CdpClient 复用）
- `Storage.getCookies` 轮询（bridge 活跃期每 ~3s）按域 diff；**噪声名单**（`__cf_bm`/`cf_clearance`/`_ga`/`_gid` 等）过滤；输出 `cookieDelta`（域名→新增数）+`lastActivity`——明标启发式，agent 终判。

### C5 续跑（零新代码）
- 既有 `browse_logged_in --browser-url=http://localhost:<cdp-port>` attach（LoggedInChannel.ts:233）+ `LASSO_CDP_PORT` 热生效；**三面同步新档语义**（头注释/README/doctor）。

### C6 doctor 检查 `login_bridge`
- 二进制发现结果/tailscale 接口探测/profile 状态/明文 cookie 落盘披露行/relay 绑定面。

## 三、工具面契约（新工具 `login_bridge`）

- action 枚举（照 download 范式）：`start`（返回 url+指引+cdpPort+bridgeId）/ `status`（cookieDelta/lastActivity/relay 活跃/touch）/ `stop`（关 relay；Chrome 交台账常规回收）。
- **默认 env 门控 off**：`LASSO_LOGIN_BRIDGE=1` 才注册/可用（未设时调用=明确错误教 env，照 INV-25 句式）。
- description 必含：生效前提（Linux+tailnet）、安全披露（relay 无鉴权=tailnet 内任意进程可全控该 Chrome，建议 Tailscale ACL）、Google 系不稳披露、明文 cookie 披露。

## 四、简单架构判定（L 系过检）

| 规则 | 判定 |
|---|---|
| L2-01 长驻三件套 | ✅ Chrome 沿台账+touch+收尸；relay 有 idle 收敛出口 |
| L2-03 生命周期解耦 | ✅ relay/Chrome 独立；spec 显式 touch 源 |
| L2-04 劣化可感知 | ✅ doctor #login_bridge |
| L3-01 description=行为 | ✅ 生效面/死穴/安全披露进 description |
| L3-04 契约名 | ⚠️ 实施时冻结：`login_bridge`/`cookieDelta`/`cdpPort` 字段名即契约 |
| L4-01 永不 kill 用户资产 | ✅ 只收自己 spawn 的登录档 |
| L4-02 永不代用户决定 | ✅ 默认 off；无自动下载；禁 funnel 文档化 |
| 加法/砍法 | **加 4 砍 3**：加=哑 relay(30行)+spawn 档变体+cookieDelta 纯函数+doctor 检；砍=token 门+landing 页+deep-link 服务化（F2 §1.1/§3 定谳） |

## 五、安全红线（实施时进 INV）
1. relay 禁 0.0.0.0，必须绑 tailscale 接口 IP 或 `LASSO_LOGIN_BRIDGE_HOST` 显式值。
2. `--remote-allow-origins` 精确 `http://<ip>:<port>` 字面量，禁域名禁通配。
3. 默认 off（env 门控）——公开包不得新增常开监听面。
4. 明文 cookie 落盘披露+`stop --wipe`（关闭即删 profile）选项。
5. funnel 场景文档禁用。

## 六、F4 测试用例（先行冻结）
1. **哑 relay 字节透传**：两 net server 对穿（含二进制帧/半包/断连）。
2. **Host 自洽 e2e（本地可跑）**：起登录档 Chrome+relay → 经 relay `curl /json/list` → 断言 ws URL host=relay 端口（token 方案被砍的根因即此测试的通过条件）。
3. **allow-origins 推导纯函数**：v4 优先/v6/多网卡/env 覆写/全 miss 错误形态。
4. **cookieDelta 纯函数**：噪声名单过滤/SSO 多域/登录前存量 cookie 不误报增量。
5. **默认 off 守卫**（负向）：未设 env 时工具不注册/调用即教 env 错误。
6. **生命周期**：DI 注入（bug04 范式）——status 轮询打 touch/relay idle 自关/stop 后台账态。
7. **INV 新增**：禁 0.0.0.0 监听断言 + relay 绑定值静态检查。
8. **契约守卫**：LoggedInChannel 头注释含新档语义；description 含安全披露句。

## 七、评审门与真机验收
- gate 全量（基线=已知 doctor #32 4 红）+ fresh agent 审查（指派含 doc/usage/05 与本文件）。
- **jd-cloud-linux 真机验收**（对应调研§七清单）：start→Mac 开 URL 三步登录→cookieDelta 增→attach 续跑带登录态→stop/--wipe。
- 文档三面同步：README（双语）/KEY-GUIDE/TROUBLESHOOTING。

## 八、Phase2 缓清单（不进 v1）
token 门（共享 tailnet 威胁模型出现再做，且须先解 Host 生成结构性矛盾——候选=反向代理层注入 Basic Auth 或 CDP 前置鉴权代理）/ Xvfb headed 档（Google 技术形态，账号信誉风险自担披露）/ 多 profile 管理面 / tailscale serve 集成（Host 头行为先实测）。

## 九、飞轮自审
1. F2 的 Host 头发现把 v0 四组件砍到一件——**哑管道的正确性来自「不聪明」**，与 02 清单「最简单的正确形态」直接互证。
2. relay=lasso 首个入站监听（createServer=0 实测）——posture 变化被显式识别并配 INV+默认 off，未滑进「顺手就加了」。
3. 本方案与调研文档构成完整证据链；实施轮直接从 §二/§六 起步，无需重新侦察。
