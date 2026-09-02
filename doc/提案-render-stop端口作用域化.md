# 提案:render-chrome --stop 端口作用域化(未实施,待用户裁决)

> 2026-09-02 生成。纪律:重能力增强只出文档不实施——本提案只给语义/草图/回滚面,
> 用户点头才动代码。配套现状钉死测试:test/unit/render-chrome.spec.ts
> 「stop 收台账内全部 render 记录(跨 port)」tripwire(变更本语义必须先过本提案裁决)。

## 1. 问题

CLI 内部**作用域不对称**:

- `--ensure` / `--status` 认 `LASSO_RENDER_PORT`(render-flags.ts `renderCdpPort()`),
  只作用于该端口;
- `--stop` **不认**该 env——按设计决议 3.7「收全部 render 记录(任意 port)」,
  render-chrome.ts runStop 调 `stopLaunchedChromes({modes:["render"]})` 不传 port。

后果:设了 `LASSO_RENDER_PORT=9234` 的用户合理期待 `--stop` 只收自己的实例,实际杀掉
**全机**渲染档(含其它 agent 在用实例)——这是「同机多 agent 并行验收互杀」的第一入口。
业界对照:Playwright/Puppeteer/Docker 的 kill 全部按 handle/session/container 作用域化,
killall 型只作显式管理员逃生口;lasso 的 `--stop` 在用户已表达端口命名空间的前提下
仍默认 killall,属设计债而非用户误用。

## 2. 提案语义(向后兼容)

`render-chrome --stop`:

- `LASSO_RENDER_PORT` **显式设置** → 只收该 port 的 render 记录(与 ensure/status 对称);
- **未设置** → 维持现状「收全部 render 记录」(设计决议 3.7 语义不变,单用户全收场景零影响);
- 全局收口仍可用:`chrome-stop --modes render`(或临时 unset env)。

## 3. 实施草图(约 10 行 + 2 个 spec 用例)

engine 与 CLI 旗标支持**均已存在**,只差接线:

1. `src/render/render-flags.ts`:新增 `renderCdpPortExplicit(): number | undefined`
   (env 显式设置且合法 → 该值;否则 undefined。现 `renderCdpPort()` 无法区分
   「未设」与「非法降级默认」,需新函数而非改旧函数)。
2. `src/render/render-chrome.ts` runStop:
   ```ts
   const port = renderCdpPortExplicit();
   const result = await stopLaunchedChromes({
     ...(port !== undefined ? { port } : {}),       // 显式设置才限定;未设=全收(3.7 不变)
     modes: ["render"],
     logFn: cliLog as LedgerLogFn,
   });
   ```
   (`stopLaunchedChromes` 的 `opts.port` 过滤在 chrome-stop.ts:199-201 早已实现;
   `chrome-stop` CLI 的 `--port N` 旗标同理已存在——本提案零 engine 改动。)
3. spec:改 tripwire 用例为「显式 port env → 只收该 port;未设 → 跨 port 全收(3.7)」。
4. 文档同步:README 渲染档节(双语)、本文标记已裁决、并行验收隔离配方 §4 更新。

## 4. 风险与回滚

- 风险:已有脚本「设了 port env 却期待 --stop 全收」会被改变行为。缓解:全局收口
  仍有 `chrome-stop --modes render`;changelog 显著位写 breaking-change 说明。
- 回滚:还原 runStop 两行 + spec;零数据/存储迁移。

## 5. 附带裁决点(更重,独立评估)

`render-chrome doctor --clean` 跨命名空间孤儿误判(指纹对 + 本台账缺位 + >10min →
杀其它命名空间在用实例)。选项:doctor 增加 `--namespace` 显式声明 / 孤儿判定加
「指纹对且所有已知台账均缺位」聚合(需枚举台账目录,引入目录布局契约)。短期靠纪律
(并行期间禁 doctor --clean,见隔离配方 §3),长期随本提案一并裁决。
