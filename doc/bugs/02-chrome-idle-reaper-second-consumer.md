# 问题报告:chrome-idle-reaper 误杀外部 CDP 消费者的 Chrome(第二消费者盲区)

> 发现日期:2026-08-26 · 发现环境:Claude Code(VSCode extension)Bash 工具内 CLI 拉起 + media-gen-mcp FlowProvider CDP 直连消费 · 严重级:**高**(外部消费者场景下 Chrome 稳定存活仅 ~60-75s,连接反复中断;lasso 自身 browse 通道不受影响)

## 1. 现象

- `lasso launch-chrome --port 9223`(默认 hidden 档)拉起的 Chrome,在宿主(Claude Code Bash 工具)的**工具调用间隙死亡**:稳定存活约 60-75 秒,随后 CDP 9223 `ECONNREFUSED`/S100
- 死亡与"哪个命令拉起"无关、与 Chrome 是否有打开的 page target 无关(已打开 labs.google 项目页仍被杀);本日实测 5+ 次全部复现
- 死后台账 `~/.cache/lasso/launched-chromes.json` 变回 `[]`(记录被删——stopLaunchedChromes 的删账行为)

## 2. 根因(白盒链,非猜测)

**不是** spawn/detached/宿主进程组回收问题(launch 是 detached + unref,reaper 注释自证 §1.4)。真凶是 lasso 自身的 **chrome-idle-reaper**(v1.10 parse18 §2 机制一):

1. **常驻 lasso MCP server 装配了 reaper**(`src/index.ts:477`):15s tick 读台账;本会话 CC 的 lasso MCP server 一直在跑 → 即使 Chrome 是从 Bash 里 CLI 拉起的,reaper 也看得见台账记录(台账是磁盘共享的单一数据面)
2. **LAUNCH_IDLE_MS 默认 60s**(`src/index.ts:470` 注释):hidden 档 Chrome 的"用完即关"设计语义
3. **touch 活动源唯一**:`LoggedInChannel` 每次 browse 经注入回调 `onChromeUse → touch(port)`(`chrome-idle-reaper.ts:18`)。**media-gen-mcp FlowProvider 这类外部 CDP 直连消费者对 reaper 完全不可见**——touchMap 永无记录 → `lastUse = launchedAt`
4. `now - lastUse > 60s` → 首个 15s tick 命中 → `stopLaunchedChromes({port})` 树杀 + 删账(`chrome-idle-reaper.ts:196-205`)

时间线完全吻合:存活 60-75s = idle 60s + tick 相位差 0-15s。

## 3. 定性

**by-design 机制与第二消费者的组合盲区,不是实现 bug**。reaper 的设计假设是"launched Chrome 的唯一消费者是 lasso 自己的 browse 通道";台账(磁盘共享)与 reaper(server 进程内)的分离使 CLI 拉起的 Chrome 也落入 server reaper 的管辖,而外部消费者零活动信号。这正是 `chrome-idle-reaper.ts:19` 自己引用的 **R-INT-07(运行时 mutable state 多消费者耦合)** 的活案例——touchMap 单写多读形态防的是 reaper/Channel 之间的写冲突,没有防"写者之外还有整个消费维度"。

同类先例:zombie reaper 管 procs(MCP shim→node 树)与 chrome reaper 管 ledger(detached Chrome)的两数据域分工(parse18)本身承认了"消费形态多样",但活动信号的扩展没有跟上。

## 4. 复现

```bash
# 前提:一个常驻 lasso MCP server 在跑(CC 会话内即满足)
cd lasso && node dist/index.js launch-chrome --port 9223   # 默认 hidden + 全局 idle 60s
sleep 1  # 打开 page target(证明"有页面"不影响)
node -e "..."  # 任意 CDP 直连操作
# 之后不再有任何 lasso browse 调用 → 60-75s 后:
curl http://127.0.0.1:9223/json/version   # ECONNREFUSED
cat ~/.cache/lasso/launched-chromes.json  # []
```

## 5. 缓解(已验证)

拉起时**record 级禁用收割**:

```bash
node dist/index.js launch-chrome --port 9223 --idle-ms 0
# 台账记录写 "idleMs": 0 → reaper tick 里 idleMs<=0 直接 continue,永不收割
# 或全局:env LASSO_LAUNCH_IDLE_MS=0(影响所有 launched Chrome,粒度粗)
```

实测 `--idle-ms 0` 后台账记录 `{"port":9223,...,"idleMs":0}`,Chrome 跨宿主多个工具调用持续存活(本报告附带的后续 media-gen 验证链全程依赖此缓解,90s+ 不死)。

## 6. 修复建议(lasso 侧,供裁决)

1. **文档级(最小成本,立即)**:`launch-chrome --help` 与 README 的 launch-chrome 章节显著标注——"Chrome 将被**非 lasso browse 通道**消费(外部 CDP 直连/自动化)时,必须 `--idle-ms 0`,否则 60s 后被 server 端 idle reaper 回收"。当前 `--help` 无此警示。
2. **语义级(建议)**:CLI **显式**拉起(用户手敲命令)与 server 内部自动拉起的语义区分——CLI 显式拉起默认写 `idleMs: 0`(用户显式要的 Chrome 不该被后台静默回收),server 自动补的维持 60s 用完即关。变化面:launch-chrome.ts 写台账处(473/502/545)默认值来源分级。
3. **结构级(长期,R-INT-07 正解)**:touch 活动源泛化——例如台账记录支持外部 touch(约定文件 `~/.cache/lasso/chrome-touch-<port>` mtime 即活动信号,reaper tick 顺带 stat),让第二消费者有一等信号通道而不是绕过收割。
4. **错误面**:CDP 断连错误(S103 类)的 hint 文案补一句"若 Chrome 由 lasso 拉起且超过 60s 无 browse 活动,可能已被 idle reaper 回收;外部消费场景请 `--idle-ms 0` 重新拉起"——把这类死亡从"神秘断连"变成自解释。

## 7. 时间线

- 2026-08-26 下午:media-gen-mcp Flow 渠道 live 验证过程中,Chrome 反复"活一个调用就死",最初误判为宿主 Bash 进程组回收(错误假设,已在 §2 澄清)
- 白盒定位:读 chrome-idle-reaper.ts → 60s 默认 + touch 唯一源 → 台账删除实锤 → `--idle-ms 0` 验证存活
- 本报告归档;media-gen-mcp 侧的 Flow 契约/文档同步改用 `--idle-ms 0` 启动命令

## 8. 关联

- media-gen-mcp FlowProvider(外部 CDP 消费者)契约 `doc/flow-api-contract.md` 启动命令已同步 `--idle-ms 0`
- R-INT-07(架构想法/02_简单架构清单.md)又一实证:运行时 mutable state(touchMap)的多消费者耦合,单写多读不够,还得防"未知消费者维度"
