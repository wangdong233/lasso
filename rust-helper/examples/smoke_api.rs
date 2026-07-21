//! AXAPI smoke test (parse4 §4.1 未确认风险 — 必做).
//!
//! 经验性确认 accessibility 0.2 + accessibility-sys 0.2 真实暴露的符号，
//! 据此决定 src/ax.rs 走 safe API 还是 FFI。
//!
//! 运行：
//!     cd rust-helper && cargo run --example smoke_api

use accessibility::{AXAttribute, AXUIElement};
use accessibility_sys::{
    AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElementCopyMultipleAttributeValues,
};
use core_foundation::{
    array::CFArray, base::TCFType, boolean::CFBoolean, string::CFString,
};

fn main() {
    println!("== AXAPI smoke test ==");

    // 1. TCC trusted 探测 — safe 与 FFI 都可达
    let trusted_sys = unsafe { AXIsProcessTrusted() };
    let trusted_opts = unsafe { AXIsProcessTrustedWithOptions(std::ptr::null_mut()) };
    println!("AXIsProcessTrusted() = {trusted_sys}");
    println!("AXIsProcessTrustedWithOptions(NULL) = {trusted_opts}");

    // 2. safe API 构造 system-wide root（无需手动 FFI + retain/release）
    let root = AXUIElement::system_wide();
    println!("AXUIElement::system_wide() OK");

    // 3. safe .attribute_names()
    match root.attribute_names() {
        Ok(names) => println!("attribute_names count = {}", names.len()),
        Err(e) => println!("attribute_names ERR = {:?}", e),
    }

    // 4. safe .attribute::<T>(&AXAttribute<T>) typed reads
    let role: Result<CFString, _> = root.attribute(&AXAttribute::role());
    let title: Result<CFString, _> = root.attribute(&AXAttribute::title());
    let enabled: Result<CFBoolean, _> = root.attribute(&AXAttribute::enabled());
    let focused: Result<CFBoolean, _> = root.attribute(&AXAttribute::focused());
    println!("safe .attribute → role={:?} title={:?} enabled={:?} focused={:?}", role, title, enabled, focused);

    // 5. children via safe .attribute(&AXAttribute::children()) -> CFArray<AXUIElement>
    let children: Result<CFArray<AXUIElement>, _> = root.attribute(&AXAttribute::children());
    let n = children.as_ref().map(|v| v.len()).unwrap_or(0);
    println!("safe .attribute(&children) → count = {n}");
    if let Ok(kids) = children {
        for (i, kid) in kids.iter().take(3).enumerate() {
            let r: Result<CFString, _> = kid.attribute(&AXAttribute::role());
            println!("  child[{i}] role = {:?}", r.map(|s| s.to_string()));
        }
    }

    // 6. AXPosition / AXSize — 不在预定义 trait 里，必须 raw FFI + AXValueGetValue
    //    见 src/ax.rs::read_rect() 的最终写法（这里只 print 探测结果）
    let position_attr = CFString::from_static_string("AXPosition");
    let probe = AXAttribute::<core_foundation::base::CFType>::new(&position_attr);
    let pos_read = root.attribute(&probe);
    println!("safe .attribute(&custom \"AXPosition\") ok = {}", pos_read.is_ok());

    // 7. batch read — FFI 可达（符号存在）；但解析 CFArray<CFType> 复杂
    //    我们经验性调用（不期望在 system-wide 上成功，只验证 link 通过）
    use core_foundation_sys::array::CFArrayRef;
    let mut out: CFArrayRef = std::ptr::null_mut();
    let names_arr = CFArray::from_CFTypes(&[
        CFString::from_static_string("AXRole").as_CFType(),
        CFString::from_static_string("AXTitle").as_CFType(),
    ]);
    let _err = unsafe {
        AXUIElementCopyMultipleAttributeValues(
            root.as_concrete_TypeRef(),
            names_arr.as_concrete_TypeRef(),
            0,
            &mut out,
        )
    };
    println!("AXUIElementCopyMultipleAttributeValues symbol = reachable (link OK)");

    println!("\n== smoke test done ==");
    println!("DECISION: safe API 够用；批读 FFI 可达但解析复杂 → Phase A 用逐属性 .attribute() + FFI 兜底 AXPosition/AXSize。");
}
