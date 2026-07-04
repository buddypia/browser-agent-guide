#!/usr/bin/env bash
# bag-workflow / bag-memo 共有の preflight プローブ。両スキルの preflight.sh が source して使う
# (bag-memo は相対パス ../../bag-workflow/scripts/preflight-common.sh)。
# 各関数はグローバル変数を書き換える(両スキルの既存 preflight.sh と同じ流儀)。
# 呼び出し側は事前に DAEMON_HEALTHZ / INBOX を設定しておくこと。
# スタックトレースは出さない・ハングしない、が両スキル共通の不変条件。
set -u

# ポータブルなタイムアウト実行。GNU timeout(coreutils)が無い素の macOS 等でも、preflight 全体が
# 「daemon/claude/codex のどれかがハングしても止まらない」不変条件を守るためのフォールバック付き。
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi
  "$@" &
  local pid=$!
  ( sleep "$secs" 2>/dev/null; kill -9 "$pid" 2>/dev/null ) &
  local watcher=$!
  local status=0
  wait "$pid" 2>/dev/null || status=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return "$status"
}

# daemon の healthz を叩き daemon/INBOX(inboxDir採用)/ext_connected/ext_ever_connected/ext_last_push を設定する。
bag_probe_daemon() {
  health="$(curl -s -m 2 "$DAEMON_HEALTHZ" 2>/dev/null || true)"
  ext_connected="unknown"; ext_ever_connected="unknown"; ext_last_push="none"
  if [ -n "$health" ]; then
    daemon="up"
    # healthz は {"ok":true,"inboxDir":"..."} を返す。権威的な inboxDir を採用する。
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
}

# $INBOX 直下の ls -dt 結果を一度だけ取得し BAG_INBOX_DIR_LIST にキャッシュする。
# bag_probe_capture() が内部で呼ぶほか、呼び出し側(例: bag-memo の tabId 一致探索)が
# 同じ一覧を再利用でき、二重の ls -dt を避けられる。
bag_list_inbox_dirs() {
  if [ -d "$INBOX" ]; then
    BAG_INBOX_DIR_LIST="$(ls -dt "$INBOX"/*/ 2>/dev/null)"
  else
    BAG_INBOX_DIR_LIST=""
  fi
}

# キャッシュ済み一覧(無ければここで取得)から done/ を除外し、shot.png を持つ最新を1件選ぶ。
# latest/capture を設定する。
bag_probe_capture() {
  [ -n "${BAG_INBOX_DIR_LIST+set}" ] || bag_list_inbox_dirs
  latest=""
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    case "$d" in */done/) continue;; esac
    if [ -f "${d}shot.png" ]; then latest="$d"; break; fi
  done <<EOF
$BAG_INBOX_DIR_LIST
EOF
  [ -n "$latest" ] && capture="yes" || capture="no"
}

# Claude Code / Codex への bag_page_feedback MCP 登録 + 疎通確認(タイムアウト付き)。
# mcp/mcp_conn を設定する。
# 注: これは「claude/codex の設定に登録され、このコマンドを叩いた瞬間に疎通できたか」の
#     チェックであり、いま進行中の会話セッション自身がそのツールを呼べるかどうかとは別物。
#     Claude Code は MCP サーバーへの接続をセッション起動時に確立し、起動時点で接続に失敗すると
#     そのセッションでは(daemon が後から起動しても)自動回復しない。だから mcp=registered でも
#     ToolSearch でツールが見つからないことがある → 各 SKILL.md 側で呼び出し前に必ず確認する。
bag_probe_mcp() {
  mcp="absent"
  mcp_conn="n/a"
  if command -v claude >/dev/null 2>&1; then
    mcp_line="$(run_with_timeout 8 claude mcp list 2>/dev/null | grep -i 'bag_page_feedback' | head -1)"
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
    if run_with_timeout 8 codex mcp list 2>/dev/null | grep -qi 'bag_page_feedback'; then
      mcp="registered"
      mcp_conn="unknown"
    fi
  fi
}

# mcp/mcp_conn/capture から共通の source_branch(MCP > FILE > NONE)を決める。
# mcp_conn=not-connected(登録行はあるが疎通確認で ✔ Connected が出なかった)なら MCP へ倒さない。
bag_resolve_source_branch() {
  if [ "$mcp" = "registered" ] && [ "$mcp_conn" != "not-connected" ]; then
    source_branch="MCP"
  elif [ "$capture" = "yes" ]; then
    source_branch="FILE"
  else
    source_branch="NONE"
  fi
}
