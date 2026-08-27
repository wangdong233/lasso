# BUG 报告:rust-helper 相对路径导致 desktop 通道全挂(subproc_spawn_failed)

> 发现日期:2026-08-22 · 发现环境:Claude Code(VSCode extension)以 stdio 启动 lasso MCP server v1.18.3 · 严重级:**阻断**(desktop 全通道不可用)
>
> **仓迁注(2026-08-27)**:本文档写就时仓在 `/Users/wangdong/Documents/Project/cc-control-all/lasso`,现已迁至 `/Users/wangdong/Documents/Project/claude技能/lasso`——文中出现的旧绝对路径(含 §内 env 注入示例)均为当时历史现场,今已失效勿照抄;`~/.claude.json` 的 `LASSO_RUST_HELPER_PATH` 已由主循环重定位到新仓,且 v1.18.4 根治后该 env 覆盖本身已非必需(见 TROUBLESHOOTING §2.16 rustSpawnGate 四态)。

## 1. 现象

- 任何 `desktop` 工具调用(find/snapshot/act/doctor)返回:`rust_helper_crashed:subproc_spawn_failed`
- `doctor` 输出 3 个 blocker:`rust_helper_running` / `ax_read_rate` / `tcc_accessibility`(后两者是 helper 起不来的连锁)
- `rust_helper_signed` 给出误导性提示:"binary 可能未构建 ./rust-helper/target/release/lasso-rust-helper" —— **实际 binary 存在、可执行、无 quarantine**:
  ```
  $ ls -la rust-helper/target/release/lasso-rust-helper
  -rwxr-xr-x ...                                  # 存在且可执行
  $ ./rust-helper/target/release/lasso-rust-helper --help; echo $?
  0                                               # 手动执行成功
  $ xattr ...                                      # 无 quarantine 属性
  ```

## 2. 根因(白盒链)

### 根因 1(主因):helper 路径是 cwd 相对路径

`src/index.ts:190`:
```ts
const DEFAULT_RUST_HELPER_PATH = "./rust-helper/target/release/lasso-rust-helper";
```
经 `src/index.ts:592` `subproc.registerRustSpec("rust-helper", {...})` 传给 `SubprocessManager.ensureRustRunning`(src/subprocess/SubprocessManager.ts:541 附近)spawn。

相对路径按 **server 进程 cwd** 解析。lasso 被宿主(CC / 任何 MCP client)以 `node /abs/path/lasso/dist/index.js` 启动时,**cwd = 宿主的工作目录**,几乎必然 ≠ lasso 仓库根 → `ENOENT` → **异步 error 事件 reject**（node v24 spawn 对 ENOENT 从不同步 throw；对抗重审实测 ~11ms 即败——本报告初稿「5×backoff ~30s」的说法系事后归因错误，见 §9 勘误）→ `rust_helper_crashed:subproc_spawn_failed` **裸归因**（无路径/无 cwd/无修法提示，无法自诊断）→ RustBridge reject 所有 desktop 调用。真正会烧满 5×backoff（实测 30014ms + 裸消息）的确定性失败是 **ENOEXEC**（binary 存在但损坏/非 Mach-O）——恰在原分类之外。

**证据(现场实测)**:CC 的 lasso 配置 `command: node /Users/wangdong/.../lasso/dist/index.js`,cwd 为 CC 项目目录;同一 binary 从仓库目录手动执行 exit 0;给宿主配置注入 env `LASSO_RUST_HELPER_PATH=<绝对路径>` 后该分支即可绕过(证明 env 优先路径逻辑正常,坏的只是 DEFAULT)。

### 根因 2(次因,独立问题):spawn 路径与 doctor 探测路径脱节

`src/desktop/desktop-doctor-checks.ts:58-59` 的探测列表是 `./rust-helper/...` 与 `../rust-helper/...` **双路径**,而实际 spawn 用的 `DEFAULT_RUST_HELPER_PATH` 只有 `./`(单路径)。导致:doctor 在部分 cwd 下能"看到" binary(走 `../rust-helper` 命中)而 spawn 却 ENOENT —— 诊断与故障源不一致,doctor 报"可能未构建"误导排查方向。

### 附带(非本次阻断因素,但建议一并处理):binary 未签名

`codesign -dv` → `code object is not signed at all`。`build/sign.sh` 注释自述:未 Developer ID 签名的 binary 每次 rebuild 后 cdhash 变 → TCC(Accessibility/Screen Recording/Event Synthesizing)授权失效、重弹授权框。Developer ID 需 Apple 开发者账号($99/年);无账号时至少做 ad-hoc 签名(`codesign -s -`)并在文档标注 TCC 重授权代价。

## 3. 复现

```bash
# 任意非 lasso 仓库目录:
cd /tmp && node /abs/path/to/lasso/dist/index.js   # stdio server 起来后
# 调 desktop doctor → rust_helper_crashed:subproc_spawn_failed
# 对比:cd /abs/path/to/lasso && node dist/index.js → 正常
```

## 4. 修复建议

1. **DEFAULT 路径改为基于 `import.meta.url` 解析**(根治):
   ```ts
   import { fileURLToPath } from "node:url";
   const DEFAULT_RUST_HELPER_PATH = fileURLToPath(
     new URL("../rust-helper/target/release/lasso-rust-helper", import.meta.url)
   );
   ```
   dist/index.js 位于 `dist/`,`../rust-helper/...` 恒指向仓库内 helper,与宿主 cwd 解耦。
2. **统一 spawn 与 doctor 的路径解析**(抽一个 `resolveRustHelperPath()` 单一真源,spawn/doctor/错误信息三处共用;顺带 doctor 的"可能未构建"提示附上实际探测的绝对路径)。
3. **错误信息增强**:`subproc_spawn_failed` 的 reject message 附上"解析到的 helper 路径 + 提示可用 LASSO_RUST_HELPER_PATH 覆盖",把这类环境问题从**裸归因**变成一眼自诊断；对 ENOEXEC 类确定性失败同步消灭 5×backoff ~30s 白烧（§9 勘误：ENOENT 本就不烧 backoff）。
4. **签名**:短期 `codesign --force --sign - <helper>`(ad-hoc)进 build 脚本默认步骤;长期 Developer ID(见 build/sign.sh 既有说明)。
5. **测试**:`SubprocessManager` 补一条"cwd ≠ 仓库根时 helper 可解析"的回归测试(从临时 cwd spawn 断言路径解析)。

## 5. 临时缓解(宿主侧,已实施)

CC 的 `~/.claude.json` lasso 配置已注入:
```json
"env": { "LASSO_RUST_HELPER_PATH": "/Users/wangdong/Documents/Project/cc-control-all/lasso/rust-helper/target/release/lasso-rust-helper" }
```
对已运行的 server 不生效(MCP server 随宿主会话启动);下次会话 desktop 通道即恢复。

## 6. 时间线

- 2026-08-22 14:44 `desktop doctor` 现场:3 blocker,`rust_helper_signed=warn("可能未构建")`
- 白盒定位:binary 实存可执行 → 读 spawn 链(index.ts:190 → SubprocessManager:541)→ cwd 相对路径 ENOENT
- 宿主 env 覆盖缓解实施;本报告归档

## 7. 修复纪要(2026-08-23,§4 五条全量实施)

> 门禁:`npm run build` ✓ / `npm test` **2405 passed + 1 skipped**(基线 2395+1,净增 10 = 新回归 spec)/ `npm run check-invariants` **82/82 INV** ✓。未发版、版本号不动、未 commit(留用户裁决)。

### 7.1 改动面(6 改 3 增,123+/33-)

**新增 `src/subprocess/rust-helper-path.ts`(单一真源)**:
- `DEFAULT_RUST_HELPER_PATH = fileURLToPath(new URL("../../rust-helper/target/release/lasso-rust-helper", import.meta.url))` —— src|dist 的 `subprocess/` 层恒两层深,`../../` 恒落仓库根,**与宿主 cwd 彻底解耦**(根因 1 根治)
- `resolveRustHelperPath(env = process.env)` 三态:env `LASSO_RUST_HELPER_PATH` 非空 → `path.resolve` 绝对(相对值锚定 cwd)/ 回落绝对默认;返回 `{ path, source: "env"|"default" }`(DI 形参,CI 无 rust 环境可测)
- `rustHelperMissingHint(path)`:缺 binary 自诊断文案单一真源(绝对路径 + cwd + cargo build / env 覆盖两种修法)

**`src/index.ts`**:删本地 `"./rust-helper/..."` 相对常量与手写 env 读取 → `resolveRustHelperPath().path` 一行(§4.1/§4.2)。

**`src/subprocess/SubprocessManager.ts`**:
- `_spawnRustWithBackoff` spawn 前 `existsSync(spec.command)` 探测:缺失即抛 `rust_helper_crashed:subproc_spawn_failed — <自诊断>`——归因前缀与 W1-DEF-9 契约一致(既有测试 `/rust_helper_crashed:subproc_spawn_failed/` 断言零回归),**确定性缺文件不进 5×backoff(~30s 白烧)**(§4.3 fail-fast)
- catch 分支补 ENOENT 快退(同步 throw 路径同样不吃 backoff)
- 新增 `getRustSpecCommand(name)`:RustBridge 错误信息取注册真源,不在 bridge 侧二次猜路径

**`src/subprocess/RustBridge.ts`**:`onError` ENOENT 归因附 spec 实际 command + `rustHelperMissingHint`(mock 兼容:`getRustSpecCommand?.()` 可选调用)(§4.3)。

**`src/desktop/desktop-doctor-checks.ts`**:
- 删 `DEFAULT_HELPER_PATHS` 双相对路径列表 → `resolveRustHelperPath().path` 默认(与 spawn 同源,根因 2 根治;DesktopChannel.doctor 未传 helperPath 的路径也自动同源)
- #15 "可能未构建"误导文案 → 存在性二分:`binary 不存在:<abs>` / `binary 存在但无签名输出:<abs>`,detail 恒附绝对探测路径

**签名链(§4.4)**:
- 新增 `scripts/ad-hoc-sign-helper.mjs`:binary 缺失 / 无 codesign(Linux CI)→ 静默 exit 0 不炸构建;已签 Developer ID → 跳过**绝不降级**;否则 `codesign --force --sign -`;实测同字节重签 cdhash 稳定(`c3ba67b2…`,TCC 不因重签失效,仅 rebuild 换字节才失效)
- `package.json` build 链末段挂接该脚本
- `rust-helper/build/sign.sh` 默认分支(LASSO_DEV_ID 未设)从"裸跳过"改为 ad-hoc 兜底签 + 保留 Developer ID 长期注释与 notarization 说明
- 现有 binary 已立即补签:`code object is not signed at all` → `Signature=adhoc / Identifier=lasso-rust-helper-…`

**新增回归 `test/unit/rust-helper-path.spec.ts`(10 测)**:默认绝对解析 + 独立复算对照;`os.tmpdir()` chdir 后路径不变(cwd 解耦);env 覆盖(绝对/相对 resolve/空白回落);源码级断言 index.ts + doctor 双双走 resolver 且 `./`/`../rust-helper/target/` 字面量不回潮 + "binary 可能未构建"文案不回潮;缺 binary fail-fast(<1s、含绝对路径/env 提示/cwd)+ RustBridge 契约保持。

### 7.2 真实复现前后对照(硬标准;`/tmp` 下 stdio 启动 server,调 `desktop(action:"doctor")`,**无** env 覆盖)

| 检查项 | 修复前 | 修复后 |
|---|---|---|
| rust_helper_signed | WARN `binary 可能未构建：./rust-helper/...`(误导) | FAIL(诚实)`binary 已签但非 Developer ID（ad-hoc）：<绝对路径>` + Developer ID next_step |
| rust_helper_running | FAIL `rust_helper_crashed:subproc_spawn_failed` | **PASS `ping ok; helper v0.1.0`**(从 /tmp 成功 spawn) |
| tcc_accessibility | WARN 同 spawn 失败 | **PASS 已授权** |
| tcc_screen_recording | WARN 同 spawn 失败 | **PASS 已授权** |
| ax_read_rate | FAIL 同 spawn 失败 | WARN `仅 1 AX nodes`(真实环境态,非 spawn 故障) |
| tcc_event_synthesizing | WARN 同 spawn 失败 | **PASS not_required** |

- 三个功能性 blocker(running/ax/tcc 连锁)全部消除;剩余 #15 FAIL 是**既有设计的诚实语义**(ad-hoc → TCC 不持久,验收 #7),非本次回归
- env 覆盖契约双向验证:指向缺失路径 → 秒级自诊断(附绝对路径 + `LASSO_RUST_HELPER_PATH` 覆盖提示);指向真实路径 → PASS(CC `~/.claude.json` 临时缓解不受影响,env 优先级不变,**该缓解可保留也可择机移除**)
- 注:CLI `node dist/index.js doctor` 本就不装配 desktop 检查(`desktopChecks=false` 默认),rust_helper 三检查项只在 `desktop(action:"doctor")` 路径出现——复现走的是 MCP stdio 真路径;CLI 从 /tmp 运行亦正常(exit 0)

### 7.3 残留与移交

- #15 ad-hoc=FAIL 会作为单一条 blocker 让 doctor `ready=false`——按既有验收 #7 语义保留;若认为日常开发噪音,可后续单独裁决降 warn(非本次范围)
- ad-hoc 的 TCC 代价:**rebuild(字节变)后 cdhash 变 → TCC 重授权**;长期方案 Developer ID(sign.sh 既留)
- `~/.claude.json` 的 `LASSO_RUST_HELPER_PATH` env 缓解:修复后默认路径已正确,缓解冗余但无害(env 优先契约不变),去留由用户裁决
- 未 commit/push;`scripts/ad-hoc-sign-helper.mjs` 与 `src/subprocess/rust-helper-path.ts` 为 untracked 新文件

## 8. 对抗复审轮 1 纪要(2026-08-23,仲裁 A1 确证缺陷修复)

> 轮次性质:评审员 refuted 1 项 → 仲裁独立重跑确证(**A1 [P2]** existsSync 门只判存在不判可 spawn → EACCES 态裸归因,§7.1「一眼自诊断」不覆盖),其余 failed-to-refute;修复员(本轮)按最小修法全量实施 A1 三件套。
> 门禁:`npm run build` ✓(ad-hoc 重签挂接正常) / `npm test` **2417 passed + 1 skipped**(143 files;§7 基线 2405+1,净增 12 = A1 回归 spec)/ `npm run check-invariants` **82/82 INV** ✓。仍未 commit。

### 8.1 修复前复现(修复员独立重跑,与仲裁输出吻合)

`env` 指向真目录(`mkdirSync`)或 chmod 644 文件,经 dist 真 bridge 3 次调用:全部 **1-23ms 裸 `rust_helper_crashed:EACCES`**(无路径/无 cwd/无修法)。注:首轮复现脚本误用 `mkdtempSync(dirPath)`(追加随机后缀→实际测的是不存在路径),修正为 `mkdirSync` 后确证——"复现脚本本身也要过存在性自证"是本轮操作教训。

### 8.2 A1 修法(仲裁最小修法三件全采,单一真源纪律)

1. **spawn 前可行性门**:`rust-helper-path.ts` 新增 `rustSpawnGate(command)` → `"ok"|"missing"|"not_file"|"no_exec"`(存在 → `statSync().isFile()` → `accessSync(X_OK)`,顺序不可换:目录在 POSIX 上 `access(X_OK)`=可穿越通常为真,须先 isFile)。`SubprocessManager._spawnRustWithBackoff` 的 existsSync 门整体替换为该门,三态同 ENOENT 一样 **fail-fast 不进 backoff**,日志新增 `gate` 字段,错误附 `rustHelperNotSpawnableHint`(路径 + 「路径是目录」/「存在但缺执行权限」语境 + chmod +x / 改指文件 / env 覆盖三修法 + cwd)。
2. **RustBridge.onError 纵深兜底**:`SPAWN_ERROR_CODES = {EACCES, EPERM, EISDIR}` 分支——门后竞态(exec 位在门与 spawn 之间被夺)漏网时同样经 `getRustSpecCommand?.()` 附路径自诊断,归因保持 `rust_helper_crashed:<code>` 前缀(W1-DEF-9/INV-76(h) 契约零回归)。
3. **npm 布局修法条件化**:`hasRustHelperSource()`(包根 `rust-helper/Cargo.toml` 存在性,DI 可注入)——源码在包内(仓库 checkout)→ cargo build + env 双修法(§7.1 原文案零变化);npm 安装布局(tgz 经 .npmignore 排除 rust-helper/,0 条目)→ **仅 env 覆盖**,不再给不可执行的 `cd rust-helper && cargo build` 误导。hint(`rustHelperMissingHint` opts.hasSource)与 doctor #15 三处 next_step(codesign 探测失败 / binary 不存在 / 存在但无签名输出)全部条件化。

### 8.3 回归测试(净增 12)

`test/unit/rust-helper-path.spec.ts` 追加 4 组:`rustSpawnGate` 三态(目录 not_file / 644 no_exec / 755 ok / 不存在 missing,目录用例先 `existsSync` 自证防"断言建立在路径缺失上");`ensureRustRunning` 仲裁双复现态(dir / noexec 均 <1s、含路径+修法+env+cwd);RustBridge 两路(dir command 走门 reject;`/bin/sleep` 过门挂起后手工 emit EACCES 验证兜底分支附 `/bin/sleep` 路径);npm 布局(`hasRustHelperSource` DI 双分支、hint 双分支文案、doctor 源码级断言 `hasRustHelperSource()` 接线 + "npm 包不含"文案 + 相对路径字面量不回潮)。

### 8.4 /tmp 真实场景复验(全过)

- **仲裁双态**:dir-as-helper 3 次调用 0-3ms、noexec-helper 0-1ms → 全部 `rust_helper_crashed:subproc_spawn_failed — helper binary 不可 spawn(…): <绝对路径>(cwd=…)；修复: chmod +x …/ 改指 binary 文件…/ env 覆盖`(裸 EACCES 消失)。
- **真 binary 剥 exec 位**(env 指向真 helper 的 chmod 644 副本):3ms 同上自诊断(chmod 修法)。
- **npm tgz 布局**(pack→install `/tmp/lasso-a1/npm-host`,tgz rust-helper/ 条目=0):`hasRustHelperSource=false`;默认路径 ENOENT **2ms** fail-fast,文案=「npm 包不含 rust-helper 源码(无法 cargo build),仅可用 env … 覆盖」(不再误导 cargo);env 覆盖指回真 helper → **PING-OK 692ms**(真 tcc 返回);env 相对路径 resolve 契约不变。
- **正向不回归**:仓库 dist、cwd=/private/tmp、无 env 覆盖 → 默认路径 spawn 真 helper **PING-OK 95ms**(门不误伤正常 binary);完整 stdio server 从 /tmp boot、stdin EOF → exit 0。
- **git 脏集**:改动仅 SubprocessManager/RustBridge/desktop-doctor-checks(3 tracked,rust-helper-path.ts + 测试 + 本 doc 为 untracked)叠加 §7 未 commit 修复;`.dedao-extract/*.mjs`、`flow-*.png`、`package.json`、`sign.sh`、`src/index.ts` 未动,与仲裁移交的脏集完全一致。

### 8.5 残留(留档,不阻断)

- **D 类维持 inconclusive**(与仲裁一致):Windows `.exe` 后缀 / 大小写敏感 FS 默认路径无平台分支 → 非 darwin 布局下走 missing fail-fast(诚实,非静默);`--preserve-symlinks` + dist 单独复制布局同构。helper 为 macOS AXAPI 组件,门禁全在 darwin。
- 门后竞态(门与 spawn 之间 exec 位被夺)理论上仍可漏到 bridge——已由 §8.2-2 兜底附路径,不再裸归因。
- 未 commit/push(与 §7 同一裁决点,留用户)。

## 9. 对抗否定重审纪要（2026-08-23，独立于 §7-§8 的第二双眼睛）

三路隔离否定（路径解析攻击 / 回归与副作用攻击 / 端到端与诚实性攻击）→ 仲裁独立复核 → A1 修复（§8）→ fresh 终裁。终裁 `sign-off: zero-issues-pass（对抗重审）`，门禁 2417 passed+1 skipped / 82 INV / build ✓。

### 9.1 勘误（叙事证伪——代码对，故事错）

本档案 §2/§4.3 原叙述「ENOENT → 5×backoff ~30s 白烧」**与实测不符**（否定指令 B 用 git archive HEAD 复现修复前行为证伪）：node v24 spawn 对 ENOENT 走异步 error 事件，bridge.call 约 11ms 即 reject——**ENOENT 从不烧 backoff**，§7 的 catch-ENOENT 快退在其目标场景是死代码（保留无害）。真正烧满 30s（实测 30014ms + 裸消息）的是 **ENOEXEC**（binary 损坏/非 Mach-O）——已在 §8 修复轮纳入确定性失败分类（fail-fast + 自诊断）。§2/§4.3/§7.1 相应措辞已按实测修正。**教训：根因档案里的机制叙述必须有现场实测支撑，「合理解释」≠事实。**

### 9.2 对抗面板确证并修复的缺陷

- **A1（P2）**：existsSync 门只判存在不判可 spawn——env 指向目录/exec 位丢失时裸 `rust_helper_crashed:EACCES` 无自诊断 → §8 rustSpawnGate 四态（ok/missing/not_file/no_exec）+ RustBridge SPAWN_ERROR_CODES 兜底 + 12 条回归测。触发面窄（默认 cargo 产物必有 +x）、非回归，但「一眼自诊断」声称由此才真正成立。

### 9.3 留档不修的 P2 清单（终裁确认，交后续裁决）

1. 发布产物 build 脚本在安装态必失败（scripts/ 被 .npmignore 排除，node 缺模块 exit 1）——pack 保留该文件或守卫
2. sign.sh 对「codesign 存在但执行失败」set -e 硬退（降级只覆盖命令缺失）
3. cwd 解耦测试无法区分「真 cwd 无关」与「加载期 cwd 冻结」（path.resolve 变体存活）
4. rustHelperMissingHint 不接收 source（env 指错时仍建议「用 env 覆盖」不说当前值来自 env）；resolver.source 零生产消费者
5. npm 布局错误文案曾建议 cargo build（源码不在包内）——§8 已条件化修正
6. 未归因的既有现象（与本修复无代码交集，另行排查）：SIGKILL 前一 server 后立即冷启动 initialize 15-20s 挂起
