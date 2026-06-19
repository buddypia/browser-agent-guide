# daemon / MCP — お描きの取得経路

お描き (visual feedback) を Claude に届ける常駐 daemon (`bag-visual-feedback`) と、その MCP ツールの使い方。
ライブの一次情報: `daemon/src/server.js`, `daemon/src/inbox.js`, `daemon/README.md`。

## MCP ツール (5つ) — 完全修飾名で呼ぶ

エンドポイント `http://127.0.0.1:8765/mcp`。Claude Code 上では `bag_visual_feedback:` 接頭辞付きで呼ぶ。
通常は **画像なし context** から始める。`@agent:` / selector / testid / anchorLabel で対象を特定できる時は vision を使わない。
image ツールは **注釈付きPNG を vision content として返し、かつ絶対 `file_path` テキストを必ず併走**させるが、
context で確認した `contextId` と、vision が必要な理由 `imageReason` がないと image を返さない。

| ツール | 入力 | 返り値 | 用途 |
|---|---|---|---|
| `bag_visual_feedback:list_visual_feedback` | `{ limit?, urlContains?, titleContains? }` | text 一覧 (id・url・title・時刻) | 候補を新しい順に列挙 |
| `bag_visual_feedback:get_latest_visual_feedback_context` | `{ urlContains?, titleContains? }` | text + structuredContent (imageなし) | **主用途**。最新のお描きメタを軽量取得 |
| `bag_visual_feedback:get_visual_feedback_context` | `{ id }` | text + structuredContent (imageなし) | id 指定でメタを軽量取得 |
| `bag_visual_feedback:get_latest_visual_feedback` | `{ urlContains?, titleContains?, contextId, imageReason }` | image(PNG) + text(file_path, url, title, capturedAt, annotations) | context 確認後、必要時のみ vision 用に取得 |
| `bag_visual_feedback:get_visual_feedback` | `{ id, contextId, imageReason }` | image + text | id 指定 context 確認後、必要時のみ vision 用に取得 |

### 共有 inbox のスコープ (重要)

`~/Downloads/ai-inbox` は**全プロジェクト共有**。素で `bag_visual_feedback:get_latest_visual_feedback_context` を呼ぶと別プロジェクトの直近キャプチャが返りうる。
作業中ページの URL 断片を `urlContains` に渡して絞る (部分一致・大小無視)。

```
bag_visual_feedback:get_latest_visual_feedback_context({ urlContains: "example.com" })
bag_visual_feedback:list_visual_feedback({ titleContains: "ダッシュボード" })
bag_visual_feedback:get_latest_visual_feedback({
  urlContains: "example.com",
  contextId: "<context.id>",
  imageReason: "@agent:/selector だけでは注釈の見た目の範囲が曖昧なため"
})
```
条件に一致しない時、または `contextId` が最新 entry と一致しない時は **image を返さず案内テキスト**を返す。

## Claude Code に MCP を登録する (1回だけ)

これを 1 回実行するだけで、以後 Claude が「お描き」を自動取得できる。**そのままコピペ**でよい (フラグや URL は変えない)。
Run this once so Claude can auto-fetch drawings. Copy it exactly — don't change the flags or URL.

```bash
claude mcp add --transport http bag_visual_feedback http://127.0.0.1:8765/mcp
claude mcp list   # bag_visual_feedback が出れば登録済み
```
または `.mcp.json` (リポジトリ直下、チーム共有可):
```json
{ "mcpServers": { "bag_visual_feedback": { "type": "http", "url": "http://127.0.0.1:8765/mcp" } } }
```
> Codex CLI は `codex mcp add bag_visual_feedback --url http://127.0.0.1:8765/mcp`、
> または `~/.codex/config.toml` の `url`。Antigravity は `serverUrl` キー。いずれも同じ `…/mcp` を指す。

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

## annotation.json スキーマ (実物 / schema `agentrails.visual-feedback/v0`)

> schema 名はリブランド前 (AgentRails) のままのことがある。**名前に依存せず `items[]` の構造で扱う**。

```jsonc
{
  "schema": "agentrails.visual-feedback/v0",
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
      "anchorLabel": "A社に似たB社 二段検索…", // ★ 対象の表示テキスト → ソース grep に最有効
      "selector": "main > section:nth-of-type(1) > div > article:nth-of-type(3)", // CSSセレクタ
      "testid": "",                   // data-testid (あれば)
      "resolved": true,
      "inViewport": true,             // false=画面外 (図形を描けず一覧に「画面外」と出る)
      "bboxPx": { "minX": 282, "minY": 530, "maxX": 1485, "maxY": 758 },
      "shapesFrac": [ { "type": "rect", "x": -2.14, "y": -0.17, "w": 4.36, "h": 1.36,
                        "color": "#ef4444", "width": 3 } ]  // 0..1 比率座標 (対象矩形基準)
    }
  ]
}
```

**ソース特定での優先度**: `url`(file://) > `anchorLabel`(表示テキスト grep) > `testid`/`selector` の安定部分 > 画像から推測。
動的生成ページでは `selector` 直 grep は当たりにくい (CSS構造依存) ため、`anchorLabel` の文字列検索が最も実用的。
