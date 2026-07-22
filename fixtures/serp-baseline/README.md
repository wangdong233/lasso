# SERP Baseline Fixtures (parse11 §3.2 v1.0 Phase C 录制回放回归基线)

> **铁律 INV-62（parse11 §3.2 + §1.3 macOS-only 红线 + 08 §5.1 cookie=身份）**：
> 本目录**只录** `search` + `browse_headless` 兜底抽链路径的脱敏 SERP 快照。
> **禁录** `browse_logged_in` 真 cookie / session URL 参数场景。
> INV-62 静态守：`src/invariants/check-invariants.mjs` grep 本目录 + `replay-baseline.ts`
> 不出现 `logged_in` / `cookie` / `session` 字面量。

## 目录布局（parse11 §3.2 数据形状）

```
fixtures/serp-baseline/
├── <engine>/<fixture-name>.html    # 录制时落盘的原始 SERP 快照（a11y 文本或 HTML）
├── <engine>/<fixture-name>.json    # 期望 sidecar：engine / query / expected_count / recorded_at
├── baidu/rust-async-runtime.html
├── baidu/rust-async-runtime.json
├── google/mcp-architecture.html
├── google/mcp-architecture.json
└── ...
```

## 运行回归

```bash
npm run replay-baseline              # 默认 strict=false；命中率 <0.5 → console 标 fail，不 exit 1
npm run replay-baseline -- --strict  # strict 模式；有 fail → exit 1（CI gate）
```

runner：`src/serp/replay-baseline.ts`。读 fixture HTML → 用当前
`src/serp/extract.ts` 的 `extractResultsFromSnapshot` 抽结果 → 比对
`.json` sidecar 里的 `expected_count`。

## 添加新 fixture

1. 临时设 `LASSO_RECORD_SEARCH=true`
2. 跑 `npm run replay-baseline -- --refresh --query "<query>" --engine <baidu|google|bing>`
3. 关 `LASSO_RECORD_SEARCH`
4. 检查 `fixtures/serp-baseline/<engine>/<name>.html` 不含 cookie / session URL
5. commit

## 命中率阈值（parse11 §3.2）

- `hit_rate = actual_count / expected_count`
- `>= 0.8` → **pass**（selector 健康）
- `>= 0.5` → **warn**（轻微改版，selector 债）
- `< 0.5` → **fail**（selector 改版；strict 模式 exit 1）

selector 是债不是 bug：CI warn 不阻塞；strict 模式 fail 是开发者主动加 gate 时才生效。

## 当前基线

v1.0 Phase C 首次基线（2026-07-22）：6 条 fixture（baidu ×2 / google ×2 / bing ×2），
全部用脱敏 query（rust async / claude code / mcp architecture / wayback / axios / vitest），
**无任何用户真实 query / cookie / session**。
