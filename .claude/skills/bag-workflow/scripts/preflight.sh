#!/usr/bin/env bash
# bag-workflow preflight — お描き取得とブラウザ連携の前提を「決定的に」検査する。
# Deterministically probes the prerequisites so the skill branches on facts, not guesses.
#
# 出力 / Output:
#   - 人間向けの数行サマリ（非エンジニアがそのまま読める）
#   - 末尾に Claude 向けの 1 行 `STATUS ...`（分岐判断に使う）
# スタックトレースは一切出さない（落ちても STATUS を返す）。Never prints a stack trace.
set -u

DAEMON_HEALTHZ="${BAG_VF_HEALTHZ:-http://127.0.0.1:8765/healthz}"
# 既定は best-effort（Unix の典型値）。実保存先はブラウザ設定依存で異なりうる（移動済み/Edge・Brave/Windows）。
# 権威的な値は下の healthz の inboxDir（拡張の報告で自動追従する）。BAG_VF_INBOX で明示上書きも可。
INBOX="${BAG_VF_INBOX:-$HOME/Downloads/ai-inbox}"

# --- 1) daemon が起きているか / is the daemon up? -----------------------------
health="$(curl -s -m 2 "$DAEMON_HEALTHZ" 2>/dev/null || true)"
if [ -n "$health" ]; then
  daemon="up"
  # healthz は {"ok":true,"inboxDir":"..."} を返す。inboxDir を採用する。
  inbox_from_health="$(printf '%s' "$health" | sed -n 's/.*"inboxDir":"\([^"]*\)".*/\1/p')"
  [ -n "$inbox_from_health" ] && INBOX="$inbox_from_health"
else
  daemon="down"
fi

# --- 2) inbox に最近のお描きがあるか / latest capture? ------------------------
latest=""
if [ -d "$INBOX" ]; then
  # done/ を除外し、shot.png を持つ最新ディレクトリを 1 件。
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    case "$d" in */done/) continue;; esac
    if [ -f "${d}shot.png" ]; then latest="$d"; break; fi
  done <<EOF
$(ls -dt "$INBOX"/*/ 2>/dev/null)
EOF
fi
[ -n "$latest" ] && capture="yes" || capture="no"

# --- 3) Claude Code に bag_visual_feedback MCP が登録されているか / registered? ----
# claude mcp list は MCP の health check で数秒かかることがある。失敗は absent 扱い。
if command -v claude >/dev/null 2>&1 && claude mcp list 2>/dev/null | grep -qi 'bag_visual_feedback'; then
  mcp="registered"
else
  mcp="absent"
fi

# --- 4) ライブページを読むブラウザ手段 / live-browser reader ------------------
if command -v playwright-cli >/dev/null 2>&1; then
  pw_ver="$(playwright-cli --version 2>/dev/null | head -1)"
  browser="playwright-cli"
  browser_detail="playwright-cli ${pw_ver}"
else
  browser="none"
  browser_detail="none (playwright-cli 未インストール)"
fi

# --- 分岐判断 / branch decision ----------------------------------------------
# お描きの取得経路: MCP(主) > FILE(救済) > NONE(お描き無し)
if [ "$mcp" = "registered" ]; then
  source_branch="MCP"
elif [ "$capture" = "yes" ]; then
  source_branch="FILE"
else
  source_branch="NONE"
fi

echo "── bag-workflow preflight ──────────────────────────────"
echo "daemon   : $daemon        (healthz: $DAEMON_HEALTHZ)"
echo "inbox    : $INBOX"
echo "capture  : $capture${latest:+   最新: $latest}"
echo "mcp      : $mcp   (Claude Code の bag_visual_feedback 登録)"
echo "browser  : $browser_detail"
echo "─────────────────────────────────────────────────────────"
echo "STATUS daemon=$daemon mcp=$mcp capture=$capture browser=$browser source_branch=$source_branch inbox=$INBOX latest=${latest:-none}"
