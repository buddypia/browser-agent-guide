#!/usr/bin/env bash
# 用語集ゲートを git の pre-commit hook として導入する(ローカル早期フィードバック)。
# CI(.github/workflows/glossary.yml)がサーバ側の最終ゲート。hook はあくまで補助。
#
# 使い方:  bash scripts/glossary/install-git-hook.sh
# 解除:    rm "$(git rev-parse --git-common-dir)/hooks/pre-commit"
# 緊急回避: git commit --no-verify (CI が後段で必ず捕捉する)
set -euo pipefail

HOOK_DIR="$(git rev-parse --git-common-dir)/hooks"
HOOK="$HOOK_DIR/pre-commit"
mkdir -p "$HOOK_DIR"

cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# [glossary] 用語集 validate + コード変更↔用語の staleness を pre-commit で検査。
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if [ ! -d glossary ]; then exit 0; fi
echo "[glossary] validate ..."
node scripts/glossary/validate.mjs
echo "[glossary] staleness (staged) ..."
node scripts/glossary/check-staleness.mjs --staged
EOF

chmod +x "$HOOK"
echo "✓ pre-commit hook を導入しました: $HOOK"
echo "  解除: rm \"$HOOK\"   緊急回避: git commit --no-verify"
