# 第 3 轮 03 审查测试报告（round3-review03）

> 审查测试员：第 3 轮 03 审查测试员（独立于实施者）。日期：2026-08-17。
> 输入：round3 全部改动（T3-1..T3-7，工作树未 commit，v1.13.0）+ round3-verdict 裁决书 + round2-review03 遗留清单。
> 方法：按 `03_审查测试清单.md` §1 六维逐条 + §2 五阶段；证据阶梯 L1（producer 源码）/L2（裁决书 E1' 实测记录）/L3（本机复跑门禁）；mutation 抽查 5 处全 killed。
> 基线承诺：round2 终态 1941 tests + 79 INV + 202 Rust + 11 selftest 不减。

---

## 0. 裁决速览

| 维度 | 结论 |
|---|---|
| 1.1 代码规范 | **通过**（零问题） |
| 1.2 数据逻辑 | **通过后修复 1 处**（doctor #25 languages 标记靠注释过检 = L0 证据——R03-R3-1 已修） |
| 1.3 业务逻辑 | **通过**（T3-2/T3-3 边界枚举齐；act 路空 where 语义与 find 分立有据） |
| 1.4 端到端接通 | **通过**（三条值级 trace + E1' run A/B/C L3 实测在案 + 文档面清点齐） |
| 1.5 性能/生产就绪 | **通过**（T3-4 停机链 60 倍上界改善 + 行为级定时测试；无新热路径） |
| 1.6 简单架构 | **通过**（零新依赖；T3-2 纯函数；审查修复新增 doctor→StealthEngine 单向只读边，无环） |
| 1.7 冗余废弃 | **通过**（T3-5 双失实注释归真；R03-R3-1 消灭「注释承载检查」负资产） |
| §2 测试五阶段 | **通过**（5 处 mutation 全 killed；手测清单 A-G 就位待用户签核） |
| **总裁决** | **zero-issues-pass（附 1 项审查修复 R03-R3-1 已落并复跑 + 4 条非阻断注记）** |

门禁终态（审查员本机亲跑，含审查修复后）：

```
npm run build            → BUILD_OK
npm test                 → 122 files, 1960 passed + 1 skipped (1961)
                           [round2 基线 1941 → +20（实施 +19 / 审查修复 +1），零失败零 flake]
npm run check-invariants → All 79 invariants passed.                [79/79]
npm run inv-selftest     → 14/14 sampled pins flipped red；零污染    [11 → 14，T3-7]
cargo test (rust-helper) → 42+101+9+10+30+9+6 = 207 passed, 0 failed
                           [bin 96→101 = +5 条 t33 测；round2 基线 202 → +5]
版本                      → package.json / index.ts / doctor.ts = 1.13.0 三处对齐（INV-63 绿）
```

---

## 1. 六维逐条结论

### 1.1 代码规范 ✅

- 命名一致：`profileLanguages` / `offsetVlmActionsByRegion` / `t33_*` 全仓单一定义；测试名读作领域行为（「region(100,200) + vlm click(50,60) → wire 收到 (150,260)」——与裁决书修法逐字对应）。
- 注释解释 WHY（自然不可能形状的检测机理、accept-but-silent 301s 实测出处、谓词非空串过滤理由），非复述 WHAT。
- build（tsc strict）承载 style 闸门，人审零 style 消耗。

### 1.2 数据逻辑 ✅（核心维度，发现并修复 1 处）

**T3-1（locale 层间一致性）**：
- wire 侧：`--chromeArg=--accept-lang=${profile.acceptLanguage}`（HeadlessChannel.ts:96）与 `--user-agent` 同管道（chromeArg 透传，round1 T2 已 L3 验证机制）；**E1' run B/C L3 实测在案**（round3-browser.md §E1'：注入后头变 `en-US,en;q=0.9,...` ≈ 真实双语用户形态）——producer（Chromium --accept-lang switch）契约有 L2/L3 证据，非注释推断。
- JS 侧：`profileLanguages(language) → [language, 主子标签]` 纯函数 + `buildUserAgentOverrideScript` 嵌入（JSON.stringify 转义）；`languages[0] === language` 与 `acceptLanguage.startsWith(l0,l1)` 双锚定测试。四 profile 头↔JS 同源同值——T3-1 目标（消灭「头 zh-CN ↔ JS en-US」自然不可能形状）达成。
- CORE #2 硬编码迁出干净：CORE 载荷不再含 `"languages"` 代码（dist 实测 `includes('"languages"')=false`），指路注释在位；16 路语义计数由测试显式重述（「CORE 2 路 + vendored 12 路 + UA override 内 languages」），无暗中缩水。
- **发现并修复（R03-R3-1，issue→已修）**：doctor #25 `stealth_profile_self_check` 的 `injectionMustHaves` 含 `"languages"`，迁移后靠 **CORE 指路注释里的字样** 过检——§0.3 证据阶梯下这是 L0 形态（注释不是运行时证据）：注释被清理 → 假红；真注入损坏 → 假绿。且 #25 此前**零 CI 断言**（全仓 grep 无测试触及）。修复：① `buildUserAgentOverrideScript` 导出（真 producer，L1）；② doctor #25 改为逐 profile 直验 UA override 脚本嵌 `"languages"` + `language` 值，CORE marker 清单归真为 webdriver/chrome/permissions 三点；③ 补 #25 pass-status 测试（该 check 首次获得可失败断言）；④ 同步 stealth-profiles.spec.ts 中已过时的「doctor must-have 语义不变」注释依据。**mutation 实证**：删除 languages defineProperty → 旧实现 doctor 仍绿（缺陷坐实）→ 新实现 doctor #25 测试红（闭环）。

**T3-2（region 坐标补偿）**：五环链闭合——parseVlmActions（坐标有限数校验）→ `offsetVlmActionsByRegion`（click/move x,y；drag 四值；scroll 仅双在场 x,y，dx/dy 不动；无 region 原样返回）→ cgevent_dispatch wire（测试 `toEqual` 精确对象断言到偏移后值）。审计标签 `vlm_click@(150,260)` 用平移后全局坐标 = 报真执行位置。scroll 单坐标（仅 x 无 y）在 parse 层就不产生（双在场才附）——平移层守卫与 parse 不变量一致。macOS 多屏全局坐标可为负，zod 不加非负约束正确。

**T3-3（where.ref 根治）**：双端夹击在案——zod 删 `where.ref`（strip 语义测试：多传降级空 where）+ Rust `ax_find` 兜底 `where 存在但 text/role 均空（含空白串）→ invalid_params`（ax.rs:191-198，防绕过 zod 直发 wire）。TS 侧 AxProvider.find 另有 `missing_where_clause` didnt 守卫（where 缺席路径），MCP 主路径三重无洞。act 路空 where = 全树编号（与 snapshot @eN 同序）是合法语义、与 find 的拒绝分立有据（ref 经 actions[].ref 消费，不经 where）。

**T3-6（tcc → didnt）**：producer（cgevent.rs:192 TCC 预检在 dispatch 循环**前**整 call 报错）→ 两消费者（CGEventProvider:329 / ScreenshotVlmProvider:246）同 seam 同映射同文案——双消费者一致性成立；per-item 不存在 tcc error_kind（预检前置），整 call 检查是唯一正确接缝。

### 1.3 业务逻辑 ✅

- 边界枚举：T3-1 `profileLanguages("en")` 退化双同值（测试钉住，现 profile 无此形态）；T3-2 负 region（多屏合法）/button 透传/scroll 缺省位置；T3-3 空白串谓词（`"  "` 同 None 处理）+ where 缺席保持 legacy（t33_find_where_absent_keeps_legacy_shape 显式钉住「不扩大打击面」）；T3-4 race 输者随 exit 消亡 + releaseSession 自吞错 + AbortSignal 二层上界。
- 无新守护线程/定时器（1.3-1a 不触发）；shutdown 幂等守卫 `shuttingDown` 既有，T3-4 未新增竞态面。
- T3-6 判定有据：权限缺失不是暂时性故障——didnt 语义（明确否）与 CGEventProvider 既定决策一致，非新决策。

### 1.4 端到端接通 ✅

值级 trace 三条：
1. **T3-1**：profile.acceptLanguage（顶级 const）→ spec flag `--chromeArg=--accept-lang=en-US,en;q=0.9` → Chromium Accept-Language 头（E1' run B/C 实测）↔ profile.language → buildUserAgentOverrideScript → navigator.languages = `["en-US","en"]`——头首 token 与 languages[0] 逐字符一致（测试断言）。
2. **T3-2**：screenshot_region(100,200) → Rust 裁图 → VLM 返区域相对 (50,60) → parseVlmActions → **offset 平移** → wire `cgevent_dispatch {actions:[{x:150,y:260}]}`（mock 断言到字节级 toEqual）→ results 映射 → actions_and_results。
3. **T3-3**：CC 传 `where:{ref:"@e5"}` → zod strip → `{where:{}}` → Rust 谓词全 None → invalid_params（不走全树 dump）→ outcomeOf → didnt + 人话 error。

文档面清点：README v1.13 段（用户向，七项中五项用户可感知者全列，T3-5/T3-7 内部项正确不进 README）/ descriptions.ts find 行（T3-3 语义）/ 版本断言测试 5 处 / 手测清单 B 扩展 + F/G 新节——逐个更新，无 not-affected 漏标。

### 1.5 性能 + 生产就绪 ✅

- T3-4：steel 段从唯一无上界 await（实测悬挂 ~301s）到双上界（race 3s + fetch AbortSignal 3s）——stdin_eof 全场景确定性 ≤~7s，60 倍改善；**行为级定时测试**（mock accept-but-silent fetch，断言 ≥2.5s ≤6s 返回）非仅源码正则。
- 审查修复 R03-R3-1 的 doctor 增量 = 4 profile × 字符串构造，微秒级，非热路径。
- 回滚：七项均单点可 revert；T3-2 无 region / T3-3 不传 ref / T3-4 无 Steel 会话路径 byte-identical 均有断言钉住。

### 1.6 简单架构 ✅

- 零新依赖、零新通道、零新机制面（七项全部是 round1/2 既有范式的下一层或尾巴清偿——与裁决书 §1.3 收敛判定一致）。
- 复用优先：T3-4 照抄同函数兄弟步 race 范式；T3-1 与 round1 T2 userAgent 变活同范式；T3-2 平移在 TS 侧不依赖 VLM 数学能力。
- 审查修复新增 doctor→StealthEngine 单向只读 import（纯函数），无环、无 INV 违例（79/79 绿）；换来的是把一个 L0 检查升级为 L1——代码健康净增。
- 多写者检查：本轮零新 mutable 写者；profileLanguages/offsetVlmActionsByRegion 均纯函数（02 R-INT-01）。

### 1.7 冗余与废弃 ✅

- T3-5：StealthEngine.ts:60-65 双失实注释（--window-size/--timezone）归真（--viewport= / 无 timezone flag / Intl 跟随宿主），stealth-profiles.ts timezone 字段注释同步——两处自相矛盾消除。
- R03-R3-1 顺带消灭「注释承载运行时检查」这一负资产形态（§0.3 L0）。
- 无新死代码；acceptLanguage 从死数据变活数据（单源消费）；无注释掉的代码、无 tracked 构建产物。
- 1.7-7 跨边界同步对本轮 diff 的应用：CORE 注释 ↔ doctor marker（本轮最大同步对，已由 R03-R3-1 从「注释耦合」重构为「producer 直验」）；error_kind 字面量 `tcc_event_synthesis_denied`（cgevent.rs:195 ↔ 两消费者）由 producer Rust 测试 + 双消费者测试三点点住。

---

## 2. §2 五阶段

| 阶段 | 结论 |
|---|---|
| 2.1 单测 | ✅ 实施 +19 测；**审查 mutation 5 处全 killed**：①T3-2 平移失效 → 3 红；②T3-1 accept-lang 硬编码 → 1 红；③profileLanguages `[primary,primary]` → 4 红；④T3-3 Rust 兜底 `if false&&` → 3 红（且两个负例测试 t33_text_present / t33_where_absent 正确保持绿——判别力真实，非一刀切红）；⑤R03-R3-1 languages defineProperty 删除 → doctor #25 红。producer 缺字段/退化输入用例齐（`profileLanguages("en")`、scroll 单坐标、空白串谓词） |
| 2.2 集成 | ✅ T3-2 wire 级 toEqual；T3-1 四 profile spec 构造 + UA override 嵌值端到端（经 HeadlessChannel.browse 真装配）；T3-3 zod strip 行为 + Rust 兜底双端；T3-4 悬挂 fetch 行为级定时 |
| 2.3 冒烟 | ✅ stdin-eof 真子进程（round2 既有，仍绿）；E1' run A/B/C 真机 Chrome 实测（browser 域 L3）；手测清单 A-E + B 扩展（Accept-Language echo）+ F（T3-2 真机 VLM）+ G（T3-6 权限场景）就位待签核 |
| 2.4 性能 | N/A（无性能敏感路径；T3-4 本身是延迟上界修复，自带定时断言） |
| 2.5 用户验收 | 手测清单 A-G 待非作者（用户）执行签核——记遗留（裁决书已定位 round4 = 验收轮，与此一致） |

---

## 3. 本审查修复清单（1 项）

| # | 文件 | 问题 | 修复 | 门禁复跑 |
|---|---|---|---|---|
| R03-R3-1 | `src/doctor/doctor.ts` + `src/browse/StealthEngine.ts` + `test/unit/doctor-v10-phase-cd.spec.ts` + `test/unit/stealth-profiles.spec.ts` | doctor #25 的 languages must-have 靠 CORE 指路**注释**过检（§0.3 L0 证据：注释删→假红 / 真注入坏→假绿）；且 #25 零 CI 断言 | ① `buildUserAgentOverrideScript` 导出（真 producer）；② #25 逐 profile 直验 UA override 脚本 languages/language，CORE marker 归真 3 点；③ 新增 #25 pass-status 测试；④ 过时注释依据同步 | build ✓ / npm test 1961（+1）✓ / INV 79 ✓ / selftest 14 ✓（cargo 不受影响） |

非阻断注记（不修，记档）：
- **N-R3-1**：tcc 引导文案字符串在 CGEventProvider/ScreenshotVlmProvider 各一份（intentional 镜像，同 `outcomeOf` 复刻避免循环依赖的既有模式；契约锚是 error_kind 字面量，文案漂移低风险）。
- **N-R3-2**：ax_find Rust 兜底仅覆盖 where-as-object；wire 直发客户端传非 object where / 缺席 where 仍全树 dump（pre-existing 语义，`t33_find_where_absent_keeps_legacy_shape` 显式钉住；MCP 路径有 zod + missing_where_clause 双守卫）——若未来出现第二 wire 客户端再收紧。
- **N-R3-3**：实施报告措辞「IIFE/try 计数不变」——实际 CORE try 块 3→2（languages try 随代码移除）；全 script 实测 14 IIFE/19 try/19 catch，测试阈值为 ≥13 仍绿。代码无问题，报告表述略松。
- **N-R3-4**：INV-79(d) 未顺势纳入 accept-lang flag（裁决书明示「实施者定」）；该 flag 已由集成测试四 profile 钉住， INV 扩展留作可选项。

---

## 4. 遗留项（记档，非本轮阻断）

1. **手测清单 A-G 执行**（含 round2 A-E + 本轮 Accept-Language echo / T3-2 真机 VLM / T3-6 权限场景）待用户跑后签核——2.5 闭合 + 裁决书附则二。
2. **发布收口**（裁决书附则一）：一次性 commit（round2+round3 全部）+ npm publish v1.13.0（npm latest 仍 1.10.0，三轮用户可感知修复积压）。
3. **round4 = 验收轮**：预期输入 = 本轮 T3-1..7 + review03 修复落地 + 门禁基线 1961/79/207/14 + 手测签核；预期 ROUND-CLEAN。

---

## 5. Sign-off

- **Reviewed-by**：第 3 轮 03 审查测试员（六维 + 五阶段 + 5 mutation + E1' 证据链核验 + 门禁全量亲跑）
- **Tested-by**：同上（独立复跑：build / npm test 1961 / INV 79 / cargo 207 / selftest 14；mutation 5 处红转实证）
- **裁决**：**zero-issues-pass**。T3-1..T3-7 全部过验收线且与裁决书修法逐项对齐；1 项审查修复（R03-R3-1）已落并复跑全绿；4 条注记记档不阻断。工作树含 round2+round3 改动 + 本审查修复，可按附则一 commit + publish。
