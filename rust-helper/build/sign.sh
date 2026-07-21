#!/bin/bash
# lasso-rust-helper build + Developer ID sign（parse4 §3.1.7 + §4.5）。
#
# 用法：
#   ./build/sign.sh                              # cargo build only（DEV_ID 未设 → 跳过签名）
#   LASSO_DEV_ID="Developer ID Application: ..." ./build/sign.sh
#
# 关键事实（README §TCC 持久化原理 详）：
#   - 未签名的 binary 每次 rebuild 后 cdhash 变 → TCC.db 失效 → 重弹授权框
#   - Developer ID 签名后 cdhash 稳定 → TCC 授权持久（仍需首次手动授权）
#   - Hardened Runtime（--options runtime）是 notarization 的前置；本脚本带上无害
#   - 用户须自行申请 Apple Developer 账号（$99/年）

set -euo pipefail
set -x

cd "$(dirname "$0")/.."

# 1. cargo build --release
cargo build --release

HELPER="target/release/lasso-rust-helper"

if [[ -z "${LASSO_DEV_ID:-}" ]]; then
    echo ""
    echo "⚠️  LASSO_DEV_ID 未设置 — 跳过 codesign 步骤。"
    echo "    未签名的 binary 每次 rebuild 后 TCC.db 会失效（重弹 Accessibility 授权框）。"
    echo "    设置 LASSO_DEV_ID='Developer ID Application: Your Name (TEAMID)' 后重跑本脚本。"
    echo ""
    echo "    Helper 路径：$(pwd)/$HELPER"
    exit 0
fi

# 2. codesign — Developer ID + Hardened Runtime
codesign --force --options runtime --timestamp --sign "$LASSO_DEV_ID" "$HELPER"

# 3. 验证签名
codesign -dvvv "$HELPER" 2>&1 | grep -E "Authority|TeamIdentifier|CodeDirectory|flags" || true

echo ""
echo "✅ Signed: $(pwd)/$HELPER"
echo ""
echo "首次运行："
echo "  1. 双击运行 helper（或调 Lasso desktop 工具）"
echo "  2. System Settings → Privacy → Accessibility → 添加 lasso-rust-helper"
echo "  3. （截屏需要）System Settings → Privacy → Screen Recording → 添加 lasso-rust-helper"
echo ""
echo "之后 rebuild 不再重弹（同 Developer ID 下 cdhash 稳定）。"

# 可选 notarization（macOS 10.15+ 推荐）：
#   ditto -c -k --keepParent "$HELPER" "$HELPER.zip"
#   xcrun notarytool submit "$HELPER.zip" \
#     --apple-id "you@example.com" \
#     --team-id "TEAMID" \
#     --password "app-specific-password" \
#     --wait
#   xcrun stapler staple "$HELPER"
