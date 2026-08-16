//! AXAPI 核心路径（parse4 §3.1.4 + §4.1 决策落地）。
//!
//! ## API 选择（smoke test 验证后的决策）
//!
//! 通过 `examples/smoke_api.rs`（cargo run --example smoke_api）经验性确认 accessibility 0.2 +
//! accessibility-sys 0.2 真实暴露的符号。**parse4 §4.1 明示：若 FFI 批读签名太脆，
//! 允许降级为逐属性 `.attribute()` 读（正确性 > 10x perf）。** 本文件采如下分层：
//!
//! - **typed 属性**（role/title/enabled/focused/children）走 safe wrapper 预定义 accessors：
//!   - `AXUIElementAttributes` trait 提供 `.role()` / `.title()` / `.enabled()` / `.focused()`
//!   - `.attribute(&AXAttribute::children())` 返回 `CFArray<AXUIElement>`（**非 Vec**）
//! - **几何属性**（AXPosition/AXSize）不在 safe trait，必须 raw FFI 路径：
//!   - `AXUIElementCopyAttributeValue(el, "AXPosition", &out) → AXValueRef`
//!   - `AXValueGetValue(value, kAXValueTypeCGPoint=1, &CGPoint)` 取 CGPoint
//!   - 同理 `kAXValueTypeCGSize=2` 取 CGSize
//! - **批读 FFI**（`AXUIElementCopyMultipleAttributeValues`）符号可达但解析 CFArray<CFType>
//!   每值需手动判断 CFTypeID 再 cast — 复杂且容易漏 release；推到 Phase D 优化
//!   （仅 M0.5a 验收第 4 条 ≤30ms 不达标时才加）。
//!
//! ## resolve_root 策略
//!
//! - `app=None` → `AXUIElement::system_wide()`（safe wrapper；smoke test 验证可达）
//! - `app=Some(name)` → 含 `.` 当作 bundle id（"com.apple.finder"）；否则当人名经
//!   `bundle_id_for_app_name` 精选表查 bundle id（"Finder"/"Mail"/"系统设置"），再
//!   `application_with_bundle`。这覆盖 parse4 §6.1 acceptance #1 用人名调 snapshot。
//!   v0.3.5 用精选表而非 NSWorkspace 枚举：`runningApplicationsWithOptions:` 等枚举
//!   选择子在本 AppKit + Rust objc 桥下不可靠（unrecognized selector）；人名→bundle
//!   表是确定性、CI 可单测的，完整 NSWorkspace 枚举留 v0.4。
//! - 任一路径调用前先 `tcc::accessibility_granted()` 预检，false → `error_kind="tcc_denied"`
//!
//! ## 协议出口
//!
//! 所有 method 返回 `protocol::Response`：成功 `Response::ok(id, json!({...}))`，
//! 失败 `Response::err(id, kind, msg)`，kind ∈ {"not_macos","tcc_denied","app_not_found",
//! "ax_unavailable","invalid_params","not_implemented"}.

use crate::ax_role_map::map_ax_role;
use crate::protocol::Response;
use crate::tcc;

use serde::Serialize;

#[derive(Serialize, Debug, Clone)]
pub struct AxRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Default for AxRect {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct AxNode {
    pub role: String,        // unified role（已映射；map_ax_role 输出）
    pub raw_role: String,    // 原 AXRole 字符串（debug；不进 OutlineNode 接口）
    pub label: String,       // AXTitle（无则空串）
    pub rect: AxRect,
    pub enabled: bool,
    pub focused: bool,
    pub depth: usize,
    pub children: Vec<AxNode>,
    /// v0.4 forest rootRef 身份用（parse5 §2.2）：仅 root（depth=0）填，
    /// 形如 `pid * 1_000_000 + window_index`（与 windows.rs::list_windows 合成规则一致）。
    /// 子节点不填；`skip_serializing_if` 让 wire shape 在 None 时与 v0.3.5 字节一致。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<i64>,
    /// v1.11（round1 T8 skeleton）：max_depth 边界节点的真实子节点数。
    /// 仅 skeleton=true 的边界节点填（子树省略但保留「下面还有多少」信息——
    /// dense app token 成本数量级下降，agent-desktop tree/builder.rs 同款）。
    /// `skip_serializing_if` 让 wire shape 在 None 时与 v1.10 字节一致。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children_count: Option<usize>,
}

// ============================================================================
// Non-macOS fallback：所有 method 返回 not_macos
// ============================================================================

#[cfg(not(target_os = "macos"))]
pub fn snapshot(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "ax_snapshot requires macOS")
}

#[cfg(not(target_os = "macos"))]
pub fn find(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "ax_find requires macOS")
}

#[cfg(not(target_os = "macos"))]
pub fn act(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "ax_act requires macOS")
}

// ============================================================================
// macOS 实装
// ============================================================================

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use accessibility::{AXAttribute, AXUIElement};
    use accessibility_sys::{
        AXUIElementCopyAttributeValue, AXValueGetValue, AXValueRef, AXValueType,
    };
    use core_foundation::{
        array::CFArray, base::{CFType, TCFType}, boolean::CFBoolean, string::CFString,
    };
    use core_graphics_types::geometry::{CGPoint, CGSize};

    /// AXValue 类型常量（accessibility_sys::value_constants 里的 u32 值）。
    /// 直接硬编码避免再引 type alias（这些是 ABI 稳定的苹果 API 常量）。
    const AX_VALUE_TYPE_CG_POINT: AXValueType = 1; // kAXValueTypeCGPoint
    const AX_VALUE_TYPE_CG_SIZE: AXValueType = 2;  // kAXValueTypeCGSize

    /// `ax_snapshot` 入口。
    pub fn snapshot(id: &str, params: &serde_json::Value) -> Response {
        let app = params.get("app").and_then(|v| v.as_str());
        let max_depth = params
            .get("max_depth")
            .and_then(|v| v.as_u64())
            .unwrap_or(8) as usize;
        // v1.11（round1 T8）：skeleton 边界计数（默认关 = byte-identical v1.10）
        let skeleton = params
            .get("skeleton")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let root = match resolve_root(app) {
            Ok(r) => r,
            Err(kind) => return Response::err(id, &kind, format!("resolve_root({:?}) failed", app)),
        };
        let mut visited = std::collections::HashSet::new();
        let mut live = Vec::new();
        let tree = walk(&root, 0, max_depth, skeleton, &mut visited, &mut live);
        match serde_json::to_value(&tree) {
            Ok(v) => Response::ok(id, v),
            Err(e) => Response::err(id, "ax_unavailable", format!("serialize: {e}")),
        }
    }

    /// `ax_find`：基于 snapshot 后的纯字符串/role 查询（parse4 §3.3 find 专用）。
    /// v0.3.5 简化：每次 find 都重 walk（state_id 仅做协议占位，未真缓存）；
    /// TS 端 OutlineMapper 可后续做 snapshot cache（v0.4+ 优化）。
    pub fn find(id: &str, params: &serde_json::Value) -> Response {
        let app = params.get("app").and_then(|v| v.as_str());
        let max_depth = params
            .get("max_depth")
            .and_then(|v| v.as_u64())
            .unwrap_or(8) as usize;
        let want_text = params
            .get("where")
            .and_then(|w| w.get("text"))
            .and_then(|v| v.as_str());
        let want_role = params
            .get("where")
            .and_then(|w| w.get("role"))
            .and_then(|v| v.as_str());

        let root = match resolve_root(app) {
            Ok(r) => r,
            Err(kind) => return Response::err(id, &kind, format!("resolve_root({:?}) failed", app)),
        };
        let mut visited = std::collections::HashSet::new();
        let mut live = Vec::new();
        let tree = walk(&root, 0, max_depth, false, &mut visited, &mut live);

        // 递归过滤
        let mut hits: Vec<serde_json::Value> = Vec::new();
        let mut ref_counter: usize = 0;
        collect_matches(&tree, want_text, want_role, &mut hits, &mut ref_counter);

        Response::ok(
            id,
            serde_json::json!({
                "matches": hits,
                "count": hits.len(),
            }),
        )
    }

    /// `ax_act`：observe→act 闭环（v1.11 round1 T3 落地，原 Phase B M0.5b 占位废除）。
    ///
    /// 设计（round1-verdict T3，对标 agent-desktop actions/chain.rs 最小集）：
    ///  1. **重新 walk + 确定性同序重编号**（与 find 同序，零新状态，守 R-INT 简单
    ///     架构——不缓存 AXUIElementRef、不做 stateId 句柄表）：
    ///       - params.where 存在 → 编号命中节点（与 ax_find 的 collect_matches 完全同序）
    ///       - params.where 缺席 → 编号全部节点（前序 DFS，与 ax_snapshot→OutlineMapper
    ///         的 ref 分配同序）
    ///  2. **三元组 stale 检测**：解析 @eN 后重读 role+label+rect 与 walk 期捕获值比对
    ///     （role 精确 / label 精确（walk 期非空时）/ rect 中心漂移 >50px），不符 →
    ///     error_kind="stale_ref"（TS 端映射 outcome=didnt：UI 已变，需重新 observe）。
    ///  3. **click → AXPress**：调用前读 AXActionNames 校验支持（不支持直接
    ///     ax_action_unsupported，省注定失败的 FFI）。
    ///  4. **type → AXSetValue 写后读回比对**（secure 字段豁免——AXSecureTextField
    ///     值被遮蔽，读回必不等）。
    ///  5. **scroll → AXScrollToVisible**（AXAPI 无按像素滚动原语；细粒度滚轮是
    ///     档3 CGEvent 的域，T7 落地）。dx/dy 仅记录进结果（方向语义由档3 承担）。
    ///  6. **press/hotkey 留档3**：逐项 ok=false + error_kind="ax_unsupported_action"
    ///     （cgEvent 档 domain；全批失败时 TS 端 outcome=unknown 让链继续）。
    ///  7. 每元素执行前 `AXUIElementSetMessagingTimeout(1.0)`（防挂死 app 拖垮整批）。
    ///
    /// 返回逐项 `{index, ref, ok, error_kind?, error?}`（cgevent_dispatch 同形先例），
    /// 外层 `{actions_and_results: [...]}`（与 DesktopResult.actions_and_results 同名）。
    pub fn act(id: &str, params: &serde_json::Value) -> Response {
        let app = params.get("app").and_then(|v| v.as_str());
        let max_depth = params
            .get("max_depth")
            .and_then(|v| v.as_u64())
            .unwrap_or(8) as usize;
        let where_text = params
            .get("where")
            .and_then(|w| w.get("text"))
            .and_then(|v| v.as_str());
        let where_role = params
            .get("where")
            .and_then(|w| w.get("role"))
            .and_then(|v| v.as_str());
        let actions = match params.get("actions").and_then(|v| v.as_array()) {
            Some(a) => a,
            None => {
                return Response::err(
                    id,
                    "invalid_params",
                    "ax_act requires {actions: array}",
                )
            }
        };

        let root = match resolve_root(app) {
            Ok(r) => r,
            Err(kind) => {
                return Response::err(id, &kind, format!("resolve_root({:?}) failed", app))
            }
        };

        // 1. 重新 walk + 同序编号（round1 review03 F2 重构：单一真源 = walk()）。
        //    walked 树 + live 元素序列锁步编号：
        //      - where 在   → 命中节点依序编号（谓词与 collect_matches 逐字一致）
        //      - where 缺席 → 全部节点前序编号（与 OutlineMapper @eN 分配同序）
        //    wrapper 深度中和 / 防环占位 / 深度截断的语义与 snapshot/find **构造性
        //    一致**（同一函数产出），彻底消灭 F2（两套遍历漂移 → @eN 错位）。
        let mut visited = std::collections::HashSet::new();
        let mut live: Vec<AXUIElement> = Vec::new();
        let tree = walk(&root, 0, max_depth, false, &mut visited, &mut live);
        let mut numbered: Vec<ResolvedElem> = Vec::new();
        let mut cursor = 0usize;
        number_refs(
            &tree,
            &live,
            &mut cursor,
            where_text,
            where_role,
            &mut numbered,
        );

        // 2. 逐项执行（每项独立成败；单项失败不中止整批）
        let mut results: Vec<serde_json::Value> = Vec::with_capacity(actions.len());
        for (i, a) in actions.iter().enumerate() {
            let kind = a.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let ref_id = a.get("ref").and_then(|v| v.as_str()).unwrap_or("");

            if kind != "click" && kind != "type" && kind != "scroll" {
                // press/hotkey 是档3 cgEvent 的 domain；形状错也归此项
                results.push(serde_json::json!({
                    "index": i, "ref": ref_id, "ok": false,
                    "error_kind": "ax_unsupported_action",
                    "error": format!("kind {:?} not supported by ax tier (press/hotkey -> cgEvent tier)", kind),
                }));
                continue;
            }

            // @eN 解析
            let idx = match parse_ref_index(ref_id) {
                Some(n) => n,
                None => {
                    results.push(serde_json::json!({
                        "index": i, "ref": ref_id, "ok": false,
                        "error_kind": "invalid_params",
                        "error": format!("bad ref format: {:?}", ref_id),
                    }));
                    continue;
                }
            };
            let entry = match numbered.get(idx) {
                Some(e) => e,
                None => {
                    results.push(serde_json::json!({
                        "index": i, "ref": ref_id, "ok": false,
                        "error_kind": "stale_ref",
                        "error": format!("ref {:?} out of range ({} numbered nodes); UI changed since observe", ref_id, numbered.len()),
                    }));
                    continue;
                }
            };

            // 3. cycle 占位编号拒绝执行（round1 review03 F2：占位节点在编号序列里
            //    占位（对齐 OutlineMapper），但 live 元素是环回祖先——点它 = 点错对象）。
            if entry.is_cycle {
                results.push(serde_json::json!({
                    "index": i, "ref": ref_id, "ok": false,
                    "error_kind": "ax_unsupported_action",
                    "error": "ref points to a cycle-placeholder node (AX tree loop); pick a concrete element",
                }));
                continue;
            }

            // 4. 三元组 stale 检测（walk 期基线 vs 执行期现值）
            if let Err(msg) = verify_not_stale(entry) {
                results.push(serde_json::json!({
                    "index": i, "ref": ref_id, "ok": false,
                    "error_kind": "stale_ref",
                    "error": msg,
                }));
                continue;
            }

            // 5. 每元素消息超时 1.0s（防挂死 app 拖垮整批；失败不致命继续执行）
            let _ = entry.el.set_messaging_timeout(1.0);

            let exec_result = match kind {
                "click" => do_click(entry),
                "type" => {
                    let text = a.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    do_type(entry, text)
                }
                "scroll" => do_scroll(entry),
                _ => unreachable!("guarded above: kind ∈ click/type/scroll"),
            };
            match exec_result {
                Ok(()) => results.push(serde_json::json!({
                    "index": i, "ref": ref_id, "ok": true, "kind": kind,
                })),
                Err((error_kind, msg)) => results.push(serde_json::json!({
                    "index": i, "ref": ref_id, "ok": false,
                    "error_kind": error_kind,
                    "error": msg,
                })),
            }
        }

        Response::ok(id, serde_json::json!({ "actions_and_results": results }))
    }

    /// 解析 "@eN" → N。
    fn parse_ref_index(ref_id: &str) -> Option<usize> {
        let n = ref_id.strip_prefix("@e")?;
        n.parse::<usize>().ok()
    }

    /// walk 期编号捕获的元素 + 三元组基线。
    /// `is_cycle`：编号槽位对应 walked 树的 cycle 占位节点（防环剪枝产物）——
    /// 编号必须为它保留位置（与 OutlineMapper/collect_matches 对齐），但不可执行。
    struct ResolvedElem {
        el: AXUIElement,
        raw_role: String,
        label: String,
        rect: AxRect,
        is_cycle: bool,
    }

    /// walked 树（AxNode）与 live 元素序列（walk 期前序收集）锁步编号。
    ///
    /// 与 collect_matches 的谓词**逐字一致**（label 非空小写包含 + mapped role 相等），
    /// 与 OutlineMapper 的 @eN 前序分配同序——因为三者消费的是**同一棵 walk() 产物**
    /// （round1 review03 F2：act 不再有独立遍历，错位在构造上不可能）。
    fn number_refs(
        node: &AxNode,
        live: &[AXUIElement],
        cursor: &mut usize,
        where_text: Option<&str>,
        where_role: Option<&str>,
        out: &mut Vec<ResolvedElem>,
    ) {
        let el = live.get(*cursor).cloned();
        *cursor += 1;
        if let Some(el) = el {
            let text_match = where_text.map_or(true, |t| {
                !node.label.is_empty() && node.label.to_lowercase().contains(&t.to_lowercase())
            });
            let role_match = where_role.map_or(true, |r| node.role == r);
            let take = if where_text.is_some() || where_role.is_some() {
                text_match && role_match
            } else {
                true
            };
            if take {
                out.push(ResolvedElem {
                    el,
                    raw_role: node.raw_role.clone(),
                    label: node.label.clone(),
                    rect: node.rect.clone(),
                    is_cycle: node.raw_role == "AXCycleGuard",
                });
            }
        }
        for child in &node.children {
            number_refs(child, live, cursor, where_text, where_role, out);
        }
    }

    /// 三元组 stale 检测：role 精确 / label 精确（基线非空时）/ rect 中心漂移 ≤50px。
    /// 基线 = walk 期（collect_resolved）捕获值；现值 = 执行期重读。
    fn verify_not_stale(entry: &ResolvedElem) -> Result<(), String> {
        let cur_raw_role = entry
            .el
            .attribute(&AXAttribute::role())
            .map(|s: CFString| s.to_string())
            .unwrap_or_default();
        let cur_label = entry
            .el
            .attribute(&AXAttribute::title())
            .map(|s: CFString| s.to_string())
            .unwrap_or_default();
        let cur_rect = read_rect(&entry.el);

        if cur_raw_role != entry.raw_role {
            return Err(format!(
                "stale_ref: role changed {:?} -> {:?}",
                entry.raw_role, cur_raw_role
            ));
        }
        if !entry.label.is_empty() && cur_label != entry.label {
            return Err(format!(
                "stale_ref: label changed {:?} -> {:?}",
                entry.label, cur_label
            ));
        }
        let base_cx = entry.rect.x + entry.rect.w / 2.0;
        let base_cy = entry.rect.y + entry.rect.h / 2.0;
        let cur_cx = cur_rect.x + cur_rect.w / 2.0;
        let cur_cy = cur_rect.y + cur_rect.h / 2.0;
        let drift = ((base_cx - cur_cx).powi(2) + (base_cy - cur_cy).powi(2)).sqrt();
        if drift > 50.0 {
            return Err(format!("stale_ref: rect center drifted {drift:.0}px"));
        }
        Ok(())
    }

    /// 元素 action 名清单（AXActionNames；读失败返空清单——执行期会再失败并归因）。
    fn action_names_of(el: &AXUIElement) -> Vec<String> {
        el.action_names()
            .map(|arr| arr.iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    }

    /// click：AXActionNames 前置校验 → AXPress。
    fn do_click(entry: &ResolvedElem) -> Result<(), (String, String)> {
        let names = action_names_of(&entry.el);
        if !names.iter().any(|n| n == "AXPress") {
            return Err((
                "ax_action_unsupported".into(),
                format!("AXPress not in AXActions {:?} for role {:?}", names, entry.raw_role),
            ));
        }
        entry
            .el
            .perform_action(&CFString::new("AXPress"))
            .map_err(|e| ("ax_perform_failed".into(), format!("AXPress: {e:?}")))
    }

    /// type：AXValue settable 前置校验 → AXSetValue → 写后读回比对（secure 豁免）。
    fn do_type(entry: &ResolvedElem, text: &str) -> Result<(), (String, String)> {
        let value_attr = AXAttribute::<CFType>::new(&CFString::new("AXValue"));
        let settable = entry
            .el
            .is_settable(&value_attr)
            .map_err(|e| ("ax_unavailable".into(), format!("is_settable(AXValue): {e:?}")))?;
        if !settable {
            return Err((
                "ax_action_unsupported".into(),
                format!("AXValue not settable for role {:?} (Electron 吞 AXSetValue 时走档2/3)", entry.raw_role),
            ));
        }
        let cf_text = CFString::new(text);
        let cf_value: CFType = cf_text.clone().into_CFType();
        entry
            .el
            .set_attribute(&value_attr, cf_value)
            .map_err(|e| ("ax_set_failed".into(), format!("AXSetValue: {e:?}")))?;

        // secure 字段豁免读回（AXSecureTextField 值被遮蔽，读回必不等）
        if entry.raw_role.contains("Secure") {
            return Ok(());
        }
        // 写后读回验证（事件送达 ≠ 语义成功）
        let read_back = entry
            .el
            .attribute::<CFType>(&value_attr)
            .map_err(|e| ("ax_verify_failed".into(), format!("read-back: {e:?}")))?;
        let got: String = read_back
            .downcast_into::<CFString>()
            .map(|s| s.to_string())
            .unwrap_or_default();
        if got != text {
            return Err((
                "ax_verify_failed".into(),
                format!("read-back mismatch: wrote {:?} chars, read {:?}", text.len(), got.len()),
            ));
        }
        Ok(())
    }

    /// scroll：AXScrollToVisible（AXAPI 无按像素滚动原语；细粒度滚轮是档3 CGEvent 域）。
    fn do_scroll(entry: &ResolvedElem) -> Result<(), (String, String)> {
        let names = action_names_of(&entry.el);
        // AXScrollToVisible 通常由可滚祖先透传到后代表现；元素自身无此 action 即不支持
        if !names.iter().any(|n| n == "AXScrollToVisible") {
            return Err((
                "ax_action_unsupported".into(),
                format!("AXScrollToVisible not in AXActions {:?}", names),
            ));
        }
        entry
            .el
            .perform_action(&CFString::new("AXScrollToVisible"))
            .map_err(|e| ("ax_perform_failed".into(), format!("AXScrollToVisible: {e:?}")))
    }

    fn collect_matches(
        node: &AxNode,
        want_text: Option<&str>,
        want_role: Option<&str>,
        out: &mut Vec<serde_json::Value>,
        ref_counter: &mut usize,
    ) {
        let text_match = want_text.map_or(true, |t| {
            !node.label.is_empty() && node.label.to_lowercase().contains(&t.to_lowercase())
        });
        let role_match = want_role.map_or(true, |r| node.role == r);
        if text_match && role_match {
            let ref_id = format!("@e{}", *ref_counter);
            *ref_counter += 1;
            out.push(serde_json::json!({
                "ref": ref_id,
                "role": node.role,
                "label": node.label,
                "rect": node.rect,
            }));
        }
        for child in &node.children {
            collect_matches(child, want_text, want_role, out, ref_counter);
        }
    }

    /// v1.11（round1 T8）：web wrapper 判定（agent-desktop is_web_wrapper 同款）。
    /// AXGroup / AXGenericElement 且无 title 且无 value → Electron/WebView 的
    /// 纯布局容器；其子代深度不 +1（wrapper 链不消耗 max_depth 预算——
    /// 修复 Electron 内容不可达：30 层 div wrapper 之前直接吃光 8 层预算）。
    fn is_web_wrapper(raw_role: &str, label: &str, has_value: bool) -> bool {
        (raw_role == "AXGroup" || raw_role == "AXGenericElement")
            && label.is_empty()
            && !has_value
    }

    /// 递归 walk，逐节点读 role/title/position/size/enabled/focused/children。
    ///
    /// v1.11（round1 T8 walk 剪枝 v2）：
    ///  - `visited`：已访问元素指针集合（防 AX 树环——真实世界 Electron/自绘 app
    ///    偶发 children 指回祖先；环树不耗尽预算不挂死）。HashSet O(1)（round1
    ///    review03 F4：dense app 数万节点下 Vec::contains O(n²) 是延迟地雷）
    ///  - `skeleton`：max_depth 边界节点填 children_count（真实子数）而非静默空——
    ///    dense app（Slack/IDE）token 成本数量级下降且保留「下面还有」信号
    ///  - web wrapper 链子代深度不 +1（见 is_web_wrapper）
    ///  - `live`（round1 review03 F2）：按本遍历前序同步收集 live AXUIElement
    ///    （含 cycle 占位的位置对位元素）。act 的 @eN 重编号靠它与 walked 树
    ///    锁步——单一真源 = walk()，snapshot/find/act 三路编号天然一致
    ///    （F2 事故：act 曾用独立 collect_resolved 严格深度遍历，与 walk 的
    ///    wrapper 中和/防环语义漂移，Electron app 上 find 12 命中 vs act 14
    ///    编号——@eN 错位点击。实测复现后重构为单一真源）。
    fn walk(
        el: &AXUIElement,
        depth: usize,
        max_depth: usize,
        skeleton: bool,
        visited: &mut std::collections::HashSet<usize>,
        live: &mut Vec<AXUIElement>,
    ) -> AxNode {
        // 防环：指针身份已访问 → 剪枝（不再递归；返占位空节点）。
        // live 仍推入本元素（占位节点在编号序列里占一个槽——与 OutlineMapper /
        // collect_matches 看到的树逐位对齐；act 侧对占位编号拒绝执行）。
        let ptr_id = el.as_concrete_TypeRef() as usize;
        if visited.contains(&ptr_id) {
            live.push(el.clone());
            return AxNode {
                role: "cycle".into(),
                raw_role: "AXCycleGuard".into(),
                label: String::new(),
                rect: AxRect::default(),
                enabled: false,
                focused: false,
                depth,
                children: Vec::new(),
                window_id: None,
                children_count: None,
            };
        }
        visited.insert(ptr_id);
        live.push(el.clone());

        let raw_role = el.attribute(&AXAttribute::role())
            .map(|s: CFString| s.to_string())
            .unwrap_or_default();
        let title = el.attribute(&AXAttribute::title())
            .map(|s: CFString| s.to_string())
            .unwrap_or_default();
        let enabled = el
            .attribute(&AXAttribute::enabled())
            .map(|b: CFBoolean| b == CFBoolean::true_value())
            .unwrap_or(true);
        let focused = el
            .attribute(&AXAttribute::focused())
            .map(|b: CFBoolean| b == CFBoolean::true_value())
            .unwrap_or(false);
        let rect = read_rect(el);
        let has_value = el
            .attribute::<CFType>(&AXAttribute::<CFType>::new(&CFString::new("AXValue")))
            .is_ok();
        let wrapper = is_web_wrapper(&raw_role, &title, has_value);

        let mut children_count: Option<usize> = None;
        let children = if depth < max_depth {
            match el.attribute::<CFArray<AXUIElement>>(&AXAttribute::children()) {
                Ok(arr) => {
                    // web wrapper 子代深度不 +1（wrapper 链不消耗预算）
                    let child_depth = if wrapper { depth } else { depth + 1 };
                    arr.iter()
                        .map(|c| walk(&*c, child_depth, max_depth, skeleton, visited, live))
                        .collect()
                }
                Err(_) => Vec::new(),
            }
        } else {
            // v1.11 T8 skeleton：边界节点填真实子数（子树省略但保留规模信号）
            if skeleton {
                if let Ok(arr) =
                    el.attribute::<CFArray<AXUIElement>>(&AXAttribute::children())
                {
                    children_count = Some(arr.len() as usize);
                }
            }
            Vec::new()
        };

        AxNode {
            role: map_ax_role(&raw_role).to_string(),
            raw_role,
            label: title,
            rect,
            enabled,
            focused,
            depth,
            children,
            window_id: None,
            children_count,
        }
    }

    /// 读 AXPosition + AXSize 合成 AxRect；任一失败返回 default。
    ///
    /// 直接走 FFI（不在 safe wrapper 预定义 trait 里）；release 由 CFRelease 守。
    fn read_rect(el: &AXUIElement) -> AxRect {
        let pos = read_point(el, "AXPosition");
        let size = read_size(el, "AXSize");
        match (pos, size) {
            (Some(p), Some(s)) => AxRect { x: p.x, y: p.y, w: s.width, h: s.height },
            _ => AxRect::default(),
        }
    }

    fn read_point(el: &AXUIElement, attr: &str) -> Option<CGPoint> {
        let cf_str = CFString::new(attr);
        let mut raw: core_foundation_sys::base::CFTypeRef = std::ptr::null();
        let out: CFType = unsafe {
            let err = AXUIElementCopyAttributeValue(
                el.as_concrete_TypeRef(),
                cf_str.as_concrete_TypeRef(),
                &mut raw,
            );
            if err != 0 || raw.is_null() {
                return None;
            }
            // raw 现在是 AXValueRef（实质 CFTypeRef 子类）；用 CFType 包住自动 release
            CFType::wrap_under_create_rule(raw)
        };
        let value_ref = out.as_CFTypeRef() as AXValueRef;
        let mut point = CGPoint { x: 0.0, y: 0.0 };
        let ok = unsafe {
            AXValueGetValue(value_ref, AX_VALUE_TYPE_CG_POINT, &mut point as *mut _ as *mut std::ffi::c_void)
        };
        drop(out); // CFType drop 释放 AXValueRef
        if ok { Some(point) } else { None }
    }

    fn read_size(el: &AXUIElement, attr: &str) -> Option<CGSize> {
        let cf_str = CFString::new(attr);
        let mut raw: core_foundation_sys::base::CFTypeRef = std::ptr::null();
        let out: CFType = unsafe {
            let err = AXUIElementCopyAttributeValue(
                el.as_concrete_TypeRef(),
                cf_str.as_concrete_TypeRef(),
                &mut raw,
            );
            if err != 0 || raw.is_null() {
                return None;
            }
            CFType::wrap_under_create_rule(raw)
        };
        let value_ref = out.as_CFTypeRef() as AXValueRef;
        let mut size = CGSize { width: 0.0, height: 0.0 };
        let ok = unsafe {
            AXValueGetValue(value_ref, AX_VALUE_TYPE_CG_SIZE, &mut size as *mut _ as *mut std::ffi::c_void)
        };
        drop(out);
        if ok { Some(size) } else { None }
    }

    /// 解析 root：app=None → system_wide；Some → application_with_bundle。
    fn resolve_root(app: Option<&str>) -> Result<AXUIElement, String> {
        if !tcc::accessibility_granted() {
            return Err("tcc_denied".into());
        }
        match app {
            None => Ok(AXUIElement::system_wide()),
            // Accept BOTH bundle ids ("com.apple.finder") AND human names ("Finder").
            // parse4 §6.1 acceptance #1 + DESKTOP_DESCRIPTION use human names. The safe
            // `application_with_bundle` only resolves bundle ids, so a name without a dot
            // is mapped through `bundle_id_for_app_name` (curated table) first.
            Some(name) => {
                let bundle = if name.contains('.') {
                    name.to_string()
                } else {
                    match crate::app_bundle_map::bundle_id_for_app_name(name) {
                        Some(b) => b.to_string(),
                        None => return Err("app_not_found".to_string()),
                    }
                };
                AXUIElement::application_with_bundle(&bundle).map_err(|e| {
                    if matches!(e, accessibility::Error::NotFound) {
                        "app_not_found".to_string()
                    } else {
                        "ax_unavailable".to_string()
                    }
                })
            }
        }
    }

    // ========================================================================
    // v1.11 round1 T3 单元测试（纯逻辑路径；真机 AXAPI 路径归手测清单 E1-E5）
    // ========================================================================
    #[cfg(test)]
    mod act_tests {
        use super::*;

        #[test]
        fn act_requires_actions_array() {
            let r = act("t", &serde_json::json!({}));
            assert!(!r.ok);
            assert_eq!(r.error_kind.as_deref(), Some("invalid_params"));
        }

        #[test]
        fn parse_ref_index_accepts_valid_and_rejects_garbage() {
            assert_eq!(parse_ref_index("@e0"), Some(0));
            assert_eq!(parse_ref_index("@e42"), Some(42));
            assert_eq!(parse_ref_index("@e-1"), None); // 负数非法
            assert_eq!(parse_ref_index("@ex"), None); // 非数字
            assert_eq!(parse_ref_index("e0"), None); // 缺 @e 前缀
            assert_eq!(parse_ref_index(""), None);
            assert_eq!(parse_ref_index("@e99999999999999999999"), None); // usize 溢出
        }

        /// 无 TCC 环境（CI）下 act 的 resolve_root 预检路径：
        /// tcc_denied → 错误响应（不是 panic / not_implemented）。
        /// 有 TCC 的开发机上这条测试可能走真 walk —— 断言只要求 ok 或 tcc_denied
        /// 之一，不依赖真机 UI 状态（守 CI 稳定）。
        #[test]
        fn act_never_returns_not_implemented() {
            let r = act(
                "t",
                &serde_json::json!({
                    "actions": [{"kind": "click", "ref": "@e0"}]
                }),
            );
            // 占位已废除（round1 T3）——not_implemented 禁再现
            assert_ne!(r.error_kind.as_deref(), Some("not_implemented"));
        }

        /// v1.11 T8：web wrapper 判定（纯函数；Electron 布局容器深度中和）
        #[test]
        fn web_wrapper_detection() {
            // AXGroup 无 title 无 value → wrapper
            assert!(is_web_wrapper("AXGroup", "", false));
            assert!(is_web_wrapper("AXGenericElement", "", false));
            // 有 title / 有 value / 其他 role → 非 wrapper
            assert!(!is_web_wrapper("AXGroup", "Toolbar", false));
            assert!(!is_web_wrapper("AXGroup", "", true));
            assert!(!is_web_wrapper("AXGenericElement", "Close", false));
            assert!(!is_web_wrapper("AXButton", "", false));
            assert!(!is_web_wrapper("AXWindow", "", false));
            assert!(!is_web_wrapper("", "", false));
        }

        /// press/hotkey 是档3 domain：即使 walk 全失败也必须在逐项结果里
        /// 标 ax_unsupported_action（而非顶层 invalid_params）。
        /// CI 无 TCC → resolve_root 挂 tcc_denied，本测试只验 invalid_params 之后的
        /// 分派形状；有 TCC 环境下验证逐项结果。两分支都合法。
        #[test]
        fn act_invalid_params_only_for_missing_actions() {
            // actions 存在但形状怪（无 kind）→ 不顶层拒；逐项处理
            let r = act(
                "t",
                &serde_json::json!({
                    "actions": [{"ref": "@e0"}]
                }),
            );
            assert_ne!(r.error_kind.as_deref(), Some("invalid_params"));
        }
    }
}

#[cfg(target_os = "macos")]
pub use platform::{act, find, snapshot};
