---
id: page-feedback
term: "Page Feedback / お描き注釈キャプチャ"
aliases: ["お描き", "annotation capture", "drawn feedback", "Visual Feedback"]
deprecated_terms: ["visual-feedback"]
status: stable
owner: "@buddypia"
bounded_context: daemon
progress:
  state: shipped
  tracking: ""
source_refs:
  - { type: doc, path: "docs/page-feedback-mvp-usage.md" }
  - { type: spec, path: "AGENTS.md", anchor: "daemon-architecture" }
code_refs:
  - { path: "content/content-script.js", symbol: "collectPageFeedbackData" }
  - { path: "lib/page-feedback/compositor.js", symbol: "drawShape" }
  - { path: "offscreen/offscreen.js", symbol: "drawImage" }
  - { path: "background/service-worker.js", symbol: "pushTextOnlyPageFeedback" }
  - { path: "daemon/src/inbox.js", symbol: "entryHasImage" }
api_refs:
  - { name: "MCP: get_latest_feedback_context", spec: "daemon/src/server.js" }
  - { name: "MCP: get_latest_feedback_image", spec: "daemon/src/server.js" }
db_refs: []
related: ["entry-store", "affordance"]
last_verified: 2026-07-18
confidence: high
---

## 定義

ユーザーがブラウザ上に残した注釈をスクリーンショットへ合成し、AI コーディング CLI へ
MCP 経由で渡す機能。SW がアクティブ対象タブをキャプチャ → offscreen が `OffscreenCanvas` +
Canvas 2D で注釈を合成 → daemon が有効なら WS push、無効なら `chrome.downloads` で
`<download dir>/ai-inbox/<slug>/` へ保存。

`collectPageFeedbackData`(content-script)が capture 対象を集める。対象は **お描き(`kind:'drawing'`)
＋ メモを残す(`kind:'note'`、本文ありのみ)** の2種（marker/button は対象外）。メモは図形を持たないので
対象要素の矩形を bbox にして吹き出し＋番号バッジだけを焼き込む。daemon push と autoSync は既定 OFF
なので、メモ/お描きは**サイドパネルの「画像でAIへ送る」を押す**（または Options で daemon+autoSync を ON）
まで inbox には届かない。

## メモのみ同期（text-only; 画像なし entry）

autoSync ON のとき、送信対象が**メモのみ（お描き図形なし）なら画像を撮らない**: SW の
`pushTextOnlyPageFeedback` が content の `COLLECT_PAGE_FEEDBACK`（UI 隠しなし）で収集し、
`image` キーなしの WS payload（annotation/memo のみ）を push する。スクリーンショット不要なので
**タブ非アクティブでも送信できる**（お描きを含む時だけ従来どおり active タブ + burn-in 必須）。
daemon 側は `annotation` があれば `image.shot` なしを受理し（`writer.js writeEntry` /
`store.js createMemoryEntry` の共通受理境界）、`inbox.js` は shot.png か annotation.json を持つ
dir を entry とみなす。text-only entry は `entryHasImage`=false で、context/image ツールとも
「画像は最初から存在しない（image ツールを呼ばない）」案内を返し、shot_url/file_path を広告しない。
ack にも shotUrl を載せない。MCP の空 inbox 応答は「『メモを残す』だけでは chrome.storage.local に
留まり inbox に届かない」事実と復旧手順（送信 or 自動同期 ON）を全分岐で案内する（AI 勘違い防止）。

`lib/page-feedback/compositor.js` は **Canvas-2D 専用**(SVG/foreignObject/Image/drawImage 禁止。
`drawImage` は背景描画のため `offscreen.js` でのみ許可)。banned-token スキャンがビルドを守る。

## HTML 要素の取得（schema v1）

お描き/メモを残した対象要素の `outerHTML`（上限 8KB、超過時 `truncated:true`）と軽量 a11y
（role/name/level/state）を annotation.json の各 item に保存し（`bag.page-feedback/v1`。旧 entry は `bag.visual-feedback/*`、daemon は文字列で分岐せず両対応）、
**画像なしの context ツール**（`get_latest_feedback_context` / `get_feedback_context`）が
text + `structuredContent` に載せて返す。「メモを残した HTML 要素だけ欲しい（画像不要）」
ケースはこの経路で完結する。旧 v0 entry は html/a11y が無く null に正規化される。

## 命名

機能名を **Visual Feedback → Page Feedback** に統一（term id も `visual-feedback` → `page-feedback`）。
MCP サーバ名 `bag-visual-feedback` → `bag-page-feedback`、ツールは modality 中立な
`*_feedback_context`（テキスト/HTML）/ `*_feedback_image`（画像）へ改名。旧 `*_visual_feedback*`
の deprecated エイリアスは**撤去済み**（新名 5 ツールのみ公開）。Claude Code 上の `bag_page_feedback:`
接頭辞は**ユーザの MCP 登録 alias**でありサーバ名とは別物（旧 `bag_visual_feedback` 登録は付け替える）。

内部命名も揃えた（後方互換つき）: npm パッケージ `bag-page-feedback-daemon`、環境変数 `BAG_PF_*`
（旧 `BAG_VF_*` も読む）、トークン `~/.bag-pf/token`（旧 `~/.bag-vf/token` も読む）、WS payload
`type:'page_feedback'`（旧 `visual_feedback` も受理）、拡張設定キー `pageFeedback`（旧 `visualFeedback`
を移行読み）、モジュール `lib/page-feedback/`、内部シンボル `createPageFeedbackStore` /
`collectPageFeedbackData`、起動ログ `[bag-pf]`。

## 不変条件

- 2 つの image MCP ツール（`*_feedback_image`）は `structuredContent` を返さない(Codex⇔Claude-Code パリティ)。
  context ツール（`*_feedback_context`）は image を持たないので html/a11y を `structuredContent` に載せてよい。
- 座標は要素 rect の 0..1 分率で保存し、合成時に `factor = dpr × outputScale` で CSS px → 出力 px。
