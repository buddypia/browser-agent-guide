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
ext_connected="unknown"; ext_ever_connected="unknown"; ext_last_push="none"
if [ -n "$health" ]; then
  daemon="up"
  # healthz は {"ok":true,"inboxDir":"..."} を返す。inboxDir を採用する。
  inbox_from_health="$(printf '%s' "$health" | sed -n 's/.*"inboxDir":"\([^"]*\)".*/\1/p')"
  [ -n "$inbox_from_health" ] && INBOX="$inbox_from_health"
  # healthz.extension = {connected, everConnected, lastConnectedAt, lastPushAt}。
  # 「daemon は起きているが拡張がまだ一度も繋がっていない」を capture=no と区別できる。
  ec="$(printf '%s' "$health" | sed -n -E 's/.*"connected":(true|false).*/\1/p')"
  eec="$(printf '%s' "$health" | sed -n -E 's/.*"everConnected":(true|false).*/\1/p')"
  elp="$(printf '%s' "$health" | sed -n -E 's/.*"lastPushAt":("[^"]*"|null).*/\1/p')"
  [ -n "$ec" ] && ext_connected="$ec"
  [ -n "$eec" ] && ext_ever_connected="$eec"
  [ -n "$elp" ] && [ "$elp" != "null" ] && ext_last_push="$elp"
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

# --- 3) Claude Code / Codex に bag_page_feedback MCP が登録されているか / registered? --
# claude mcp list は MCP の health check で数秒かかることがある。失敗は absent 扱い。
# 注: これは「claude/codex の設定に登録され、このコマンドを叩いた瞬間に疎通できたか」の
#     チェックであり、いま進行中の会話セッション自身がそのツールを呼べるかどうかとは別物。
#     Claude Code は MCP サーバーへの接続をセッション起動時に確立し、起動時点で接続に失敗すると
#     そのセッションでは(daemon が後から起動しても)自動回復しない。だから mcp=registered でも
#     ToolSearch でツールが見つからないことがある → SKILL.md 側で呼び出し前に必ず確認する。
mcp="absent"
mcp_conn="n/a"
if command -v claude >/dev/null 2>&1; then
  mcp_line="$(claude mcp list 2>/dev/null | grep -i 'bag_page_feedback' | head -1)"
  if [ -n "$mcp_line" ]; then
    mcp="registered"
    if printf '%s' "$mcp_line" | grep -qi 'connected'; then
      mcp_conn="connected"
    else
      mcp_conn="not-connected"
    fi
  fi
fi
if [ "$mcp" = "absent" ] && command -v codex >/dev/null 2>&1; then
  if codex mcp list 2>/dev/null | grep -qi 'bag_page_feedback'; then
    mcp="registered"
    mcp_conn="unknown"
  fi
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
# mcp_conn=not-connected(登録行はあるが疎通確認で ✔ Connected が出なかった)なら MCP へ倒さない。
if [ "$mcp" = "registered" ] && [ "$mcp_conn" != "not-connected" ]; then
  source_branch="MCP"
elif [ "$capture" = "yes" ]; then
  source_branch="FILE"
else
  source_branch="NONE"
fi

echo "── bag-workflow preflight ──────────────────────────────"
echo "daemon   : $daemon        (healthz: $DAEMON_HEALTHZ)"
echo "extension: connected=$ext_connected everConnected=$ext_ever_connected lastPush=$ext_last_push"
echo "           (everConnected=false なら拡張の Options で daemon 有効化・URL・token 未設定の疑い)"
echo "inbox    : $INBOX"
echo "capture  : $capture${latest:+   最新: $latest}"
echo "mcp      : $mcp / $mcp_conn   (Claude Code の bag_page_feedback 登録。registered は設定登録の"
echo "           意味のみ —— いまの会話セッション自身が ToolSearch でツールを見つけられる保証ではない)"
echo "browser  : $browser_detail"
echo "─────────────────────────────────────────────────────────"
echo "STATUS daemon=$daemon ext_connected=$ext_connected ext_ever_connected=$ext_ever_connected mcp=$mcp mcp_conn=$mcp_conn capture=$capture browser=$browser source_branch=$source_branch inbox=$INBOX latest=${latest:-none}"
