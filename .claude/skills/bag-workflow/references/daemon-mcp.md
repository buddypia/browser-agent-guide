# daemon / MCP — お描きの取得経路

お描き (visual feedback) を Claude に届ける常駐 daemon (内部名 `bag-page-feedback`) と、その MCP ツールの使い方。
ライブの一次情報: `daemon/src/server.js`, `daemon/src/inbox.js`, `daemon/README.md`。

## MCP ツール (5つ) — 完全修飾名で呼ぶ

エンドポイント `http://127.0.0.1:8765/mcp`。接頭辞 (`bag_page_feedback:` 等) は**登録時に付けた alias**で、サーバ内部名とは別物。
このスキルの例・登録手順は `bag_page_feedback:` を使う。旧 `bag_visual_feedback:` で登録していた場合は付け替える (下「登録」節)。
context ツールは **画像なし**で `@agent:` / selector / testid / anchorLabel に加え、**メモを残した要素の `html` (outerHTML) と `a11y`** も返す。
HTML を直したいだけならここで完結することが多い。`@agent:` / selector / html で対象を特定できる時は vision を使わない。
image ツールは **注釈付きPNG を vision content として返し、かつ絶対 `file_path` テキストを必ず併走**させるが、
context で確認した `contextId` と、vision が必要な理由 `imageReason` がないと image を返さない。

> **ツール名 (旧 → 新の経緯)**: かつての `*_visual_feedback*` は「メモ＋HTML だけ欲しい (画像なし)」ケースでも "visual" を
> 冠して紛らわしかったため、modality 中立な `*_feedback_context` (テキスト/HTML/a11y) と `*_feedback_image` (画像) へ改名した。
> **旧名 (deprecated エイリアス) は撤去済み** — 現在は新名 5 ツールのみ公開。旧名で書かれた古い手順は動かないので新名を使う。

| ツール | 入力 | 返り値 | 用途 |
|---|---|---|---|
| `bag_page_feedback:list_feedback` | `{ limit?, urlContains?, titleContains? }` | text 一覧 (id・url・title・時刻) | 候補を新しい順に列挙 |
| `bag_page_feedback:get_latest_feedback_context` | `{ urlContains?, titleContains?, tabId?, windowId? }` | text + structuredContent (imageなし。html/a11y 含む) | **主用途**。最新のお描きメタ＋対象要素 HTML を軽量取得 |
| `bag_page_feedback:get_feedback_context` | `{ id }` | text + structuredContent (imageなし。html/a11y 含む) | id 指定でメタ＋HTML を軽量取得 |
| `bag_page_feedback:get_latest_feedback_image` | `{ urlContains?, titleContains?, tabId?, windowId?, contextId, imageReason }` | image(PNG) + text(file_path, url, title, capturedAt, annotations) | context 確認後、必要時のみ vision 用に取得 |
| `bag_page_feedback:get_feedback_image` | `{ id, contextId, imageReason }` | image + text | id 指定 context 確認後、必要時のみ vision 用に取得 |

### 共有 inbox のスコープ (重要)

`~/Downloads/ai-inbox` は**全プロジェクト共有**。素で `bag_page_feedback:get_latest_feedback_context` を呼ぶと別プロジェクトの直近キャプチャが返りうる。
作業中ページの URL 断片を `urlContains` に渡して絞る (部分一致・大小無視)。同じ URL のタブが複数ある時は `tabId` / `windowId` も渡す。

```
bag_page_feedback:get_latest_feedback_context({ urlContains: "example.com" })
bag_page_feedback:list_feedback({ titleContains: "ダッシュボード" })
bag_page_feedback:get_latest_feedback_image({
  urlContains: "example.com",
  contextId: "<context.id>",
  imageReason: "@agent:/selector/html だけでは注釈の見た目の範囲が曖昧なため"
})
```
条件に一致しない時、または `contextId` が最新 entry と一致しない時は **image を返さず案内テキスト**を返す。

## Claude Code に MCP を登録する (1回だけ)

これを 1 回実行するだけで、以後 Claude が「お描き」を自動取得できる。**そのままコピペ**でよい (フラグや URL は変えない)。
Run this once so Claude can auto-fetch drawings. Copy it exactly — don't change the flags or URL.

```bash
claude mcp add --transport http bag_page_feedback http://127.0.0.1:8765/mcp
claude mcp list   # bag_page_feedback が出れば登録済み
```
または `.mcp.json` (リポジトリ直下、チーム共有可):
```json
{ "mcpServers": { "bag_page_feedback": { "type": "http", "url": "http://127.0.0.1:8765/mcp" } } }
```
> Codex CLI は `codex mcp add bag_page_feedback --url http://127.0.0.1:8765/mcp`、
> または `~/.codex/config.toml` の `url`。Antigravity は `serverUrl` キー。いずれも同じ `…/mcp` を指す。
> **旧 alias `bag_visual_feedback` で登録していた場合は付け替える** (旧 deprecated ツール名は撤去済み):
> `claude mcp remove bag_visual_feedback && claude mcp add --transport http bag_page_feedback http://127.0.0.1:8765/mcp`。
>
> **登録は今の会話には効かない**: Claude Code は MCP サーバーへの接続をセッション**起動時**にしか
> 確立しない。`claude mcp add` を会話の途中で実行しても、その会話は接続を確立し直さない —— **新しい
> 会話を開始**して初めて `mcp__bag_page_feedback__*` ツールが使えるようになる。同様に、daemon をこの
> 会話の**後から**起動した場合も、この会話はセッション起動時点の(未接続の)状態のままになりうる。

## daemon を起動する

お描きを届ける常駐プロセス。下を**ターミナル** (Mac: ターミナル.app / Windows: コマンドプロンプト) に貼って実行する。
Paste into your terminal (Terminal.app on Mac / Command Prompt on Windows):

```bash
cd /Users/a13973/dev/buddypia/browser-agent-guide/daemon
npm install     # 初回のみ / first time only
npm start       # 既定 inbox=<自動検出した Downloads>/ai-inbox, port=8765（拡張の報告で追従）
curl -s http://127.0.0.1:8765/healthz   # {"ok":true,"inboxDir":"..."} を確認 / verify（これが権威的な実パス）
```
環境変数 `BAG_VF_INBOX` / `BAG_VF_PORT` / `BAG_VF_HOST` で上書き可。

## inbox のレイアウト (FILE 直読み経路で使う)

```
<inbox>/<slug>/        # <inbox> は healthz の inboxDir。slug = {ローカル日時}__{ホスト}__{タイトル}__{ID}
  shot.png         # 注釈を焼き込んだ合成画像 — vision の1次
  raw.png          # 注釈なしの元スクショ — before 比較用
  annotation.json  # 座標/selector/intent 等の構造化メタ (下記)
  memo.md          # 人間可読 (指示一覧 + 各CLIでの画像の渡し方)
```
MCP が使えない時は、preflight の `latest=` が指すこのフォルダを直接 Read する。

### offline reader (daemon も MCP も無いが画像は見たい時)

```bash
node /Users/a13973/dev/buddypia/browser-agent-guide/daemon/scripts/probe.mjs ~/Downloads/ai-inbox --url <部分一致>
```

## annotation.json スキーマ (実物 / schema `bag.visual-feedback/v1`)

> 現行は `bag.visual-feedback/v1` (各 item に `html`/`a11y` を含む)。古いキャプチャは `…/v0` や
> リブランド前 (AgentRails) の `agentrails.visual-feedback/v0` のこともある。
> **名前に依存せず `items[]` の構造で扱う** (v0 は html/a11y を持たず `null`)。

```jsonc
{
  "schema": "bag.visual-feedback/v1",
  "url": "file:///…/graph-insight-design.html",   // お描きしたページ。file:// ならソースの手がかり
  "title": "…",
  "capturedAt": "2026-06-17T10:24:04.714Z",
  "dpr": 2,
  "viewport": { "width": 1733, "height": 1321 },
  "image": { "file": "shot.png", "raw": "raw.png", "width": 2000, "height": 1525,
             "downscaled": true, "outputScale": 0.577 },
  "items": [
    {
      "n": 1,                         // 手順番号 (描いた順 1,2,3…)
      "id": "anno-1",
      "color": "#ef4444",
      "note": "ここを直したい。",      // ★ ユーザーの指示文
      "intent": "",                   // 目的 (任意)
      "shapeText": "赤色の四角で囲んだ", // 図形の言葉での説明 (画像が見られない時の fallback)
      "dataAgentId": "",              // @agent: マーカー (data-agent-id)。主要UIのみ付与、無ければ ""。最優先の locator
      "anchorLabel": "A社に似たB社 二段検索…", // ★ 対象の表示テキスト → ソース grep に最有効
      "selector": "main > section:nth-of-type(1) > div > article:nth-of-type(3)", // CSSセレクタ
      "testid": "",                   // data-testid (あれば)
      "html": { "outerHTML": "<article class=\"card\">…</article>", "bytes": 812, "truncated": false }, // ★ メモを残した要素の HTML (≤8KB、超過時 truncated:true)。v0 は null
      "a11y": { "role": "article", "name": "A社に似たB社", "level": "3", "states": ["expanded=true"] }, // 軽量 a11y (role/name/level/state)。v0 は null
      "resolved": true,
      "inViewport": true,             // false=画面外 (図形を描けず一覧に「画面外」と出る)
      "bboxPx": { "minX": 282, "minY": 530, "maxX": 1485, "maxY": 758 },
      "shapesFrac": [ { "type": "rect", "x": -2.14, "y": -0.17, "w": 4.36, "h": 1.36,
                        "color": "#ef4444", "width": 3 } ]  // 0..1 比率座標 (対象矩形基準)
    },
    {
      "n": 2,
      "id": "anno-2",
      "color": "#ef4444",
      "note": "この文言を短く",          // ★ メモを残す(図形なし)。本文は必ず note を読む
      "intent": "",
      "shapeText": "",                  // ★ 図形が無いので空。"" は「図形なし」の印
      "anchorLabel": "送信して続行",
      "selector": "#submit",
      "html": { "outerHTML": "<button id=\"submit\">送信して続行</button>", "bytes": 48, "truncated": false },
      "a11y": { "role": "button", "name": "送信して続行" },
      "resolved": true,
      "inViewport": true,
      "bboxPx": { "minX": 60, "minY": 300, "maxX": 220, "maxY": 348 }, // 対象要素の矩形
      "shapesFrac": []                  // ★ メモは図形を持たない (空配列)
    }
  ]
}
```

> **「メモを残す」だけの item**: 上の `anno-2` のように `shapesFrac:[]` ＋ `shapeText:""` で丸数字の図形が無い。
> 本文は `note` を読む (`shapeText` は図形がある証拠ではない)。`html`/`a11y`/`selector`/`anchorLabel` はお描きと同じく載る。

**ソース特定での優先度**: `dataAgentId`(`@agent:`) > `url`(file://) > `anchorLabel`(表示テキスト grep) > `html`(outerHTML の class/id/文言) > `testid`/`selector` の安定部分 > 画像から推測。
動的生成ページでは `selector` 直 grep は当たりにくい (CSS構造依存) ため、`anchorLabel` の文字列検索が最も実用的。
