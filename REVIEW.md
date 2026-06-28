# REVIEW: page-feedback — メモを残した HTML 要素の取得 + MCP リネーム

## 概要
お描き／メモのキャプチャに、**注釈を残した対象要素の `outerHTML` と軽量 a11y** を載せ、
**画像トークンなし**で「メモを残した HTML 要素」を CLI へ渡せるようにした。あわせて MCP の
サーバ名・ツール名を modality 中立な名前へ改名（旧名は deprecated エイリアスとして温存）。

## なぜ
- これまで CLI へ渡るのは selector / anchorLabel 止まりで、**対象要素の HTML そのものは取れなかった**。
  「この要素を直して」をソース特定するには結局スクショ(vision)が要り、トークンが重かった。
- ツール名 `*_visual_feedback*` は「画像なしでメモ＋HTML だけ取得する」ケースでも "visual" を冠して
  紛らわしい（ユーザ指摘）。`*_feedback_context`（テキスト/HTML）/ `*_feedback_image`（画像）に分離した。

## 何を
1. **キャプチャ（schema v1）**: 注釈要素の `outerHTML`（≤8KB、超過時 `truncated:true`）＋ a11y
   (role/name/level/state) を `annotation.json` の各 item に追加。
2. **daemon context ツール**: `get_latest_feedback_context` / `get_feedback_context` が html/a11y を
   text と `structuredContent` に載せて返す（**画像なし**）。image ツールは無変更（Codex パリティ維持）。
3. **リネーム**: server `bag-visual-feedback`→`bag-page-feedback`、ツール 5 種を新名へ。旧名 5 種は
   `registerWithAlias` で同一ハンドラの deprecated エイリアスとして残す（`tools/list` は 5+5）。

## どうやって
- `content/content-script.js`: `captureOuterHtml` / `captureA11y` を追加し `collectVisualFeedbackData` の
  item に `html` / `a11y` を付与（ガード領域外なので glossary staleness に非該当）。
- `background/service-worker.js`: `buildAnnotationJson` で html/a11y を items にコピー、schema を
  `bag.visual-feedback/v0`→`v1` に bump。
- `daemon/src/inbox.js`: `buildEntryContext` に html/a11y を追加（`normalizeHtmlCapture`/`normalizeA11yCapture`
  で v0 は null 正規化）、`buildEntryContextText` に a11y/html 行を出力。
- `daemon/src/server.js`: `registerWithAlias` 導入、5 ツール改名 + 旧名エイリアス、ガイダンス文言を新名へ。

## 影響
- **後方互換**: 旧ツール名は alias で全て動作（既存 CLI 設定・スキル・テストは無改修）。旧 v0 entry も
  html/a11y=null で安全。WS payload の `type:'visual_feedback'` は内部プロトコルとして温存。
- **登録 alias 非変更**: Claude Code/Codex で打つ接頭辞（`bag_visual_feedback:`）は**ユーザ設定の alias**で
  サーバ名リネームの影響を受けない。docs では `bag_page_feedback` を推奨と明記（移行は任意）。

## トレードオフ
- `tools/list` が 10 件（新5＋旧5）になりモデルへのノイズが増える。description で旧名を明確に
  `[deprecated]` 表記し新名へ誘導。将来エイリアス撤去で 5 件へ戻せる。
- outerHTML を text にも載せるため context 応答が最大 ~8KB 増える（画像 vision よりは桁違いに軽量）。

## 残作業（このPRでは未対応・すべて alias 経由で動作する）
- `.claude/skills/bag-workflow/**`（SKILL.md / references / preflight.sh）の新名追従。`.claude` 変更は
  ガバナンススイート実行が要るため別PR推奨。
- 生成物 `docs/mcp-*.html`（図）と `*.artifact.spec.json` の新名追従（再生成系）。
- daemon npm パッケージ名 `bag-visual-feedback-daemon` は今回未変更（ユーザ要望はツール名のため対象外）。

## ファイル構造（変更点）
- 拡張: `content/content-script.js`, `background/service-worker.js`
- daemon: `src/inbox.js`, `src/server.js`, `scripts/{probe,e2e-smoke}.mjs`, `test/{mcp,inbox}.test.mjs`
- docs: `AGENTS.md`, `daemon/README.md`, `docs/visual-feedback-mvp-usage.md`, `glossary/daemon/visual-feedback.md`

## レビュー依頼
- 推奨登録 alias を `bag_page_feedback` へ寄せる方針で良いか（現状は docs 推奨のみ・強制しない）。
- 旧ツール名エイリアスの撤去時期（次メジャー等）をどうするか。

## 検証
- daemon: `npm test` 103 pass（html/a11y の新規2件含む）、`node scripts/e2e-smoke.mjs` 実バイナリで新名通過。
- root: `check:js` / `check:markers` / `check:glossary` / `glossary:staleness` / `test:glossary` / `test:vf` 緑。
- root `npm run check` のブラウザ系: `spa-recipe.spec.mjs` が環境起因でフレーク（失敗テスト集合が実行ごとに変化、
  エラーは "Target page/context closed" 等の teardown timeout）。本変更はレシピ/SPA/アンカリング経路に
  非接触で因果なし（他UIスペックは全て pass）。
