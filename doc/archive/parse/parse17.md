# parse17 — 浏览器/tab 生命周期收尾机制 v1.9 设计

> **作者**：Lasso v1.9 设计师
> **日期**：2026-08-15
> **性质**：v1.9.0 实施设计（机制修复，非 spike）。基于两份 RCA：`parse17-rca-lifecycle.md`（白盒生命周期审计，G1-G7 缺口 + §4 可复用机制表）+ 中断根因报告（2026-08-15 04:49 批量 kill 被拒 → 3h45m 会话空窗；积留在因果链上游但非中断直接原因）。
> **基线**：lasso-mcp v1.8.1（1711 TS tests + 76 INV 全绿）。
> **用户三点要求映射**：
> ① 工具运行完成/任务完成后关闭打开的浏览器 → **机制一**（headless 空闲关停，堵 G1/G5/G6）+ **机制二**（launch-chrome 会话清理，堵 G2）；
> ② 若用用户登录浏览器，关闭 Lasso 打开的 tab 恢复原 tab 列表 → **机制三**（logged_in tab 快照+恢复，堵 G3）；
> ③ 测试过程中不再积留 52 进程式残局 → **§5 测试纪律**（doc/17 §0.2 补条）+ 两份 RCA 的预防建议落地。
> **立场红线**：每条设计引 RCA/源码锚点；只杀「记录在案且可验证归属」的进程/tab；v1.8.1 零回归（INV-1..76 全保 + 基线测试不减）。

---

## 0. TL;DR（4 句裁决）

1. **机制一**：不新造看门狗——把 `index.ts:354` 的 `startZombieReaper()` 阈值从写死 1h 改为读 `LASSO_HEADLESS_IDLE_MS`（默认 5min，0=禁用），并修 G5：`_kill` 在 `client.close()` 后补树杀。这样「工具完成 → 5min 无人再用 → 整树 SIGKILL」全部复用既有 lastUsedAt/zombieTimer/`_killTreeSync`，新增代码约 30 行。冷启动代价 11s/次（诚实接受，可配 0 关闭回退旧行为）。
2. **机制二**：launch-chrome spawn 成功（含 cdp_not_ready 慢启动）后落盘台账 `~/.cache/lasso/launched-chromes.json`（port/pid/profileDir），新增 CLI 子命令 `lasso-mcp chrome-stop [--port N|--all]`；杀前强制 `ps -p <pid> -o command=` 校验命令行仍含该 `--user-data-dir=<profileDir>` 标记（防 pid 复用误杀）；server 停机路径 best-effort 同步收尾。
3. **机制三**：新增 `TabSession`（不动 TabRegistry 的 LRU 语义）——LoggedInChannel 首次附着时 `/json/list` 快照（targetId+url）；恢复时只对**快照后新增**的 targetId 逐个 `/json/close/<id>`（失败 fallback CDP `Target.closeTarget`）；快照内 tab 一律不动；CDP 不可达 / 疑似 Chrome 重启 / diff 异常大 → warn 放弃不硬来。触发口 = admin action `tab_restore`（显式）+ server 停机（best-effort）+ idle 回收 logged_in spec 时（reap hook）。
4. **配套**：INV-77（浏览器所有权与恢复安全）+ ~32 条新测试 + doc/17 §0.2 第 6 条测试纪律 + 版本 1.9.0。每阶段真实跑 `npm run build && npm test && npm run check-invariants`（1711→~1743 tests，76→77 INV）。

---

## 1. 目标与范围

### 1.1 缺口覆盖矩阵（对 RCA §2）

| 缺口 | 严重度 | 本设计落点 | 状态 |
|---|---|---|---|
| G1 长活 server 内 headless Chrome 永活 | 核心 | 机制一（idle 阈值 1h→5min 可配） | 修复 |
| G2 launch-chrome Chrome 无主 | 核心 | 机制二（磁盘台账 + chrome-stop + 停机收尾） | 修复 |
| G3 logged_in 不恢复原 tab 列表 | 核心 | 机制三（TabSession 快照+diff 恢复） | 修复 |
| G5 运行中「优雅 _kill」不树杀（回收即孤儿化） | 高 | 机制一 Phase A（`_kill` 补树杀） | 修复（机制一的前置） |
| G6 HeadlessChannel 无 TabRegistry，tab 随 URL 累积 | 次 | 被机制一覆盖：整树 5min 空闲即死，tab 泄漏窗口=常驻期本身 | 间接修复 |
| G7 端口预检识别不了「持口不应答」僵尸 | 次 | 部分缓解：记录在案的僵尸可 chrome-stop；**未记录的外部僵尸仍无解**，doctor 检测留 v1.10 | 部分缓解（诚实） |
| G4（历史）v1.8.0 exit 空 map | 已修 | 无需动作（lifecyclePids+树杀 v1.8.1 已闭环） | 已修 |

### 1.2 不做的事（范围红线）

- **不改 chrome-devtools-mcp 上游**（版本锁 INV 守 `LOCKED_CDP_MCP_VERSION="0.3.0"`）。
- **不给 launch-chrome 加 MCP 工具入口**（保持 CLI 子命令形态；MCP 化是独立决策，台账设计对两种入口通用）。
- **不动 rustProcs 的生命周期**（`cleanupZombies` 本来就只遍历 MCP `procs`，SubprocessManager.ts:204；desktop helper 语义不同）。
- **不做「每次工具调用完立即关」**：browse 调用 5min 内高频复用浏览器是 v0.1 以来的懒复用设计（parse1 §3.5），立即关会让每次调用付 11s 冷启动。**「工具运行完成」语义落地为「完成后开始计 idle，超时关」**——这是用户要求①与懒复用设计的折中，理由：52 进程积留的根因不是「跨调用复用」而是「永不回收」（RCA G1），堵住永不回收即达标。
- **不在 CDP 不可达/状态可疑时强行关 tab**（用户红线：绝不误关用户原有 tab，宁可少关）。

---

## 2. 机制一：headless 空闲关停（G1+G5+G6）

### 2.1 设计原理：改参数 + 补树杀，不新造调度器

RCA §4 已确认可复用件齐全：`lastUsedAt`（数据源）、`zombieTimer`（60s setInterval + unref 调度，SubprocessManager.ts:184-199）、`_killTreeSync`（唯一可靠致死原语，:354-383）、`cleanupZombies(threshold)`（手动触发口，:202-214）。**缺的只是两件事**：阈值 configurable + 优雅路径 `_kill` 不树杀（G5）。

若新造一个独立 watchdog（新 timer、新遍历、新 kill 调用），就是与 zombieTimer 平行的第二套生命周期调度——违反「不开第二套」惯例（doctor #5 vs launch-chrome 的先例）且引入两个 timer 的竞态。**故本设计 = 既有 reaper 换阈值 + `_kill` 补一行树杀。**

### 2.2 改动清单

**(a) `src/config/config.ts` —— 新 env（INV-71 扁平机制自动兼容 config 文件）**

```ts
// envDefaults 增（config.ts:160-171 一带）：
LASSO_HEADLESS_IDLE_MS: 300_000,   // MCP 浏览器子进程空闲回收阈值（ms）
```

解析规则（`loadConfig` 一带）：
- `parseInt`；负数 / NaN → 回退默认 300_000；
- `0` → **禁用**（不启动 zombie reaper——见 (c) 的诚实说明）；
- 不设上限 clamp（用户要配 1h 恢复 v1.8.1 行为 = `3600000`，要更长也随他）。

**(b) `src/subprocess/SubprocessManager.ts` —— G5 修复 + touch + reap hook**

```ts
// _kill（:532-546）改为：
private async _kill(name: string): Promise<void> {
  const m = this.procs.get(name);
  if (!m) return;
  m.closed = true;
  const pid = m.client.pid;
  try {
    await m.client.close();          // SDK 优雅 SIGTERM（对 shim，不转发——RCA G5）
  } catch (e) { /* 原有 warn 日志 */ }
  if (pid !== null) this._killTreeSync(name, pid);   // G5：补树杀残存 node/Chromium
  this.procs.delete(name);
}
```

理由：SDK close 只 SIGTERM shim、npm exec 不转发信号（wave2 实证），只 close 不树杀 = 「回收即孤儿化」。`lifecyclePids` 兜底要等到 server exit 才消费——长活 server 内每次「回收→重 spawn」净增一棵完整树。补树杀后，`_kill` 的全部调用方（`cleanupZombies` / `forgetSpec`（profile 切换）/ `shutdownOne`（capability disable）/ `restart`）一次全修。

```ts
// 新增公开方法 1：touch（长调用保活）
touch(name: string): void {
  const m = this.procs.get(name);
  if (m && !m.closed) m.lastUsedAt = Date.now();
}

// 新增公开方法 2：reap hook（机制三接线用；默认 null 零行为变化）
setReapHook(hook: ((name: string) => Promise<void>) | null): void { this.reapHook = hook; }
```

`cleanupZombies`（:202-214）在 `await this._kill(name)` **之前**插入：

```ts
if (this.reapHook) {
  try {
    await Promise.race([this.reapHook(name), timeout(3_000)]);  // 有界，不阻塞 reaper
  } catch (e) { logger.warn({ evt: "reap_hook_error", name, error: String(e) }); }
}
```

INV-7 合规性：hook 是「回收前回调」的 lifecycle 编排点，SubprocessManager 不关心回调内容、不读协议帧——与 ResourceMonitor 注入 `listManagedPids` 同范式（v0.7 先例）。

**(c) `src/index.ts:354` —— 阈值接线**

```ts
// 旧：subproc.startZombieReaper();
const idleMs = config.headlessIdleMs;      // loadConfig 产物新字段
if (idleMs > 0) subproc.startZombieReaper(60_000, idleMs);
// idleMs === 0 → 不启动（禁用语义；日志 info 一条 idle_watchdog_disabled）
```

**(d) `src/channels/BrowseChannel.ts` —— 长调用 touch**

browse 主循环每个 action dispatch 后调 `this.subproc.touch(specName)` 一行（注入句柄或经 channel 既有 subproc 引用）。理由：`lastUsedAt` 只在 `ensureRunning` 复用时刷新（SubprocessManager.ts:146）；一条带 steps 的长 browse（多步导航 + ExpectPoll 轮询）可能超 5min，若不 touch，watchdog 会在调用进行中杀掉浏览器。touch 后「in-flight 窗口」= 单个 action 的内部超时（MCP 工具级，秒-分钟级），5min 阈值下误杀概率归零。HeadlessChannel/LoggedInChannel 经同一 BrowseChannel 主路径继承。

### 2.3 行为变化（诚实声明）

| 维度 | v1.8.1 | v1.9.0 默认 | 说明 |
|---|---|---|---|
| headless 浏览器存活 | 到 server 退出（或 1h 闲置） | 最后一次使用后 ≤5min+60s（reaper 60s 周期，最坏多等 1 分钟） | 52 进程积留的直接对症 |
| 二次 browse 冷启动 | 0s（常驻） | ~11s（npx 树重 spawn，wave 实测） | 高频连续调用场景可配 `LASSO_HEADLESS_IDLE_MS=3600000` 回退 |
| 优雅 `_kill` 路径 | 泄漏推迟到 exit（G5） | 即时树杀 | 无行为回退面 |
| `LASSO_HEADLESS_IDLE_MS=0` | n/a | reaper 完全不启动（含旧 1h 兜底也没了） | 文档明示：opt-out 即自负残留 |

timer `unref`（:198 已有）保证不阻止进程退出；全局单例由装配保证（一 server 一 SubprocessManager，`startZombieReaper` 重复调用覆盖旧 timer，:188）。

### 2.4 测试时序图（单测用 fake timers 验证的契约）

```
t=0     browse_headless 调用 → ensureRunning → lastUsedAt=0
t=1s    工具完成返回（浏览器常驻）
t=5min  idle 阈值到点
t≤6min  reaper 60s 周期命中 → cleanupZombies(300000)
        → reap hook（若 logged_in spec，先恢复 tab，3s 上界）
        → _kill：client.close() + _killTreeSync(shim pid)
        → shim/node/Chromium 三层全死（ppg 验证）
t=7min  下一次 browse → _spawnWithBackoff 重 spawn（~11s）
```

---

## 3. 机制二：launch-chrome 会话清理（G2）

### 3.1 设计原理：磁盘台账 = 跨进程所有权记录

launch-chrome 是独立 CLI 进程，spawn 后即 `process.exit()`（launch-chrome.ts:342）——**内存台账（lifecyclePids 同款）天然不可用**，因为消费方（chrome-stop / server 停机）在不同进程。所有权必须落盘。这也正是 RCA §4 对 lifecyclePids 范式的复用建议：「launch-chrome pid 应进同款登记（或 registerExternalPid）」——本设计取「同款范式、磁盘载体」。

### 3.2 新文件 `src/launcher/chrome-ledger.ts`（INV-64：仅 node:* import）

```ts
export interface LaunchedChromeRecord {
  port: number;
  pid: number;
  profileDir: string;       // = spawn 时注入的 --user-data-dir（杀前验证标记）
  launchedAt: number;       // epoch ms
  status: "ready" | "cdp_not_ready";   // cdp_not_ready 也登记（慢启动 Chrome 真实存在，wave2 pid 74620）
}
export function launchedChromesPath(): string;
// ~/.cache/lasso/launched-chromes.json；env LASSO_LAUNCHED_CHROMES_PATH 可覆盖（测试隔离）
export async function recordLaunch(rec: LaunchedChromeRecord): Promise<void>;
// 读旧 → 同 port 覆盖（一 port 至多一条）→ tmp+rename 原子写；全程 try/catch best-effort
// （台账写失败不让 launch 失败——但必须 logger.warn，doctor 可查）
export async function removeLedgerEntries(ports: number[]): Promise<void>;
export function readLedgerSync(): LaunchedChromeRecord[];   // exit 钩子路径用（同步）
// 容错解析：文件损坏/不存在 → []（不 throw）；未知字段忽略（前向兼容）
```

### 3.3 `src/launcher/launch-chrome.ts` 改动

1. **ok=true 返回前**（:287-295）与 **cdp_not_ready 返回前**（:304-312）：`await recordLaunch({port, pid: pid!, profileDir, launchedAt: Date.now(), status})`（pid 为 undefined 时跳过）。**不登记**：`chrome_exited`（进程已死）、`port_in_use`（不是我们起的）、spawn 同步抛错（无 pid）。
2. **头注释改承诺**（:11 一带）：「不接管 Chrome lifecycle」→ 「spawn 后 detached，进程内不做 lifecycle 管理；但登记磁盘台账 launched-chromes.json，`chrome-stop` 子命令与 server 停机路径按台账收尾（只杀台账在案且 cmdline 验证归属的 pid）」。
3. **cdp_not_ready 分支**（:302-303）注释同步改：「launch 时不代 kill（慢启动 Chrome 可能稍后就绪，wave2 U-04-1 实证）——但已登记台账，后续 chrome-stop / 停机收尾可按记录关闭」。**这是对「不代 kill」承诺的精确化而非推翻**：不在 launch 时刻杀（会误杀慢启动），在收尾时刻杀（归属可验证）。

### 3.4 新文件 `src/launcher/chrome-stop.ts`：`stopLaunchedChromes(opts)`

单条记录的关闭流程（**红线落地**）：

```
1. process.kill(pid, 0) 探活
   └ ESRCH → action="already_dead" → 删台账条目，返回
2. spawnSync("ps", ["-p", String(pid), "-o", "command="]) 读完整命令行
   ├ 输出含 `--user-data-dir=${record.profileDir}`（精确子串，lasso 隔离 profile 标记）
   │    → 归属验证通过，继续
   └ 不含 → pid 已被复用或不是我们的 Chrome
        → 绝不 kill；action="pid_reused_skipped" → 删台账条目（陈旧记录），返回
3. 优雅关闭：process.kill(pid, "SIGTERM") → 轮询存活 ≤2s（200ms 步进）
4. 仍活 → killTreeSync(pid)（pgrep -P 递归 SIGKILL，收 Chrome helper 子进程）
5. 删台账条目 → action="killed"
```

- **只杀步骤 2 验证通过的 pid**——pid 复用场景（台账是陈旧记录、pid 已被无关进程占用）在步骤 2 被拦截，这是用户红线「防 pid 复用误杀」的机械化。
- API 形状（测试注入同 launch-chrome 惯例）：

```ts
export interface ChromeStopOptions {
  port?: number;          // 二选一；都不传 = --all
  all?: boolean;
  aliveFn?: (pid: number) => boolean;                    // 测试 mock
  psFn?: (pid: number) => string;                        // 测试 mock（ps -o command= 输出）
  killTreeFn?: (pid: number) => void;                    // 测试 mock（默认 util/kill-tree）
}
export async function stopLaunchedChromes(opts): Promise<{
  stopped: Array<{ port: number; pid: number; action: "killed" | "already_dead" | "pid_reused_skipped" }>;
}>;
```

### 3.5 共享树杀原语：新文件 `src/util/kill-tree.ts`

`_killTreeSync` 从 SubprocessManager **原样搬出**为 `export function killTreeSync(pid, logTag?)`；SubprocessManager 保留私有 `_killTreeSync(name, pid) { killTreeSync(pid, name); }` 薄委托（**保 INV-76 (n) 的 `/_killTreeSync/` grep 仍命中 SubprocessManager.ts**——零回归红线）。chrome-stop 与 SubprocessManager 两处消费同一原语，杜绝两份 pgrep 递归实现漂移。

### 3.6 CLI + 停机接线

- **`lasso-mcp chrome-stop [--port N|--all]`**：`index.ts` main() 路由表加一行（`process.argv[2] === "chrome-stop"`，与 :1233 launch-chrome 同款）；无 flag = --all（台账本身已 scoped 到 lasso-owned + 验证归属，全清是安全默认）。输出 JSON `{stopped:[...]}`，exit 0（幂等：无记录也 0）。`CLI_USAGE` 补一行。
- **server 停机收尾**：`index.ts` `shutdown(sig)` 处理器（:1123-1147）在 `subproc.killAllSync()` 前加 `await stopLaunchedChromes({ all: true })`（外层 3s `Promise.race` 上界，失败 warn 不阻断停机）；`process.on("exit")` 钩子（:1156）加同步版 `stopLaunchedChromesSync()`（`readLedgerSync` + ps 验证 + `killTreeSync` 直杀，跳过 SIGTERM 优雅步——exit 钩子零 await 纪律，W1-DEF-6 先例）。

### 3.7 与中断 RCA 的闭环

中断根因报告 §4.1 的建议「把只能 Esc 拒绝的宽匹配批量 kill 变成可安全放行的精确命令」——`chrome-stop` 就是那个命令：台账圈定范围 + cmdline 验证 + 逐条结果 JSON。未来清理残留不再需要 `pgrep -f "disable-blink-features" | xargs kill -9`。

---

## 4. 机制三：logged_in tab 卫生（G3）

### 4.1 设计原理：快照+diff，不动 TabRegistry

TabRegistry 的 LRU≤10 是**运行中防爆**语义（parse9 §4.3），「恢复原列表」是**会话收尾**语义——两者生命周期不同（前者每次 getMcpClient 触发，后者一次会话一次）、数据模型不同（LRU 用 URL 哈希 id，恢复需要**真实 targetId**——`/json/list` 才给）。塞进同一个类会把两种语义搅在一起。**故新增 `TabSession`（快照/恢复），TabRegistry 一行不动（INV 守 `close_page` 唯一调用点不变）。**

### 4.2 新文件 `src/logged-in/TabSession.ts`

```ts
export interface TabSnapshotEntry { targetId: string; url: string; }
export interface TabRestoreResult {
  ok: boolean;
  closed: string[];        // 成功关闭的 targetId
  reason?: "no_snapshot" | "cdp_unreachable" | "browser_restarted" | "diff_too_large";
}

export class TabSession {
  constructor(cdpPort: number, opts?: {
    fetchFn?: (url: string) => Promise<Response>;   // 测试 mock（同 launch-chrome 惯例）
    closeFn?: (targetId: string) => Promise<boolean>;
    maxDiff?: number;                                // 默认 32
  }) {}

  async takeSnapshotIfAbsent(): Promise<void>;
  // GET http://127.0.0.1:<port>/json/list → filter type==="page" → [{targetId, url}]
  // 已有快照 → no-op；失败 → warn 放弃（下次 getMcpClient 重试）

  async restore(): Promise<TabRestoreResult>;       // 永不 throw（红线）
}
```

`restore()` 流程：

```
1. snapshot == null → { ok:false, reason:"no_snapshot" }
2. GET /json/list
   └ 网络错/非 200 → catch → warn → { ok:false, reason:"cdp_unreachable" }   ← 红线：不硬来
3. Chrome 重启守卫：当前 page url 集 ∩ 快照 url 集 == ∅ 且双方非空
   → { ok:false, reason:"browser_restarted" }
   理由：快照内 tab 已随旧 Chrome 消失；现存 tab 全部视为用户新开的，关任何一个都可能踩红线。
   （副作用诚实声明：若 Lasso 把用户原有 tab 全部 navigate 走且没开新 tab，也会触发此守卫而
     跳过恢复——宁少关不误关，可接受的保守性。）
4. diff = 当前 page targets − 快照 targetId 集
   └ diff.length > maxDiff(32) → warn（附 pid/targetId 清单供人工处置）→
     { ok:false, reason:"diff_too_large" }        ← 异常大 diff 视为快照错位，不批量关
5. 逐个关闭 diff 内 targetId：
   主路径 GET /json/close/<targetId>（Chrome DevTools HTTP 端点，已废弃但仍工作）
   └ 失败 → fallback CdpClient WebSocket `Target.closeTarget {targetId}`（browser 级）
   单个失败 warn 继续（部分恢复优于全放弃）
6. ok:true + closed 列表；snapshot 置 null（下次附着重新快照 = 新会话基线）
```

**红线机械化**：关闭目标只来自 `diff`（步骤 4），快照内 targetId 在类型层面就进不了关闭列表——「绝不关闭用户原有的任何 tab」由 diff 的定义保证，而非靠运行时判断。

`CdpClient` 增一个公开方法 `closeTarget(targetId: string): Promise<boolean>`（复用既有 connect/pending 基建，~10 行；不破坏现有 3 方法语义与 INV-46 相关注释）。

### 4.3 接线（`LoggedInChannel.ts`）

1. 构造器增 `private readonly tabSession: TabSession = new TabSession(cdpPort)`（无新 DI 参数，cdpPort 已有）。
2. `getMcpClient()`（:132-147）在 `ensureRunning` 后、`reconcile` 前插：
   ```ts
   try { await this.tabSession.takeSnapshotIfAbsent(); }
   catch { /* warn；快照失败不阻断 browse */ }
   ```
   首附着（本 server 生命周期内第一次）快照用户 tab 基线；后续调用 no-op。
3. 新公开方法 `restoreTabs(): Promise<TabRestoreResult>`（薄委托）。注意 **profile 切换不重置快照**——TabSession 键于 cdpPort 而非 profile，同一用户 Chrome 的 tab 基线跨 profile 有效（`forgetSpec` 只杀 mcp 子进程，不动用户 Chrome）。

### 4.4 三个触发口

| 触发口 | 位置 | 语义 | 失败处理 |
|---|---|---|---|
| **admin action `tab_restore`**（显式 opt-in） | `admin.ts` action-enum 增一项（mutation，handler 层强制 `reason`，同 capability_disable 惯例）；`index.ts` registerAdminTool 注入 `tabRestore: () => logged_in.restoreTabs()`（与 :1001 cookieExport/Import 同款注入点） | 用户/CC 主动收尾：「任务完成，恢复我的 tab 列表」 | 返回 `{action, ok, ...result}`，不抛 |
| **server 停机** | `index.ts` `shutdown(sig)` 在 chrome-stop 收尾旁：`await logged_in.restoreTabs()`（3s 上界） | server 结束 = 会话结束，自动恢复 | warn 放弃（CDP 不可达等） |
| **idle 回收 logged_in spec 时** | `index.ts` 装配段：`subproc.setReapHook(async (name) => { if (name.startsWith("logged_in:")) await logged_in.restoreTabs(); })` | 机制一回收 logged_in 的 mcp 子进程前先恢复 tab（「浏览器用完收尾」完整语义） | hook 内 3s 上界 + warn（§2.2(b)） |

INV-52 合规：tab_restore 与 cookie action 同为 admin opt-in 入口；TabSession 只读 `/json/list` + 关闭 diff tab，**不触碰任何 cookie 路径**——INV-52（自动路径永不调 cookie export/import）不受影响，注释中显式声明。

---

## 5. 测试纪律：doc/17 §0.2 补第 6 条（agent 面板教育）

`lasso/doc/17-功能测试清单.md` §0.2「测试执行纪律」追加：

> 6. **面板收尾清残留**：每个测试面板（wave/子面板）结束前，盘点本面板自 spawn 的浏览器/tab 与 server 进程（`pgrep -f chrome-devtools-mcp`、`ps aux | grep "user-data-dir=.*lasso"`、9222-9230 端口占用），**先输出精确清单（含 ppid 归属判定），确认后再分批清理**——禁止一步式 `pgrep -f <子串> | xargs kill -9` 宽匹配批量击杀（2026-08-15 04:49 中断教训：宽匹配命令只能被整体拒绝，精确清单命令可安全放行）。lasso v1.9+ 优先用机制出口：`lasso-mcp chrome-stop --all` + admin `tab_restore` + 等 idle 自动回收。清理结果记入 wave summary「残留清理」小节（清理前后进程计数各一次）。

此条同时落地中断 RCA §4.3（「每 wave 收尾强制残留盘点，不把 52 进程积留拖到末尾一次性批量击杀」）。

---

## 6. INV-77 预设（`src/invariants/check-invariants.mjs` 新增）

**INV-77 浏览器生命周期所有权与恢复安全**——三个机制的机械化回归守护，6 组断言（沿用既有 byPath + stripComments + regex 模式；全部既有 INV-1..76 原样保留）：

| # | 断言（grep 可机械化） | 守什么 |
|---|---|---|
| a | `util/kill-tree.ts` 存在且导出 `killTreeSync`；SubprocessManager.ts 与 chrome-stop 路径（launcher/chrome-stop.ts 或 index.ts 停机段）**都** import 它；SubprocessManager.ts 仍含 `_killTreeSync`（薄委托，保 INV-76 (n) 兼容） | 树杀原语单一真源 |
| b | SubprocessManager.ts 的 `_kill` 方法体（regex 圈定 `private async _kill[\s\S]*?^  }`）内含 `killTreeSync`/`_killTreeSync` 调用 | G5：优雅路径必树杀 |
| c | config.ts 含 `LASSO_HEADLESS_IDLE_MS` 字面量 + 默认 300000；index.ts 同时命中 `LASSO_HEADLESS_IDLE_MS`（经 config 字段）与 `startZombieReaper` 接线 | G1：阈值 configurable 且默认 5min |
| d | launch-chrome.ts 含 `recordLaunch` 调用（ok 与 cdp_not_ready 两路径）；index.ts 含 `process.argv[2] === "chrome-stop"` 路由 + CLI_USAGE 含 chrome-stop 用法行 | G2：台账登记 + 收尾出口存在 |
| e | chrome-stop（或 ledger）源文件含 `--user-data-dir=` cmdline 验证逻辑（grep `user-data-dir` + `ps` 调用 + 验证函数名 `verifyOwnership`/`pid_reused_skipped` 字面量），且验证出现在任何 `process.kill`/`killTreeSync` 之前的控制流（regex 圈定 stop 函数体，验证 return 早于 kill 调用行号） | 红线：只杀验证归属的 pid |
| f | TabSession.ts 含：`/json/list`（快照）+ `/json/close/`（恢复）+ `cdp_unreachable`、`browser_restarted`、`diff_too_large` 三个 reason 字面量 + restore 函数体含 snapshot diff（grep `snapshot` 于 restore 圈定体内）；TabRegistry.ts 无 `restore`（两语义不混淆）；LoggedInChannel.ts 含 `takeSnapshotIfAbsent` 调用 | G3：快照+diff+三守卫，红线可 grep |

计数变化：76 → **77**（`check-invariants` 输出 `77/77 passed`）。

---

## 7. 测试计划

### 7.1 新增单测（~26 例）

**`test/unit/subprocess-idle-watchdog.spec.ts`**（机制一，10 例；fake timers + mock spawnSync/pgrep）：
1. `cleanupZombies(300000)`：lastUsedAt 6min 前 → `_kill` 被调 + 树杀调用发出（mock killTreeSync 断言 pid）；
2. lastUsedAt 1min 前 → 不杀；
3. `touch()` 后阈值重算（touch 重置 lastUsedAt → 不杀）；
4. `_kill` 树杀路径：client.close() reject 仍树杀（close 失败不阻断 SIGKILL）；
5. `_kill` 幂等：closed 标记后二次调用 no-op；
6. reap hook：logged_in 前缀 spec 回收前 hook 被调、3s 超时上界生效（hook 挂起 → reaper 不死等）；
7. reap hook 抛错 → warn 不阻断 `_kill`；
8. `setReapHook(null)` 恢复零行为；
9. `LASSO_HEADLESS_IDLE_MS=0` → loadConfig 解析为 0（config-file.spec.ts 补 1 例：env 与 config.json 两来源）；
10. rustProcs 不受 cleanupZombies 影响（既有行为回归锚）。

**`test/unit/chrome-ledger.spec.ts`**（机制二，8 例）：
11. recordLaunch 原子写 + 同 port 覆盖（第二次 launch 同 port → 单条记录）；
12. readLedgerSync 文件损坏 → [] 不 throw；
13. stopLaunchedChromes：pid 死（aliveFn=false）→ already_dead + 删条目；
14. cmdline 不含 `--user-data-dir=<profileDir>` → pid_reused_skipped + **killTreeFn 未被调**（红线断言）；
15. cmdline 验证通过 + SIGTERM 后死 → killed + 删条目；
16. SIGTERM 2s 不死 → killTreeSync fallback 被调；
17. `--port N` 只动一条；无 flag = 全部；
18. exit 同步路径 stopLaunchedChromesSync 零 await（源码 grep 断言无 `await`，同 W1-DEF-6 模式）。

**`test/unit/tab-session.spec.ts`**（机制三，8 例；mock fetchFn/closeFn）：
19. takeSnapshotIfAbsent 只调一次 /json/list（二次 no-op）；
20. restore：快照 [A,B]，当前 [A,B,C,D] → 只关 C/D（**断言 closeFn 入参不含 A/B**——红线核心用例）；
21. CDP 不可达 → `{ok:false, reason:"cdp_unreachable"}` 不 throw；
22. 快照 url 与当前 url 零交集（Chrome 重启形态）→ browser_restarted 守卫放弃（**断言 closeFn 零调用**）；
23. diff > 32 → diff_too_large 放弃；
24. /json/close 单个失败 → fallback Target.closeTarget 被调（closeFn 主路径返 false 场景）；
25. restore 成功后 snapshot 置 null（再 restore → no_snapshot）；
26. 非 page 类型 target（type==="background_page" 等）不进快照不打 diff。

### 7.2 新增集成（~6 例）

**`test/integration/admin-tab-restore.spec.ts`**：
27. admin `tab_restore` 无 reason → fail（mutation 强制）；
28. 带 reason → ok + 注入的 restore stub 被调（registerAdminTool opts.tabRestore 注入链，模式同 cookie-restore-flow.test.ts）；
29. 未注入 tabRestore → configured:false 零回归形态。

**`test/integration/lifecycle-teardown.spec.ts`**（机制一二三装配链）：
30. index 装配段 shutdown 模拟：restoreTabs + stopLaunchedChromes 在 killAllSync 前被调（模块级 mock 注入顺序断言）；
31. reap hook 装配：`setReapHook` 在 startZombieReaper 前完成（grep 场式断言 + 行为验证择一）。

### 7.3 既有回归门禁

- 全量 `npm test`：1711 基线全绿 + 新增 ~32 → **~1743**；
- `npm run check-invariants`：76 → **77**；
- 重点盯防的既有文件：`launch-chrome.spec.ts`（返回值形状未变，新增 recordLaunch 副作用需 mock 或 tmp ledger 路径）、`profile-switch.test.ts`（forgetSpec 现在树杀——mock McpClient pid 场景）、`TabRegistry` 既有 spec（未动，应零波动）。

### 7.4 e2e 手测清单（v1.9 acceptance，类比 parse14/15-acceptance；本机 macOS 可证）

| # | 场景 | 预期 |
|---|---|---|
| A1 | MCP 起 server → browse_headless 一次 → `pgrep -f chrome-devtools-mcp` 计数 | 5-6min 内归零（reaper 60s 周期容差）；`~/.cache/lasso/logs` 有 `zombie_reaped` + 多条 `subproc_exit_kill` |
| A2 | 同上但 `LASSO_HEADLESS_IDLE_MS=0` | 浏览器常驻（禁用语义） |
| A3 | `lasso-mcp launch-chrome --port 9227` → 查台账文件 → `lasso-mcp chrome-stop --port 9227` | Chrome 窗口关闭 + 台账空 + JSON 报 killed |
| A4 | launch-chrome 后手动 kill 该 Chrome → chrome-stop --all | already_dead + 台账清空，exit 0 |
| A5 | launch-chrome 后用无关进程占同 pid（难造则单测覆盖）→ chrome-stop | pid_reused_skipped，无关进程存活 |
| A6 | 用户 9222 Chrome（3 个 tab）→ browse_logged_in navigate 3 站 → admin `tab_restore` | 用户原 3 tab 原样、Lasso 开的 tab 关闭 |
| A7 | 同上但任务后直接 kill server（SIGTERM） | 停机路径自动恢复 tab + 关台账 Chrome |
| A8 | A6 场景中重启用户 Chrome 再 tab_restore | browser_restarted 守卫 → 不关任何 tab |

---

## 8. 03 审查预设（架构想法/03 审查测试清单对齐）

### 8.1 §1 六维逐维预设

| 维度 | 本设计的审查点 |
|---|---|
| 一致性 | 台账 schema（launch-chrome 写 ↔ chrome-stop 读）单一真源在 chrome-ledger.ts；`killTreeSync` 单一真源在 util/kill-tree.ts（禁第二份 pgrep 递归） |
| 错误处理 | 所有收尾路径 best-effort + warn 不阻断主流程（launch 成功、browse 返回、server 停机三者都不能被清理失败拖死）；restore 永不 throw |
| 资源清理 | G1/G2/G3/G5 各自的清理出口存在性 + 幂等性（chrome-stop 空台账 exit 0、_kill 二次 no-op、restore no_snapshot） |
| 并发 | reaper 60s 周期内 touch 竞态（touch 后阈值重算原子性——单线程事件循环下 lastUsedAt 读写无竞态，审查确认无 async 夹缝）；台账 tmp+rename 原子性 vs 并发 chrome-stop |
| 可观测 | 每个动作有结构化日志事件：`zombie_reaped`/`subproc_exit_kill`（既有）+ 新增 `chrome_ledger_recorded`/`chrome_stop_result`/`tab_snapshot_taken`/`tab_restore_result`（含 reason） |
| 安全 | 红线三条机械化：cmdline 归属验证（INV-77e）、快照 diff 类型面隔离（INV-77f）、`browser_restarted`/`diff_too_large` 双守卫 |

### 8.2 §2 五阶段门禁

design（本文档）→ implement（Phase A-D 各跑三件套门禁）→ test（§7）→ review（03 六维 + INV-77 grep 复核）→ acceptance（§7.4 八例手测 + parse17-acceptance.md 落档）。

### 8.3 §1.7.7 跨边界同步对（重点机械化审查）

1. **ledger 文件 = 跨进程契约**（launch-chrome 进程写 / chrome-stop 与 server 停机进程读）：schema 变更须三方同步；容错解析 + 未知字段忽略是前向兼容保险。
2. **setReapHook 回调签名**（SubprocessManager 定义 / index.ts 实现）：3s 上界双方都要守（hook 侧不得再包无界 await）。
3. **`LASSO_HEADLESS_IDLE_MS` 三处同步**：config.ts 解析 / index.ts 接线 / README 文档（README user-facing：用法+默认值+0 语义，技术细节不进 README——用户既定偏好）。
4. **R-INT-07 模式自查**：`lastUsedAt` 消费者从 2 个变 3 个（ensureRunning / cleanupZombies / touch）——仍是单写多读的简单字段，未引入多消费者可变状态耦合（watchdog 只读判定，写点仍收敛在 SubprocessManager 内）。
5. **R-INT-08 模式自查**：本设计新依赖 3 个外部命名空间静态契约——CDP HTTP `/json/list` `/json/close/<id>`（已废弃端点！）、`ps -o command=` 输出格式、`pgrep -P` 输出格式。**grep 测不到，必须真跑**（§7.4 A1/A3/A6 实测覆盖；/json/close 失败已有 Target.closeTarget fallback，契约断裂不致红线失守）。

---

## 9. 版本 1.9.0 + 实施顺序

| Phase | 内容 | 门禁（真实跑） |
|---|---|---|
| **A**（机制一） | kill-tree.ts 抽取 + `_kill` 补树杀（G5）+ `touch`/`setReapHook` + config env + index.ts 阈值接线 + BrowseChannel touch + 单测 1-10 | build + test（1711→~1721）+ INV 76 |
| **B**（机制二） | chrome-ledger.ts + launch-chrome 登记与注释修订 + chrome-stop.ts + CLI 路由/USAGE + 停机收尾（async+sync 两路）+ 单测 11-18 | build + test + INV 76 |
| **C**（机制三） | TabSession.ts + CdpClient.closeTarget + LoggedInChannel 接线 + admin action + 三触发口 + 集成 27-31 | build + test（→~1743）+ INV 76 |
| **D**（收尾） | INV-77 + doc/17 §0.2 第 6 条 + README（chrome-stop 用法 / env 表 / 生命周期行为说明）+ package.json 1.9.0 + parse17-acceptance 手测八例 | build + test + **INV 77** |

依赖关系：A 必须先行（B 的 chrome-stop 消费 kill-tree.ts；C 的 reap hook 消费 A 的 setReapHook）。B/C 之间无依赖可并行。

---

## 10. 诚实判定

1. **机制一是「超时关」不是「用完即关」**：5min 默认窗口 + 60s reaper 周期 + 11s 冷启动代价，三者都在文档明示。用户若要严格「每次工具完成即关」，配 `LASSO_HEADLESS_IDLE_MS=1`（下一次 reaper 周期即杀）即可逼近，但高频场景会很难受——本设计默认取折中而非极端。
2. **cdp_not_ready 仍不在 launch 时刻杀**：慢启动 Chrome 真实存在（wave2 pid 74620），launch 时杀会误杀；台账登记 + 收尾杀是更精确的承诺修订，不是回避。
3. **TabSession 的 url 交集守卫有保守盲区**：Lasso 把用户所有原 tab 都 navigate 走且未开新 tab 时，恢复会被 browser_restarted 守卫跳过——宁少关不误关的代价，接受。
4. **/json/close 是 Chrome 已废弃的 DevTools HTTP 端点**：当前仍工作，但属外部契约风险（R-INT-08）；Target.closeTarget WebSocket fallback 是对冲，acceptance 必须真机验证两条路径。
5. **G7 只部分缓解**：未登记的外部僵尸（非 lasso 起的持口不应答进程）仍无解，留 doctor 检测 + v1.10。
6. **52 进程那类积留的主泄漏口（G4）v1.8.1 已修**，本设计堵的是剩余四个缺口（G1/G2/G3/G5）；测试面板「每调用一个新 server」的 harness 形态（RCA 路径 D）本身不改——那是测试方法问题，由 §5 纪律约束，不是产品缺陷。
