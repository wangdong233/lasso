//! Human app name → bundle id mapping (parse4 §3.1.4 resolve_root 支撑)。
//!
//! 纯数据，无 AXAPI/平台依赖 → 可在 CI（含 Linux）单测。
//!
//! 设计理由：parse4 §6.1 acceptance #1 用人名（"Finder"/"Mail"）调 desktop snapshot，
//! 但 accessibility 0.2 的 `application_with_bundle` 只吃 bundle id。NSRunningApplication
//! 枚举选择子（`runningApplicationsWithOptions:` 等）在本 AppKit + Rust objc 桥下不可靠
//! （unrecognized selector），故 v0.3.5 落精选人名→bundle 表（覆盖 parse4 全部验收 app +
//! 常见第三方）。完整 NSWorkspace 枚举留 v0.4。

/// Map a human app name ("Finder"/"Mail"/"系统设置") to its bundle id.
/// Case-insensitive + trims whitespace. Returns None for names not in the table
/// (caller can then pass the bundle id directly, e.g. "com.apple.finder").
pub fn bundle_id_for_app_name(name: &str) -> Option<&'static str> {
    let n = name.trim().to_ascii_lowercase();
    static MAP: &[(&str, &str)] = &[
        // Apple built-in
        ("finder", "com.apple.finder"),
        ("mail", "com.apple.mail"),
        ("safari", "com.apple.Safari"),
        ("notes", "com.apple.Notes"),
        ("system settings", "com.apple.systempreferences"),
        ("system preferences", "com.apple.systempreferences"),
        ("preferences", "com.apple.systempreferences"),
        ("系统设置", "com.apple.systempreferences"),
        ("系统偏好设置", "com.apple.systempreferences"),
        ("messages", "com.apple.MobileSMS"),
        ("信息", "com.apple.MobileSMS"),
        ("calendar", "com.apple.calendar"),
        ("日历", "com.apple.calendar"),
        ("reminders", "com.apple.reminders"),
        ("提醒事项", "com.apple.reminders"),
        ("maps", "com.apple.Maps"),
        ("地图", "com.apple.Maps"),
        ("photos", "com.apple.Photos"),
        ("照片", "com.apple.Photos"),
        ("music", "com.apple.Music"),
        ("tv", "com.apple.TV"),
        ("podcasts", "com.apple.podcasts"),
        ("preview", "com.apple.preview"),
        ("textedit", "com.apple.TextEdit"),
        ("terminal", "com.apple.Terminal"),
        ("activity monitor", "com.apple.ActivityMonitor"),
        ("xcode", "com.apple.dt.Xcode"),
        ("app store", "com.apple.AppStore"),
        ("contacts", "com.apple.AddressBook"),
        ("通讯录", "com.apple.AddressBook"),
        ("dictionary", "com.apple.Dictionary"),
        ("font book", "com.apple.FontBook"),
        ("stickies", "com.apple.Stickies"),
        ("grab", "com.apple.Grab"),
        ("archive utility", "com.apple.archiveutility"),
        ("screentime", "com.apple.ScreenTime"),
        // Common third-party (well-known, stable bundle ids only)
        ("chrome", "com.google.Chrome"),
        ("google chrome", "com.google.Chrome"),
        ("firefox", "org.mozilla.firefox"),
        ("edge", "com.microsoft.edgemac"),
        ("microsoft edge", "com.microsoft.edgemac"),
        ("vscode", "com.microsoft.VSCode"),
        ("visual studio code", "com.microsoft.VSCode"),
        ("iterm", "com.googlecode.iterm2"),
        ("iterm2", "com.googlecode.iterm2"),
        ("slack", "com.tinyspeck.slackmacgap"),
        ("zoom", "us.zoom.xos"),
        ("spotify", "com.spotify.client"),
        ("discord", "com.hnc.Discord"),
        ("telegram", "ru.keepcoder.Telegram"),
        ("wechat", "com.tencent.xinWeChat"),
        ("微信", "com.tencent.xinWeChat"),
        ("dingtalk", "com.alibaba.DingTalk"),
        ("钉钉", "com.alibaba.DingTalk"),
        ("1password", "com.agilebits.onepassword-osx"),
    ];
    MAP.iter().find(|(k, _)| *k == n).map(|(_, v)| *v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_builtins() {
        assert_eq!(bundle_id_for_app_name("Finder"), Some("com.apple.finder"));
        assert_eq!(bundle_id_for_app_name("Mail"), Some("com.apple.mail"));
        assert_eq!(bundle_id_for_app_name("Safari"), Some("com.apple.Safari"));
        assert_eq!(bundle_id_for_app_name("Notes"), Some("com.apple.Notes"));
        assert_eq!(
            bundle_id_for_app_name("System Settings"),
            Some("com.apple.systempreferences")
        );
        assert_eq!(bundle_id_for_app_name("Xcode"), Some("com.apple.dt.Xcode"));
    }

    #[test]
    fn case_insensitive_and_trimmed() {
        assert_eq!(bundle_id_for_app_name("finder"), Some("com.apple.finder"));
        assert_eq!(bundle_id_for_app_name("FINDER"), Some("com.apple.finder"));
        assert_eq!(bundle_id_for_app_name("  Finder  "), Some("com.apple.finder"));
        assert_eq!(bundle_id_for_app_name("vScOdE"), Some("com.microsoft.VSCode"));
    }

    #[test]
    fn chinese_names() {
        assert_eq!(
            bundle_id_for_app_name("系统设置"),
            Some("com.apple.systempreferences")
        );
        assert_eq!(bundle_id_for_app_name("微信"), Some("com.tencent.xinWeChat"));
        assert_eq!(bundle_id_for_app_name("钉钉"), Some("com.alibaba.DingTalk"));
        assert_eq!(bundle_id_for_app_name("日历"), Some("com.apple.calendar"));
    }

    #[test]
    fn common_third_party() {
        assert_eq!(bundle_id_for_app_name("Chrome"), Some("com.google.Chrome"));
        assert_eq!(
            bundle_id_for_app_name("Firefox"),
            Some("org.mozilla.firefox")
        );
        assert_eq!(bundle_id_for_app_name("iTerm"), Some("com.googlecode.iterm2"));
        assert_eq!(bundle_id_for_app_name("Slack"), Some("com.tinyspeck.slackmacgap"));
        assert_eq!(bundle_id_for_app_name("WeChat"), Some("com.tencent.xinWeChat"));
    }

    #[test]
    fn unknown_returns_none() {
        assert_eq!(bundle_id_for_app_name("ZzzNope"), None);
        assert_eq!(bundle_id_for_app_name(""), None);
        // bundle ids themselves are NOT in the name table (resolve_root handles them
        // via the dot heuristic before calling this fn)
        assert_eq!(bundle_id_for_app_name("com.apple.finder"), None);
    }
}
