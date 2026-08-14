# Wave1 执行记录 — 入口与 CLI 面板

- **执行人**：lasso 功能验证执行员（Claude subagent）
- **执行时间**：2026-08-15（命令时间戳为 2026-08-14T18:00–18:07Z，本机时区 +8）
- **环境**：macOS Darwin 21.6.0 / Node v24.12.0 / npm 11.6.2 / cwd = 仓库根 `/Users/wangdong/Documents/Project/cc-control-all/lasso` / dist 为 1.7.0 最新构建 / 本机经代理（fake-ip TUN）
- **MCP 客户端**：`doc/17-执行记录/mcp.mjs`（SDK @modelcontextprotocol/sdk 1.29.0，Client + StdioClientTransport，spawn `node dist/index.js`，stderr 追加至 `doc/17-执行记录/server-stderr.log`；tools/list 自检通过，14 工具）
- **key 状态**：零 key 环境（zhipu/brave/bing 均未配）；`~/.claude.json` 机器 MCP web-search-prime 命中（doctor #30 pass）；TCC Accessibility/Screen Recording 均已授权；rust helper 运行中

---

## 逐条结果

### T-ENTRY-01 — stdio 启动 / 优雅停机
- **verdict**: **pass**
- **实际观察**：
  - MCP 握手成功：`node mcp.mjs tools-list` 返回 14 工具（search/browse_headless/browse_logged_in/desktop/fetch_url/screenshot/pdf/network/wayback_lookup/doctor/interact_roots/interact_observe/interact_act/admin），exit 0。
  - stderr 结构化日志齐备（server-stderr.log）：
    - `{"evt":"lasso_start",...,"version":"1.7.0",...,"cdp_port":9222}`
    - `{"evt":"lasso_ready","run_id":"c62cebb3-..."}`
    - 装配链日志：`machine_search_mcp_detected: detected=true`、`brave_channel_skipped`、`bing_channel_skipped`、`cloud_browser_channels_skipped reason=manual_switch_off_default`、`hot_reload_skipped reason=no_providers_file`、`v0.6_runtime_wired bag_size=8 tool_manager_size=14`。
  - SIGTERM 测试（`node /tmp/entry01-sigterm.mjs`：spawn → 见 lasso_ready → kill SIGTERM）：`EXIT code=0 signal=null`，退出前 stderr 落 `{"evt":"lasso_shutdown","sig":"SIGTERM","run_id":"98e2dafa-..."}`。
- **用例判定**：用例正确，产品行为符合预期（握手 / lasso_start+lasso_ready / SIGTERM exit 0）。

### T-CLI-04 — 版本对齐（INV-63）
- **verdict**: **pass**
- **实际观察**：doctor JSON `lasso_version: "1.7.0"`（CLI 与 MCP doctor 两份输出均同）；`package.json` version `"1.7.0"`；`src/index.ts:178 const LASSO_SERVER_VERSION = "1.7.0"`。三处一致。
- **用例判定**：用例正确。

### T-CLI-05 — `--stealth-check` 承诺落空（D11 采证）
- **verdict**: **pass**（预期缺陷行为命中，按清单写法判 pass）
- **实际观察**：
  - `node dist/index.js doctor` exit 1（ready=false，环境性 blocker）；`node dist/index.js doctor --stealth-check` exit 1。
  - 两份输出 diff 仅 8 行差异，全部为 `timestamp` 与 markdown smoke 耗时（371ms vs 730ms）——flag 对报告内容零影响。
  - `stealth_creepjs_regression` 在带 flag 时仍为：`status: "warn", detail: "skipped (stealthCheck=false；opt-in via --stealth-check 开启 creepjs 回归门禁)"`（detail 自述的开关实际未被解析）。
- **D11 证据链**：README 承诺的 flag 被 `main()` 完全忽略 → doctorOpts 永不注入 stealthCheck → #38 恒 warn-skip。CLI 与 MCP 两模式均确认不实跑（MCP doctor 输出同样 warn-skip）。
- **用例判定**：用例正确（预期写的就是"被忽略+输出一致"）。

### T-TOOLS-13 — read_text 缺席（D1 采证）
- **verdict**: **pass**（预期缺陷行为命中）
- **实际观察**（tools/list 全量 description 扫描，`tools-full.json`）：
  - 14 工具中 **无 read_text**（`read_text present: false`）。
  - description 指向 read_text 的行恰好 **6 处 / 4 个工具**：
    - `fetch_url`（1）：`...carries a 16 KiB preview + ref — read_text({ref:@oN, offset}).`
    - `screenshot`（2）：`small — read the file with read_text or open it directly.` / `return base64 PNG (only the file path; use read_text or shell to view)`
    - `pdf`（2）：`spill file with read_text({ref:@oN, offset}) and base64-decode locally.` ×2
    - `network`（1）：`...read the spill file with read_text({ref:@oN, offset}).`
- **用例判定**：用例正确，6 处指向与 D1 描述完全一致。

### T-CLI-01 — doctor 全量（CLI 模式）
- **verdict**: **pass**
- **实际观察**（`node dist/index.js doctor`，exit 1=ready:false 语义正确）：
  - 顶层 `ready / timestamp / lasso_version / checks / blockers` 齐备；`lasso_version:"1.7.0"`。
  - **CLI 模式 checks=33**（pass 24 / fail 2 / warn 7），`blockers=["zhipu_api_key","cdp_9222_logged_in"]`（本机零 key + 9222 返回 404，环境性）；ready=false → exit 1，映射源码 `process.exit(report.ready ? 0 : 1)`（index.ts:235）。
  - 对照 MCP doctor 工具（desktopChecks=true）：**checks=39**（pass 31 / fail 2 / warn 6），6 项 desktop check（rust_helper_signed/​rust_helper_running/​tcc_accessibility/​tcc_screen_recording/​ax_read_rate/​vlm_endpoint_reachable）在 MCP 模式全部出现（helper ping pass、TCC 双授权 pass、签名 warn、ax_read_rate warn、vlm warn）。
  - config 文件 key 正确反映到报告（见 T-CONFIG-01a）。
- **用例判定（含口径微差）**：用例核心正确（39 项全集存在于 doctor；CLI 不跑 desktop 组属设计）。**措辞差异**：清单称 CLI 模式 #15-#20 "恒为 warn-skip"，实测 CLI 模式下这 6 项**整体缺席**（33 项，不生成 warn 行）；CLI 里真正 warn-skip 的是 profiles 三项（#22-24 "skipped (profilesChecksProvider not injected)"）与 stealth #32。设计意图一致，非产品缺陷，建议清单再版时把"warn-skip"改为"缺席"。

### T-CONFIG-01 — config 文件机制（file 生效 / env 覆盖 / 坏 JSON）
- **verdict**: **pass**
- **实际观察**：
  - **file key 生效**：`{"ZHIPU_API_KEY":"file-key-test-12345"}` + `LASSO_CONFIG_PATH` → doctor `zhipu_api_key: pass "已配置（有效性未深测）"`，`config_file: pass "...存在；加载 1 个 key..."`；key 明文不出现在报告任何位置（全文扫描无命中）。
  - **env 覆盖 file**：file `LASSO_CDP_PORT=9225` → server 启动日志 `cdp_port:9225`；叠加 env `LASSO_CDP_PORT=9226` → `cdp_port:9226`（经 mcp.mjs 启动的真实 server stderr 证实）。
  - **坏 JSON**：`{ invalid json !!!` → doctor 正常输出 33 项完整报告不崩；stderr 落 `{"level":"warn","evt":"config_file_parse_error",...}`；`config_file` check 显示 pass "加载 0 个 key"（坏文件作空对象处理）。
  - 佐证：`npx vitest run test/unit/config-file.spec.ts` **28/28 pass**（含 env 覆盖 file、_comment 跳过、boolean/number 规范化）。
- **用例判定**：用例正确。注：坏 JSON 场景 warn 落在 stderr 日志而非 config_file check 的 status（check 仍 pass）——满足"只 warn 不崩"，记录为观察。

### T-CONFIG-02 — config init
- **verdict**: **pass**
- **实际观察**（`LASSO_CONFIG_PATH=/tmp/lasso-t/config.json`）：
  - 第一次：`Created config template at:\n  /tmp/lasso-t/config.json`，exit 0。
  - 第二次：`Config file already exists (not overwritten):`，exit 0，文件内容未被改写（仍 16 键、ZHIPU_API_KEY==""）。
  - 模板 **15 个配置 key**（+1 `_comment`）：ZHIPU_API_KEY/BRAVE_API_KEYS/BING_API_KEYS/LASSO_ALLOW_CLOUD_BROWSER/BROWSERBASE_API_KEY/STAGEHAND_API_KEY/LASSO_COOKIE_PASSPHRASE/ZHIPU_ENDPOINT/LASSO_CDP_PORT/LASSO_CACHE_DIR/LASSO_SEARCH_FREE_ONLY/LASSO_VLM_ENDPOINT/LASSO_RECORD_SEARCH/LASSO_CALLER_CAP_DEFAULT/LASSO_PROVIDERS_FILE —— 满足"15+ key"。
- **用例判定**：用例正确。

### T-CONFIG-03 — config path
- **verdict**: **pass**
- **实际观察**：
  - `config path` + `LASSO_CONFIG_PATH`：`/tmp/lasso-t/config.json (exists)`，exit 0。
  - `config path`（默认）：`/Users/wangdong/.lasso/config.json (not found)` + 创建指引，exit 0。
  - `config`（无子命令）：stderr 打印 usage（`usage: lasso-mcp config <init|path>`），**exit 1**（首测被管道 grep 掩盖，复测直接捕获确认 exit=1）。
- **用例判定**：用例正确。附带观察：任意未知子命令（如 `badsubcmd`）不报 usage，直接落入 MCP server 模式（lasso_start 后随 stdin 关闭 exit 0）——与 F-CLI-01 同根（argv 只白名单识别 4 个子命令），记录为观察非缺陷。

### T-CONFIG-07 — 运行参数 env 边界
- **verdict**: **pass**
- **实际观察**：`LASSO_SEARCH_FREE_ONLY=L9 LASSO_CDP_PORT=abc` 同时设置：
  - `doctor` 正常输出 33 项完整报告（exit 1 为既有 blocker，与此 env 无关），无崩溃。
  - server 经 mcp.mjs 正常启动并返回 tools-list（exit 0）。
  - 源码佐证：config.ts:273-278 `["L1","L2","L3","L4"].includes(rawFreeOnly) ? raw : "L4"`（L9 静默回落 L4）；`parseInt("abc")` → NaN 由下游兜底。
- **用例判定**：用例正确（"不崩"即核心断言；回落值属内部状态，外部不可观，以源码+不崩双证）。

### T-CONFIG-08 — ProviderRegistry
- **verdict**: **pass**
- **实际观察**：
  - doctor #12 `provider_registry_loadable: pass "4 providers loaded: zhipu, browse_headless, browse_logged_in, brave"`。
  - 单测 `npx vitest run test/integration/provider-registry.spec.ts` **17/17 pass**；`runtime-hot-plug.test.ts` **10/10 pass**。
  - add 重名/remove 语义活体验证（直调 dist/config/provider-registry.js）：
    ```
    dup add throws: Error: ProviderRegistry: x already registered
    remove missing returns: false
    remove existing returns: true
    ```
- **用例判定**：用例正确。注：add 重名/remove 不存在两个断言**无既有单测覆盖**（本面板用活体直调补证），建议后续补进 provider-registry.spec.ts。

### T-CONFIG-09 — 内置 provider 表
- **verdict**: **pass**
- **实际观察**：src/config/providers.ts `BUILTIN_PROVIDERS = [ZHIPU, BROWSE_HEADLESS, BROWSE_LOGGED_IN, BRAVE, TAVILY_WATCH]`（5 项，tavily enabled=false）；doctor #12 输出 4 loaded（tavily 被 skip，与 doctor.ts:1095-1099 逻辑一致）；单测断言同口径（spec #52/#59 "5 个 provider / registry 列表 4 个"）。
- **用例判定**：用例正确。

### T-CLI-03 — replay-baseline（CLI 入口）
- **verdict**: **pass**
- **实际观察**（`node dist/index.js replay-baseline`）：输出 JSON `{"total":6,"pass":6,"warn":0,"fail":0,...}`（baidu=2/bing=2/google=2，hit_rate 全 1），纯本地 fixture 不触网；exit 0。
- doctor 对齐：#26 `recording_baseline_count: pass "6 条 fixture（baidu=2 bing=2 google=2）"` — 与 runner total=6 一致。
- **用例判定**：用例正确。

### T-SEARCH-27 — replay-baseline --strict
- **verdict**: **pass**
- **实际观察**：`node dist/index.js replay-baseline --strict` 输出与 plain 完全一致（diff 空），fail=0 → exit 0。`--strict` 的 exit-1 分支本机无法自然触发（6/6 全 pass），以源码佐证：replay-baseline.ts:273-280 `strict=argv.includes("--strict")` 且 `if ((strict && fail>0) || total===0) process.exit(1)`。
- **用例判定**：用例正确（"fail 非 0 退出"为条件分支，实测 fail=0 → 0 + 源码核对分支逻辑）。

### T-TOOLS-14 — doctor MCP 工具（runtime_state）
- **verdict**: **pass**
- **实际观察**（MCP 调 `doctor {}`，经 mcp.mjs）：
  - 39 项 checks（唯一能跑全量的入口），desktop 6 项全在场。
  - 顶层含 `runtime_state`，子键：`capabilities, caller_caps, tool_manager, metrics, breakers, serp_health, profiles` —— 预期 6 键全 present。
    - capabilities：channel/provider 启停快照（browse_headless... enabled:true）
    - caller_caps: `[]`（冷启动）
    - tool_manager：channel→tools 分组映射（14 工具）
    - metrics: `[]`（未跑流量）
    - breakers：`[{channel:"search.zhipu",kind:"short",state:"closed"},{channel:"search.brave",...},...]`
    - serp_health：`{engines:[{engine:"baidu",hit_rate:1,redesign_suspected:false,...}]}`
  - profiles 仅 stat 元数据：`[{"name":"default","isCurrent":true,"userDataDir":"...","userDataDirExists":true,"userDataDirMode":"0o700","encryptedPackage":{"exists":false}}]` —— 全文无 cookie 字段/值（INV-51 守住）。
- **用例判定**：用例正确。

### F-CLI-01 — `--version` / `--help` 行为（附加）
- **verdict**: **pass**（预期行为命中——记录 UX 证据）
- **实际观察**（stdin=/dev/null，timeout 8s 保护）：
  - `node dist/index.js --version`：**stdout 0 字节**（无版本号输出）；stderr 出现 `lasso_start`（version 1.7.0）+ `lasso_ready` → 进入 MCP server 模式，stdin 关闭后 exit 0。
  - `node dist/index.js --help`：同上，stdout 0 字节，server 挂 stdio。
- **结论**：与预判一致——argv 仅白名单识别 doctor/config/launch-chrome/replay-baseline 四个子命令（index.ts:1074-1098），其余一切参数静默落入 server 模式。**观察建议**：`--version`/`--help` 是 CLI 惯例，当前静默挂起对终端用户不友好（若在交互终端无 client 连接则一直等待），建议后续补 usage/version 输出；不构成本面板 fail。

---

## 统计

| verdict | 计数 |
|---|---|
| pass | 15（T-ENTRY-01、T-CLI-01/03/04/05、T-CONFIG-01/02/03/07/08/09、T-SEARCH-27、T-TOOLS-13/14、F-CLI-01） |
| fail | 0 |
| blocked | 0 |
| waived | 0 |

## 异常与观察汇总（均非 fail）

1. **D11 证据已固化**（T-CLI-05）：`--stealth-check` 被完全忽略，输出 diff 仅 timestamp/耗时；#38 两模式恒 warn-skip。待 README 与源码二选一对齐。
2. **D1 证据已固化**（T-TOOLS-13）：read_text 缺席 + 精确 6 处 description 指向（fetch_url×1 / screenshot×2 / pdf×2 / network×1）。
3. **清单措辞差**（T-CLI-01）：CLI 模式 desktop 6 项是"缺席"（33 项）而非"warn-skip 行"；MCP doctor 模式才是 39 项全量。建议清单再版修正表述。
4. **--strict exit-1 分支未自然触发**（T-SEARCH-27）：6/6 全 pass，分支逻辑以源码佐证（replay-baseline.ts:273-280）。
5. **无覆盖单测**（T-CONFIG-08 子断言）：ProviderRegistry add 重名抛错 / remove 不存在返 false 无既有测试，本次以活体直调 dist 模块补证。
6. **未知子命令静默入 server 模式**（T-CONFIG-03 附带 + F-CLI-01）：argv 白名单外一律当 server 启动；终端用户体验问题，建议补 usage。
7. **执行工具修复**：mcp.mjs 初版被 StdioClientTransport 默认 env 白名单滤掉 LASSO_* 自定义变量（首测 cdp_port 恒 9222 暴露），已加 `env: {...process.env}` 透传并复测通过——后续波次复用本客户端无需再踩。
8. **本机环境事实**（供其他面板引用）：机器 MCP web-search-prime detected=true；TCC Accessibility/Screen Recording 双 pass；rust helper ping pass（v0.1.0）；9222 端口有服务返回 404（非 Chrome CDP，doctor cdp_9222_logged_in fail 属环境）；zhipu/brave/bing 零 key。
