#!/usr/bin/env bash
# bag-memo preflight — メモ取得の前提を「決定的に」検査し、$1 を tabId / urlContains に振り分ける。
# Deterministically probes retrieval prerequisites and classifies $1 as tabId vs urlContains.
#
# 出力 / Output:
#   - 人間向けの数行サマリ（非エンジニアがそのまま読める）
#   - 末尾に Claude 向けの 1 行 `STATUS ...`（分岐判断に使う・モデルが parse するのはこの行だけ）
# スタックトレースは一切出さない（落ちても STATUS を返す）。Never prints a stack trace.
set -u

ARG="${1:-}"
DAEMON_HEALTHZ="${BAG_VF_HEALTHZ:-http://127.0.0.1:8765/healthz}"
# 既定は best-effort（Unix の典型値）。権威的な値は healthz の inboxDir（拡張の報告で自動追従）。
INBOX="${BAG_VF_INBOX:-$HOME/Downloads/ai-inbox}"

# --- 1) daemon が起きているか + 権威的 inboxDir / daemon up? --------------------
health="$(curl -s -m 2 "$DAEMON_HEALTHZ" 2>/dev/null || true)"
if [ -n "$health" ]; then
  daemon="up"
  inbox_from_health="$(printf '%s' "$health" | sed -n 's/.*"inboxDir":"\([^"]*\)".*/\1/p')"
  [ -n "$inbox_from_health" ] && INBOX="$inbox_from_health"
else
  daemon="down"
fi

# --- 2) inbox に最近のキャプチャがあるか / latest capture? ----------------------
# 注: 既定の storage=memory はファイルを書かない（RAM 保持）ので capture=no になりうるが、
#     MCP 経由なら取得できる（source_branch は mcp 登録を優先して MCP になる）。
latest=""
if [ -d "$INBOX" ]; then
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    case "$d" in */done/) continue;; esac
    if [ -f "${d}shot.png" ]; then latest="$d"; break; fi
  done <<EOF
$(ls -dt "$INBOX"/*/ 2>/dev/null)
EOF
fi
[ -n "$latest" ] && capture="yes" || capture="no"

# --- 3) Claude Code / Codex に MCP が登録されているか / registered? ----------
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

# --- 4) $ARGUMENTS を tabId / urlContains に分類 / classify the argument --------
arg_kind="none"; scope_tabId="none"; scope_url="none"; m_windowId="none"; m_url="none"
if [ -n "$ARG" ]; then
  case "$ARG" in
    *[!0-9]*) arg_kind="urlContains"; scope_url="$ARG";;   # 数字以外を含む → URL 断片
    *)        arg_kind="tabId";       scope_tabId="$ARG";; # 純粋な数値 → tabId
  esac
fi

# tabId が来たら、一致する最新 annotation.json から windowId / url を best-effort 解決。
# （disk/hybrid モードでのみファイルが存在。memory モードは none のまま＝tabId 単体で MCP に渡せば十分）
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
$(ls -dt "$INBOX"/*/ 2>/dev/null)
EOF
fi

# --- 5) ライブページ確認用ブラウザ（任意・副次） / live reader (optional) -------
if command -v playwright-cli >/dev/null 2>&1; then
  browser="playwright-cli"
else
  browser="none"
fi

# --- 分岐判断 / branch: MCP(主) > FILE(救済) > NONE ----------------------------
# mcp_conn=not-connected(登録行はあるが疎通確認で ✔ Connected が出なかった)なら MCP へ倒さない。
if [ "$mcp" = "registered" ] && [ "$mcp_conn" != "not-connected" ]; then
  source_branch="MCP"
elif [ "$capture" = "yes" ]; then
  source_branch="FILE"
else
  source_branch="NONE"
fi

echo "── bag-memo preflight ──────────────────────────────────"
echo "daemon   : $daemon        (healthz: $DAEMON_HEALTHZ)"
echo "inbox    : $INBOX"
echo "capture  : $capture${latest:+   最新: $latest}"
echo "           (storage=memory はファイル無し→no でも MCP で取得可)"
echo "mcp      : $mcp / $mcp_conn   (bag_page_feedback。registered は設定登録の意味のみ ——"
echo "           このコマンド実行時点の疎通確認結果であり、いまの会話セッション自身が"
echo "           ToolSearch でツールを見つけられる保証ではない。呼び出し前に必ず確認する)"
echo "arg      : kind=$arg_kind  tabId=$scope_tabId  url=$scope_url"
[ "$arg_kind" = "tabId" ] && echo "resolved : windowId=$m_windowId  url=$m_url   (一致 annotation.json から best-effort)"
echo "browser  : $browser   (ライブ確認は任意・副次)"
echo "─────────────────────────────────────────────────────────"
# 自由文字列フィールド(scope_url/url)は空白混入でもトークン境界が壊れないよう引用する。
echo "STATUS daemon=$daemon mcp=$mcp mcp_conn=$mcp_conn capture=$capture source_branch=$source_branch arg_kind=$arg_kind scope_tabId=$scope_tabId windowId=$m_windowId scope_url=\"$scope_url\" url=\"$m_url\" inbox=$INBOX latest=${latest:-none}"
