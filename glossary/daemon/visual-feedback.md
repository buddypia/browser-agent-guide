---
id: visual-feedback
term: "Visual Feedback / お描き注釈キャプチャ"
aliases: ["お描き", "annotation capture", "drawn feedback"]
deprecated_terms: []
status: stable
owner: "@buddypia"
bounded_context: daemon
progress:
  state: shipped
  tracking: ""
source_refs:
  - { type: doc, path: "docs/visual-feedback-mvp-usage.md" }
  - { type: spec, path: "AGENTS.md", anchor: "daemon-architecture" }
code_refs:
  - { path: "lib/visual-feedback/compositor.js", symbol: "drawShape" }
  - { path: "offscreen/offscreen.js", symbol: "drawImage" }
api_refs:
  - { name: "MCP: get_latest_feedback_context", spec: "daemon/src/server.js" }
  - { name: "MCP: get_latest_feedback_image", spec: "daemon/src/server.js" }
db_refs: []
related: ["entry-store", "affordance"]
last_verified: 2026-06-29
confidence: high
---

## 定義

ユーザーがブラウザ上に描いた注釈をスクリーンショットへ合成し、AI コーディング CLI へ
MCP 経由で渡す機能。SW がアクティブ対象タブをキャプチャ → offscreen が `OffscreenCanvas` +
Canvas 2D で注釈を合成 → daemon が有効なら WS push、無効なら `chrome.downloads` で
`<download dir>/ai-inbox/<slug>/` へ保存。

`lib/visual-feedback/compositor.js` は **Canvas-2D 専用**(SVG/foreignObject/Image/drawImage 禁止。
`drawImage` は背景描画のため `offscreen.js` でのみ許可)。banned-token スキャンがビルドを守る。

## HTML 要素の取得（schema v1）

お描き/メモを残した対象要素の `outerHTML`（上限 8KB、超過時 `truncated:true`）と軽量 a11y
（role/name/level/state）を annotation.json の各 item に保存し（`bag.visual-feedback/v1`）、
**画像なしの context ツール**（`get_latest_feedback_context` / `get_feedback_context`）が
text + `structuredContent` に載せて返す。「メモを残した HTML 要素だけ欲しい（画像不要）」
ケースはこの経路で完結する。旧 v0 entry は html/a11y が無く null に正規化される。

## 命名

MCP サーバ名 `bag-visual-feedback` → `bag-page-feedback`、ツールは modality 中立な
`*_feedback_context`（テキスト/HTML）/ `*_feedback_image`（画像）へ改名。旧 `*_visual_feedback*`
の deprecated エイリアスは**撤去済み**（新名 5 ツールのみ公開）。Claude Code 上の `bag_page_feedback:`
接頭辞は**ユーザの MCP 登録 alias**でありサーバ名とは別物（旧 `bag_visual_feedback` 登録は付け替える）。

## 不変条件

- 2 つの image MCP ツール（`*_feedback_image`）は `structuredContent` を返さない(Codex⇔Claude-Code パリティ)。
  context ツール（`*_feedback_context`）は image を持たないので html/a11y を `structuredContent` に載せてよい。
- 座標は要素 rect の 0..1 分率で保存し、合成時に `factor = dpr × outputScale` で CSS px → 出力 px。
