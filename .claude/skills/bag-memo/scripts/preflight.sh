#!/usr/bin/env bash
# bag-memo preflight — メモ取得の前提を「決定的に」検査し、$1 を tabId / urlContains に振り分ける。
# Deterministically probes retrieval prerequisites and classifies $1 as tabId vs urlContains.
#
# 出力 / Output:
#   - 人間向けの数行サマリ（非エンジニアがそのまま読める）
#   - 末尾に Claude 向けの 1 行 `STATUS ...`（分岐判断に使う・モデルが parse するのはこの行だけ）
# スタックトレースは一切出さない（落ちても STATUS を返す）。Never prints a stack trace.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# daemon/healthz プローブ・inbox 最新capture走査・mcp登録+疎通確認は bag-workflow と共通実装。
# shellcheck source=../../bag-workflow/scripts/preflight-common.sh
. "${SCRIPT_DIR}/../../bag-workflow/scripts/preflight-common.sh"

ARG="${1:-}"
DAEMON_HEALTHZ="${BAG_VF_HEALTHZ:-http://127.0.0.1:8765/healthz}"
# 既定は best-effort（Unix の典型値）。権威的な値は healthz の inboxDir（拡張の報告で自動追従）。
INBOX="${BAG_VF_INBOX:-$HOME/Downloads/ai-inbox}"

bag_probe_daemon    # daemon / ext_connected / ext_ever_connected / ext_last_push / INBOX(採用) を設定
# 注: 既定の storage=memory はファイルを書かない（RAM 保持）ので capture=no になりうるが、
#     MCP 経由なら取得できる（source_branch は mcp 登録を優先して MCP になる）。
bag_probe_capture   # latest / capture を設定。BAG_INBOX_DIR_LIST に ls -dt 結果もキャッシュされる
bag_probe_mcp       # mcp / mcp_conn を設定

# --- $ARGUMENTS を tabId / urlContains / instruction に分類 / classify the argument ---
arg_kind="none"; scope_tabId="none"; scope_url="none"; m_windowId="none"; m_url="none"; instruction=""
if [ -n "$ARG" ]; then
  if [[ "$ARG" == *[[:space:]]* ]]; then
    FIRST_WORD="${ARG%%[[:space:]]*}"
    REST_WORDS="${ARG#*[[:space:]]}"
  else
    FIRST_WORD="$ARG"
    REST_WORDS=""
  fi

  if [ -n "$FIRST_WORD" ]; then
    case "$FIRST_WORD" in
      *[!0-9]*)
        arg_kind="urlContains"
        scope_url="$FIRST_WORD"
        instruction="$REST_WORDS"
        ;;
      *)
        arg_kind="tabId"
        scope_tabId="$FIRST_WORD"
        instruction="$REST_WORDS"
        ;;
    esac
  fi
fi

# tabId が来たら、一致する最新 annotation.json から windowId / url を best-effort 解決。
# （disk/hybrid モードでのみファイルが存在。memory モードは none のまま＝tabId 単体で MCP に渡せば十分）
# bag_probe_capture が既にキャッシュした BAG_INBOX_DIR_LIST を再利用し、ls -dt を再実行しない。
if [ "$arg_kind" = "tabId" ] && [ -d "$INBOX" ]; then
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    case "$d" in */done/) continue;; esac
    aj="${d}annotation.json"
    [ -f "$aj" ] || continue
    if grep -Eq "\"tabId\"[[:space:]]*:[[:space:]]*${scope_tabId}([^0-9]|$)" "$aj" 2>/dev/null; then
      w="$(sed -n 's/.*"windowId"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$aj" | head -1)"
      u="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$aj" | head -1)"
      [ -n "$w" ] && m_windowId="$w"
      [ -n "$u" ] && m_url="$u"
      break
    fi
  done <<EOF
$BAG_INBOX_DIR_LIST
EOF
fi

# --- ライブページ確認用ブラウザ（任意・副次） / live reader (optional) -------------
if command -v playwright-cli >/dev/null 2>&1; then
  browser="playwright-cli"
else
  browser="none"
fi

bag_resolve_source_branch   # mcp/mcp_conn/capture → source_branch(MCP > FILE > NONE)

echo "── bag-memo preflight ──────────────────────────────────"
echo "daemon   : $daemon        (healthz: $DAEMON_HEALTHZ)"
echo "extension: connected=$ext_connected everConnected=$ext_ever_connected lastPush=$ext_last_push"
echo "           (everConnected=false なら拡張の Options で daemon 有効化・URL・token 未設定の疑い)"
echo "inbox    : $INBOX"
echo "capture  : $capture${latest:+   最新: $latest}"
echo "           (storage=memory はファイル無し→no でも MCP で取得可)"
echo "mcp      : $mcp / $mcp_conn   (bag_page_feedback。registered は設定登録の意味のみ ——"
echo "           このコマンド実行時点の疎通確認結果であり、いまの会話セッション自身が"
echo "           ToolSearch でツールを見つけられる保証ではない。呼び出し前に必ず確認する)"
echo "arg      : kind=$arg_kind  tabId=$scope_tabId  url=$scope_url  instruction=\"$instruction\""
[ "$arg_kind" = "tabId" ] && echo "resolved : windowId=$m_windowId  url=$m_url   (一致 annotation.json から best-effort)"
echo "browser  : $browser   (ライブ確認は任意・副次)"
echo "─────────────────────────────────────────────────────────"
# 自由文字列フィールド(scope_url/url/instruction)は空白混入でもトークン境界が壊れないよう引用する。
echo "STATUS daemon=$daemon ext_connected=$ext_connected ext_ever_connected=$ext_ever_connected mcp=$mcp mcp_conn=$mcp_conn capture=$capture source_branch=$source_branch arg_kind=$arg_kind scope_tabId=$scope_tabId windowId=$m_windowId scope_url=\"$scope_url\" url=\"$m_url\" inbox=$INBOX latest=${latest:-none} instruction=\"$instruction\""
