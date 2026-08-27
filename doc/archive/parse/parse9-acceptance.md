# Lasso v0.8 手测验收清单（parse9-acceptance）

> 上游：[parse9 §5.3](parse9.md) + §6 验收 + §1.3 隐私红线。
> v0.7 基线：**47 invariants + 1147 TS + 144 Rust tests**（零回归承诺）。
> v0.8 CI 闸门：**53 invariants + 1232 TS**（Phase A 72 + Phase B 13 新增）+ Rust 零改。
> 本文档：CI 无法代劳的真登录态手测清单（parse9 §1.4 + §5.3）。

---

## 0. 前置准备（环境 + 隐私注意）

### 0.1 隐私最高优先级（parse9 §1.3）

**cookie = session token = 用户身份**。手测必须严格遵守：

- **必用测试账号**，**禁用生产账号**（GitHub / Google / 微博 等）。
  - 推荐先注册一个一次性 GitHub 账号（`lasso-test-<random>@` 邮箱）专供 cookie 持久化手测。
  - 测试结束后 revoke 该账号 session + 删账号（GitHub Settings → Applications → Authorized OAuth Apps → Revoke + Delete account）。
- **禁在共享主机 / 多用户机器上 export cookie**：加密包虽 mode 0o600，但同主机任何 root 可读密文 buffer（auth tag 防篡改不防读）。
- **加密包不进 git**：`.gitignore` 已含 `~/.cache/lasso/cookies/`（CI 闸门 INV-49 静态守；建议另手测 `git status --ignored` 确认）。
- **master key 丢失 = 加密包永久不可解**：备份 keychain / 记下 passphrase（parse9 §7.1 R-v08-1）。

### 0.2 环境准备

```bash
# 1. 启动独立 Chrome（带 CDP 9222），用测试账号登录 GitHub
open -na 'Google Chrome' --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/lasso-test-chrome-profile
# 在弹出的 Chrome 中登录 GitHub 测试账号（含 2FA）

# 2. 验 9222 已开 + 至少 1 tab
curl -s http://localhost:9222/json/version | jq .webSocketDebuggerUrl

# 3. 起 Lasso MCP server（v0.8）
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
npm run build
npm start  # 或经 CC IDE 接入
```

### 0.3 CI 已覆盖项（不再手测）

| 项 | CI 测 | 文件 |
|---|---|---|
| AES-256-GCM round-trip 字节级一致 | ✓ | test/unit/cookie-store.spec.ts (17) |
| 加密包文件 mode 0o600 + 目录 0o700 | ✓（实 statSync） | 同上 |
| IV 每次唯一（密文 hex 不同） | ✓ | 同上 + test/integration/cookie-restore-flow.test.ts |
| auth tag 验签（篡改/key 错抛错） | ✓ | test/unit/cookie-store.spec.ts |
| doctor #28-#30 只 stat 不解密（静态） | ✓ | src/invariants/check-invariants.mjs INV-51 |
| LoggedInChannel 自动路径不调 export | ✓（静态） | INV-52 |
| admin profile_list / profile_switch | ✓（mock） | test/integration/profile-switch.test.ts (7) |
| admin cookie_restore op=export/import | ✓（mock CDP） | test/integration/cookie-restore-flow.test.ts (6) |
| profile 物理隔离（spec name `logged_in:<name>`） | ✓（mock subproc） | test/integration/profile-switch.test.ts |
| tab LRU ≤10 hard cap | ✓（mock） | test/unit/tab-registry.spec.ts |

CI 总数：v0.7 1147 + Phase A 72 + Phase B 13 = **1232 passed / 1 skipped**。
INV 总数：47 + INV-48..53 = **53/53 全绿**。

---

## 1. 真登录态 cookie export/import round-trip（parse9 §5.3 #1-#2 + §6.1）

### 测项 1：真 GitHub 登录态 export → 加密包落盘 mode 0o600

**前置**：测试账号已在 :9222 Chrome 登录 GitHub。

**触发**（在 CC 里对 Lasso）：
```jsonc
// admin tool 调用
{
  "action": "cookie_restore",
  "op": "export",
  "reason": "test: round-trip 真登录态落盘"
}
```

**预期**：
- 返 `{ ok: true, op: "export", profile: "default", bytes: <N>, sha256: <64 hex>, mode: "0o600" }`
- 加密包生成：`~/.cache/lasso/cookies/default.cookies`
- **mode 实测**：`stat -f "%Op" ~/.cache/lasso/cookies/default.cookies` → 输出 `100600`（即 0o600）
- **目录实测**：`stat -f "%Op" ~/.cache/lasso/cookies` → 输出 `100700`
- **加密包内容 grep 不可读**：`strings ~/.cache/lasso/cookies/default.cookies | grep -i "session"` → 空（cookie value 经 AES-GCM 加密不可见）
- **不进 git**：`git check-ignore ~/.cache/lasso/cookies/default.cookies` → 返该路径

### 测项 2：重启 Chrome → import 恢复登录态（免重新登录）

**步骤**：
1. 完全关闭 Chrome（Cmd+Q）
2. 用**空 user-data-dir** 重启 Chrome + CDP 9222（模拟「新会话」）：
   ```bash
   rm -rf /tmp/lasso-test-chrome-profile2
   open -na 'Google Chrome' --args \
     --remote-debugging-port=9222 \
     --user-data-dir=/tmp/lasso-test-chrome-profile2
   ```
3. 触发 import：
   ```jsonc
   { "action": "cookie_restore", "op": "import", "reason": "test: 恢复登录态免重登" }
   ```
4. browse_logged_in 访问 GitHub private repo（需登录态才能看的）：
   ```jsonc
   // browse_logged_in tool 调用
   { "url": "https://github.com/<your-test-user>/<private-repo>", "action": "snapshot" }
   ```

**预期**：
- import 返 `{ ok: true, imported: <N>, failed: 0, profile: "default" }`
- browse_logged_in 能读到 private repo 内容（不需重新登录 + 2FA）
- **若返 NEEDS_MANUAL_2FA**：cookie 已过期或 GitHub 强制 2FA 重验（08 §7.3 守：cookie 持久化只是缓解，非破解）

---

## 2. 多 profile 真切换（parse9 §5.3 #5 + §6.2）

### 测项 3：work / personal profile 物理隔离

**步骤**：
1. 用 admin 加 2 个 profile：
   ```jsonc
   // 注意：v0.8 admin action-enum 不含 profile_add；用 ProfileRegistry 直接调或经手测脚本
   // 暂行：在 lasso 启动前手改 ~/.cache/lasso/profiles/profiles.json 加 work/personal entry
   ```
2. 启动 work Chrome（:9222 + work user-data-dir）+ 登录 work GitHub
3. `admin({action:"cookie_restore", op:"export"})` → work profile 加密包生成
4. **完全关闭 work Chrome**
5. 启动 personal Chrome（:9222 + personal user-data-dir）
6. `admin({action:"profile_switch", profile:"personal", reason:"switch to personal"})`
7. `admin({action:"cookie_restore", op:"export"})` → personal profile 加密包生成
8. `admin({action:"profile_list"})` → 返 3 个 profile（default + work + personal），current=personal

**预期**：
- work / personal 加密包**物理隔离**：
  - `~/.cache/lasso/cookies/work.cookies` 存在
  - `~/.cache/lasso/cookies/personal.cookies` 存在
  - 两文件 sha256 不同
- spec name 隔离（在 Lasso 日志中可见）：
  - 切 work 时 `logged_in_forget_old_spec_failed` 或 `register logged_in:work`
  - 切 personal 时 `forget logged_in:work` + `register logged_in:personal`

### 测项 4：profile 名校验（防路径穿越）

```jsonc
// 期望全部 fail（防路径穿越）
admin({action:"profile_switch", profile:"../etc", reason:"x"}) → error "profile_unknown:../etc"
admin({action:"profile_switch", profile:"Work", reason:"x"}) → error "profile_unknown:Work"（大写拒）
admin({action:"profile_switch", profile:"a;ls", reason:"x"}) → error "profile_unknown:a;ls"
```

> 注：profile 名校验已在 CI 单测覆盖（test/integration/profile-switch.test.ts "profile 名校验：bad_name 拒"）。

---

## 3. tab LRU 真淘汰（parse9 §5.3 #6 + §6.3）

### 测项 5：连续 navigate 15 URL → Chrome 实际 tab 数 = 10

**步骤**：
```jsonc
// 连续调 browse_logged_in 15 次，每次不同 URL（公开页，不需登录态）
// Lasso 自动经 TabRegistry.reconcile 在 getMcpClient 末尾淘汰
[
  "https://example.com/1",  "https://example.com/2",  "https://example.com/3",
  "https://example.com/4",  "https://example.com/5",  "https://example.com/6",
  "https://example.com/7",  "https://example.com/8",  "https://example.com/9",
  "https://example.com/10", "https://example.com/11", "https://example.com/12",
  "https://example.com/13", "https://example.com/14", "https://example.com/15",
].forEach(url => browse_logged_in({ url, action: "snapshot" }))
```

**预期**：
- 调完后查 Chrome tab 数：`curl -s http://localhost:9222/json | jq 'length'` → ≤ 10
- Lasso 日志可见 `close_page` 调用（淘汰最老 5 个 tab）

> CI 已覆盖 mock 路径（test/unit/tab-registry.spec.ts）；真 Chrome tab 数验证留手测。

---

## 4. macOS Keychain 首次自动建（parse9 §5.3 #3 + §6.4）

### 测项 6：删 keychain → export 自动重建

**步骤**：
```bash
# 1. 删 lasso-cookie keychain 条目
security delete-generic-password -s lasso-cookie -a master 2>/dev/null

# 2. 触发 export（首次调用自动生成新 key + 写 keychain）
# admin({action:"cookie_restore", op:"export", reason:"test: keychain auto-provision"})

# 3. 验 keychain 已建
security find-generic-password -s lasso-cookie -a master -w
# → 输出一串 base64 key（≥ 32 字符；每次新生成随机）
```

**预期**：
- 首次 export 不抛错（master_key_unavailable 不应出现）
- Keychain Access.app 中可见 `lasso-cookie` 条目（service=lasso-cookie, account=master）
- 第二次 export 走 cache 60s + 同 key（parse9 §7.1 R-v08-6 scrypt 缓解）

---

## 5. doctor 永不清读 cookie（parse9 §5.3 #4 + §6.4 INV-51 红线）

### 测项 7：doctor 输出无 cookie value

**步骤**：
```bash
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
npm run build
node dist/index.js doctor > doctor-report.json

# 检查 doctor-report.json 中 #28-#30 + runtime_state.profiles
jq '.checks[] | select(.name | startswith("profile_") or startswith("cookie_store"))' doctor-report.json
jq '.runtime_state.profiles' doctor-report.json
```

**预期**：
- **#28 profile_registry_loadable**: status=pass, detail="N profile(s): [default, work, ...]; current=work"
- **#29 profile_user_data_dir_exists**: status=pass, detail 含 "userDataDir 存在 (mode=0o700)"
- **#30 cookie_store_stat_only**: status=pass/warn, detail 含 "sha256(prefix)=...；bytes=N; mtime=..."
- **runtime_state.profiles** 数组每 entry 含 `{name, isCurrent, userDataDir, userDataDirExists, userDataDirMode, encryptedPackage: {exists, bytes, mtimeMs, sha256}}`
- **❗ 全文 grep 无 cookie value**：
  ```bash
  grep -iE "(session|user_session|token|ghu_|gho_)" doctor-report.json
  # → 空（doctor 永不清读 cookie 内容；INV-51 红线）
  ```
- **❗ 全文 grep 无明文 cookie 字段名**：
  ```bash
  grep -E '"name"\s*:\s*"(session|user_session|tz|otp)"' doctor-report.json
  # → 空（doctor 输出无 cookie name/value 字段）
  ```

---

## 6. cookie 失效遇 2FA（parse9 §5.3 #7 + 08 §7.3）

### 测项 8：导入过期 cookie → NEEDS_MANUAL_2FA

**步骤**：
1. export 一批 GitHub cookie（按测项 1）
2. 等 7+ 天（GitHub session 通常 14 天过期；或用 dev tools 删 cookie 触发立即过期）
3. 重启 Chrome（空 user-data-dir）
4. import cookie + browse_logged_in(GitHub private)

**预期**：
- import 返 `{ ok: true, imported: N, failed: 0 }`（cookie 文件结构未坏，解密成功）
- browse_logged_in(GitHub) → outcome=didnt + status.note=NEEDS_MANUAL_2FA
- **❗ Lasso 永不自动尝试登录 / 自动解 2FA**（08 §7.3 守；铁律）

---

## 7. 已知偏离与待办（parse9 §4 + §7）

### 7.1 已知偏离（不阻断 v0.8 验收）

| ID | 偏离 | 影响 | 缓解 |
|---|---|---|---|
| D-v08-1 | chrome-devtools-mcp@0.3.0 不接 `--user-data-dir`（parse9 §4.2） | profile 物理隔离需用户手动启停 Chrome 实例（lasso 不自动启停） | 手测清单 #3 标「用户手动启动 Chrome + user-data-dir」；v0.9+ 评估接 chrome-devtools-mcp 新版 |
| D-v08-2 | tab id = url djb2 短哈希（parse9 §4.3 + §7.1 R-v08-7） | <1e-9 概率误关错 tab（同 hash 不同 url） | 接受（v0.9+ 用 chrome-devtools-mcp 真实 tabId） |
| D-v08-3 | profile_add 未暴露 admin action | 用户必须改 profiles.json 或重启 Lasso 触发 ProfileRegistry.add | v0.9+ 加 `profile_add` action；v0.8 范围仅 profile_list / profile_switch / cookie_restore（parse9 §1.2 范围矩阵） |

### 7.2 后续 phase 待办

- **Phase C 完结**（本 v0.8）：profile_list / profile_switch / cookie_restore ✓
- **v0.9+**：profile_add / profile_remove admin action
- **v0.9+**：tab 跨重启持久化（parse9 §1.2「不做」推迟项）
- **v1.0+**：Linux libsecret / Win credential-manager master key（v0.8 macOS only + env fallback）
- **v1.0+**：跨设备同步（NO-GO 红线；只在用户显式 opt-in + 端到端加密 + 设备配对后考虑）

---

## 8. 手测通过判据（parse9 §6）

| 章节 | 通过判据 |
|---|---|
| §6.1 cookie export/import | 测项 1-2 全过（mode 0o600 实测 + 重启免登） |
| §6.2 多 profile | 测项 3-4 全过（物理隔离 + 名校验） |
| §6.3 tab LRU | 测项 5 过（Chrome tab ≤ 10） |
| §6.4 隐私边界 | 测项 6-7 全过（keychain 自动建 + doctor 不清读） |
| §6.5 零回归 | CI 闸门：53 invariants + 1232 TS + 0 Rust 改 |

**全部通过 → v0.8 验收 pass，可 tag v0.8.0 + 发布 npm。**

---

## 9. 故障排查（FAQ）

### Q1: export 抛 `master_key_unavailable`

**A**: 当前平台非 macOS 且未设 `LASSO_COOKIE_PASSPHRASE`。
```bash
export LASSO_COOKIE_PASSPHRASE='<≥16字符随机串>'
# 或在 macOS 让 keychain 自动建（首次调 export 自动生成）
```

### Q2: import 抛 `cookie_auth_tag_failed`

**A**: master key 变了（重装系统 / 删 keychain / 换 passphrase）或加密包被篡改。
- 加密包永久不可解（parse9 §7.1 R-v08-1）
- 重新 export 一份即可（旧的删掉）

### Q3: import 抛 `cookie_store_not_found`

**A**: 当前 profile 没 export 过 cookie。
- 调 `admin({action:"cookie_restore", op:"export"})` 先生成

### Q4: profile_switch 抛 `profile_unknown:<name>`

**A**: 目标 profile 不在 ProfileRegistry 中。
- 调 `admin({action:"profile_list"})` 查可用 profile
- v0.8 profile_add 未暴露 admin action（D-v08-3）；手改 profiles.json 或重启 Lasso

### Q5: doctor #29 fail "userDataDir 不存在"

**A**: profile 配置的 user-data-dir 路径不存在。
- 手动建：`mkdir -p <userDataDir>` 并 chmod 0o700
- 或重启 Lasso 触发 ProfileRegistry.load 重建 default profile

---

## 文档结束

**本文档是 Lasso v0.8 手测验收清单**（parse9-acceptance，2026-07-22 产出）。
权威：[parse9.md](parse9.md) §5.3 + §6 + §1.3 隐私红线。
零回归承诺 v0.7 基线（47 INV + 1147 TS + 144 Rust）。
CI 闸门：v0.8 = **53 INV + 1232 TS + 0 Rust 改**（全绿）。

**附：关键路径**
- 排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.9
- 架构：`/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md` §3.3 / §5.1 / §7.3
- 实施计划：`/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse9.md`
- 加密实装：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/logged-in/CookieStore.ts`
- doctor 守门：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/doctor/doctor.ts` #28-#30
- 不变量：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs` INV-48..53
