#!/usr/bin/env bash
# bag-workflow preflight — お描き取得とブラウザ連携の前提を「決定的に」検査する。
# Deterministically probes the prerequisites so the skill branches on facts, not guesses.
#
# 出力 / Output:
#   - 人間向けの数行サマリ（非エンジニアがそのまま読める）
#   - 末尾に Claude 向けの 1 行 `STATUS ...`（分岐判断に使う）
# スタックトレースは一切出さない（落ちても STATUS を返す）。Never prints a stack trace.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# daemon/healthz プローブ・inbox 最新capture走査・mcp登録+疎通確認は bag-memo と共通実装
# （preflight-common.sh、bag-memo からは相対パスで source される）。
# shellcheck source=./preflight-common.sh
. "${SCRIPT_DIR}/preflight-common.sh"

DAEMON_HEALTHZ="${BAG_PF_HEALTHZ:-http://127.0.0.1:8765/healthz}"
# 既定は best-effort（Unix の典型値）。実保存先はブラウザ設定依存で異なりうる（移動済み/Edge・Brave/Windows）。
# 権威的な値は下の healthz の inboxDir（拡張の報告で自動追従する）。BAG_PF_INBOX で明示上書きも可。
INBOX="${BAG_PF_INBOX:-$HOME/Downloads/ai-inbox}"

bag_probe_daemon    # daemon / ext_connected / ext_ever_connected / ext_last_push / INBOX(採用) を設定
bag_probe_capture   # latest / capture を設定
bag_probe_mcp       # mcp / mcp_conn を設定

# --- ライブページを読むブラウザ手段 / live-browser reader (bag-workflow 固有) --------
if command -v playwright-cli >/dev/null 2>&1; then
  pw_ver="$(playwright-cli --version 2>/dev/null | head -1)"
  browser="playwright-cli"
  browser_detail="playwright-cli ${pw_ver}"
else
  browser="none"
  browser_detail="none (playwright-cli 未インストール)"
fi

bag_resolve_source_branch   # mcp/mcp_conn/capture → source_branch(MCP > FILE > NONE)

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
