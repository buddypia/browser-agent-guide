# ページフィードバック MVP（Phase 0）の使い方と検証手順

> この文書は Phase 0（データ／MCP なし）の実装をどう動かし、Phase 0 の前提を
> どう目視確認するかをまとめる。

## 何が入ったか（Phase 0）

ブラウザのお描き注釈／メモ（「メモを残す」で要素に残した本文ありメモ）を **スクリーンショットへ焼き込み（burn-in）**、画像ファイルとして
`<ブラウザのダウンロードフォルダ>/ai-inbox/<slug>/` に保存する。デーモンも MCP も無し。AI には保存された
`shot.png` を **vision（画像）として** 渡す。保存後、拡張は実際の保存先（絶対パス）を
`chrome.downloads.search` で取得してサイドパネルに表示する（保存先はブラウザ設定依存で `~/Downloads` とは限らない）。

- `manifest.json`: `offscreen` / `downloads` 権限を追加
- `lib/page-feedback/compositor.js`: 純粋な合成モジュール（Canvas 2D 直描き / 2000px ガード / DPR 整合）
- `offscreen/offscreen.{html,js}`: OffscreenCanvas で実際に焼き込む
- `content/content-script.js`: `PREPARE_CAPTURE`（自前UIを隠して図形をビューポートpxに解決）/ `FINISH_CAPTURE`
- `background/service-worker.js`: 撮影 → 合成 → `chrome.downloads` 保存のオーケストレーション
- サイドパネル: 「画像でAIへ送る」CTA。**お描き、または本文ありの「メモを残す」メモが1件以上ある時**に
  注釈パネルのフッターへ表示する（件数バッジ付き。メモだけのページでも出る）

## 出力物（1回の保存）

```
<ダウンロードフォルダ>/ai-inbox/<slug>/      # slug = {ローカル日時}__{ホスト}__{タイトル}__{ID}
  shot.png         # 注釈を焼き込んだ合成本（vision 1次）
  raw.png          # 注釈なしの元スクショ（位置ずれ比較・将来のデーモン用）
  annotation.json  # URL/title/Chrome tab + 座標(frac)/selector/testid/intent/bbox（テキスト fallback）
  memo.md          # 人間可読 + 各CLIでの画像の渡し方 + describeShapes
```

## 操作手順

1. `chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」→ このリポジトリのルートを選択。
   （JS注入を使う場合は拡張詳細で「Allow User Scripts」も有効化。ページフィードバックだけなら不要。）
2. 対象ページを開き、拡張アイコンでサイドパネルを開く。
   サイドパネル上部には対象 Chrome タブの `tabId` / `windowId` / タブ位置が表示される。
3. 「お描き」で対象を円/四角/矢印/ペンで囲み、隣のメモに指示を書く（複数可）。
   （または「メモを残す」で要素をクリックしてメモ本文を書く。図形なしでも送れる。）
4. お描き／メモが1件以上あると、注釈パネルの下に **「画像でAIへ送る」** が出る。
   それを押すと `Downloads/ai-inbox/<...>/` に4ファイルが保存される。

## 検証（handoff の仮説）

保存された `shot.png` のパスを AI コーディング CLI に **画像** として渡す:

- Claude Code: 会話に `shot.png` のパスを貼る / ドラッグ / Ctrl+V
- Codex CLI: `codex --image ./shot.png "この赤枠の指示に従って直して"`
- Antigravity(IDE): 画像をエディタにドラッグ / 貼り付け

確認ポイント:

- **(A) 合成 PNG が実際に vision に入るか**: モデルが画像の内容（赤枠・矢印・メモ）を読めるか。
- **(B) DPR 座標整合**: 焼き込んだ図形が、狙った UI 要素の上に正しく乗っているか。
  HiDPI（dpr 2〜3）でずれないか。`raw.png` と `shot.png` を重ねて位置を比べると分かりやすい。

## Phase 1（消費側 MCP）— 手で渡さず CLI に自動取得させる

`../daemon/` に **常駐デーモン**を実装済み。これを起動して CLI に MCP 登録すると、
`shot.png` のパスを手で貼らずとも、CLI が `get_latest_feedback_context` で
最新のお描き注釈メタを **画像なし**で先に取得する。見た目の判断が必要な時だけ
context の `id` を `contextId` に渡し、`imageReason` に理由を書いて
`get_latest_feedback_image` で **image+パス**を取得する（既定 inbox は MVP の保存先 `~/Downloads/ai-inbox`）。
同じ URL を複数タブで開いている場合は、拡張に表示された `tabId` を
`get_latest_feedback_context({ tabId })` / `get_latest_feedback_image({ tabId, contextId, imageReason })`
へ渡して絞り込める。context には `tab: { tabId, windowId, index, active }` も含まれる。

`get_*_feedback_context` は、メモを残した**対象要素の `outerHTML`（≤8KB）と a11y（role/name/level/state）**も
返す（schema v1）。「画面のこの要素を直して」を **画像なし**でソース特定するならこれで完結し、
見た目の判断が要る時だけ `get_*_feedback_image` を使う。なお旧名 `*_visual_feedback*` の deprecated
エイリアスは撤去済みで、現在は新名 5 ツールのみが公開される。

```bash
cd daemon && npm install && npm start   # http://127.0.0.1:8765/mcp
```

CLI 登録方法と検証は `daemon/README.md` を参照。WebSocket 常時 push（拡張→デーモン）と
トークン認証は次の増分。

## 自動テスト

- `npm run test:pf` — compositor の回帰（2000px 境界 / DPR 変換 / 決定的な描画呼び出し列 / foreignObject 不使用）
- `npx playwright test test/page-feedback/canvas.spec.mjs` — 実ブラウザの Canvas で
  taint せず有効な PNG を焼き込めることを実測（SecurityError 罠の回避を保証）

## 既知の制限（Phase 0）

- 各注釈は「図形」+「角の丸数字①」+「すぐ隣のメモ吹き出し（先頭に同じ①）」を引き出し線で結んで描く。
  キーは丸数字に統一し、色見本の四角は使わない（AI が「①の指示＝この図形」と取り違えないため）。
- `captureVisibleTab` は **可視領域のみ**で、対象タブがアクティブでなければ別タブを撮らずエラーにする。スクロール外/未解決の注釈は図形を描けず、左上のリストに「画面外」として出る。
- cross-origin iframe / WebGL は黒く写る（ブラウザ仕様、回避不可）。
- `chrome://` や拡張ページなど注入できないページでは保存できない（その旨エラー表示）。
- フォルダ監視は無い。AI には人が `shot.png` を渡す（Phase 1 の MCP で自動化）。
