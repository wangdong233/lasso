//! CGWindowList 截屏（parse4 §3.1.5）。
//!
//! 策略：
//!   - 预检 `tcc::screen_recording_granted()`；false → error_kind="tcc_screen_recording_denied"
//!   - 支持 region 指定（params.screenshot_region={x,y,w,h}）；未指定 → 主屏全屏
//!   - CGDisplay::screenshot() safe wrapper（core-graphics 0.24 暴露）
//!   - PNG encode via ImageIO FFI（macOS native；AppKit/ApplicationServices 通过 cocoa 传递链接）
//!   - base64 输出到协议层
//!
//! 非 macOS：返回 error_kind="not_macos"。

use crate::protocol::Response;
use crate::tcc;

#[cfg(not(target_os = "macos"))]
pub fn capture(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "screenshot requires macOS")
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use base64::{engine::general_purpose, Engine as _};
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_foundation_sys::base::{CFAllocatorRef, CFIndex};
    use core_foundation_sys::data::CFDataRef;
    use core_graphics::display::{
        kCGNullWindowID, kCGWindowImageDefault, kCGWindowListOptionOnScreenOnly, CGDisplay,
    };
    use core_graphics::image::CGImage;
    use core_graphics_types::geometry::{CGPoint, CGRect, CGSize};
    use foreign_types_shared::ForeignType;
    use std::ptr;

    /// 全屏或指定区域 PNG base64。
    pub fn capture(id: &str, params: &serde_json::Value) -> Response {
        if !tcc::screen_recording_granted() {
            return Response::err(
                id,
                "tcc_screen_recording_denied",
                "System Settings → Privacy → Screen Recording 授权 helper 后重试",
            );
        }

        let region = parse_region(params);
        let image = match capture_image(region) {
            Some(img) => img,
            None => {
                return Response::err(
                    id,
                    "ax_unavailable",
                    "CGWindowListCreateImage returned null (TCC revoked or empty region?)",
                );
            }
        };

        let (w, h) = (image.width() as u64, image.height() as u64);
        let png_bytes = match encode_png(&image) {
            Ok(b) => b,
            Err(e) => return Response::err(id, "ax_unavailable", format!("png encode: {e}")),
        };
        let b64 = general_purpose::STANDARD.encode(&png_bytes);

        Response::ok(
            id,
            serde_json::json!({
                "format": "png",
                "width": w,
                "height": h,
                "base64": b64,
            }),
        )
    }

    fn parse_region(params: &serde_json::Value) -> Option<CGRect> {
        let r = params.get("screenshot_region")?;
        let x = r.get("x")?.as_f64()?;
        let y = r.get("y")?.as_f64()?;
        let w = r.get("w")?.as_f64()?;
        let h = r.get("h")?.as_f64()?;
        Some(CGRect {
            origin: CGPoint::new(x, y),
            size: CGSize::new(w, h),
        })
    }

    /// CGWindowListCreateImage：region=None → 主屏全屏（CGRectInfinite 等价）；Some → 该 rect。
    fn capture_image(region: Option<CGRect>) -> Option<CGImage> {
        // region=None → 用主屏 bounds 作「全屏」
        let bounds = region.unwrap_or_else(|| CGDisplay::main().bounds());
        CGDisplay::screenshot(
            bounds,
            kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
            kCGWindowImageDefault,
        )
    }

    /// CGImage → PNG bytes via ImageIO（macOS native）。
    ///
    /// ImageIO 通过 ApplicationServices framework（cocoa → AppKit → ApplicationServices）传递链接，
    /// 无需 build.rs 显式 link。
    fn encode_png(image: &CGImage) -> Result<Vec<u8>, String> {
        extern "C" {
            fn CFDataCreateMutable(alloc: CFAllocatorRef, capacity: CFIndex) -> CFDataRef;
            fn CGImageDestinationCreateWithData(
                data: CFDataRef,
                type_id: *const std::ffi::c_void, // CFStringRef
                count: CFIndex,
                options: *const std::ffi::c_void,
            ) -> *mut std::ffi::c_void;
            fn CGImageDestinationAddImage(
                dest: *mut std::ffi::c_void,
                image: *const std::ffi::c_void, // CGImageRef
                properties: *const std::ffi::c_void,
            ) -> bool;
            fn CGImageDestinationFinalize(dest: *mut std::ffi::c_void) -> bool;
        }

        unsafe {
            let data_ref = CFDataCreateMutable(ptr::null_mut(), 0);
            if data_ref.is_null() {
                return Err("CFDataCreateMutable null".into());
            }

            // ImageIO UTI: "public.png"
            let png_uti = CFString::from_static_string("public.png");
            let dest = CGImageDestinationCreateWithData(
                data_ref,
                png_uti.as_concrete_TypeRef() as *const _,
                1,
                ptr::null(),
            );
            if dest.is_null() {
                core_foundation_sys::base::CFRelease(data_ref as _);
                return Err("CGImageDestinationCreateWithData null".into());
            }

            if !CGImageDestinationAddImage(dest, image.as_ptr() as *const _, ptr::null()) {
                core_foundation_sys::base::CFRelease(dest as _);
                core_foundation_sys::base::CFRelease(data_ref as _);
                return Err("CGImageDestinationAddImage failed".into());
            }

            if !CGImageDestinationFinalize(dest) {
                core_foundation_sys::base::CFRelease(dest as _);
                core_foundation_sys::base::CFRelease(data_ref as _);
                return Err("CGImageDestinationFinalize failed".into());
            }

            let bytes_ptr = core_foundation_sys::data::CFDataGetBytePtr(data_ref);
            let len = core_foundation_sys::data::CFDataGetLength(data_ref);
            let slice = std::slice::from_raw_parts(bytes_ptr, len as usize);
            let out = slice.to_vec();

            core_foundation_sys::base::CFRelease(dest as _);
            core_foundation_sys::base::CFRelease(data_ref as _);

            Ok(out)
        }
    }
}

#[cfg(target_os = "macos")]
pub use platform::capture;
