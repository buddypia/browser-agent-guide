# REVIEW: deprecated MCP ツール alias の撤去 + 登録 alias の移行寄せ

## 概要
PR #59/#60 で「当面温存」していた **deprecated MCP ツール名 alias（`*_visual_feedback*`）を撤去**し、
全 in-repo 参照を新名へ移行した。あわせて推奨 CLI 登録 alias を `bag_page_feedback` に一本化し、
preflight は新 alias のみ検出するよう絞った（旧 `bag_visual_feedback` 登録ユーザーには付け替え手順を案内）。

## なぜ
- ユーザ依頼「レガシーは全てマイグレーションしてから削除して」。
- `*_visual_feedback*` は「画像なしで HTML 要素だけ取得する」ケースでも "visual" を冠して紛らわしく、
  modality 中立な `*_feedback_context` / `*_feedback_image` へ既に改名済みだった。deprecated alias を
  残す限り `tools/list` が 5+5=10 になりモデルへのノイズ・誤用余地が残る。
- 全消費側（テスト・docs・図・glossary・skill）を新名へ移行し終えたので、alias を安全に撤去できる。

## 何を
1. **daemon 本体**: `daemon/src/server.js` の `registerWithAlias` を撤去し、5 ツールを `registerTool` で
   直接登録（`tools/list` は厳密に 5 件）。
2. **テスト移行**: `mcp.test.mjs` の tools/list テストを「5 ツールのみ・厳密一致」に書換（旧名リテラルを
   残さない＝1つでも alias が復活すれば fail）。全テストの `callTool({name})` を新名へ（store / http-shot /
   image-fallback も）。`type:'visual_feedback'`（WS payload）は不変。
3. **docs/図/glossary/skill 移行**: daemon/README・AGENTS の gotcha を「撤去済み」に更新、生成図
   `docs/mcp-*.{html,artifact.spec.json}` のツール名＋ alias＋ daemon 名を新名へ、glossary api_refs の
   deprecated 注記を除去し `last_verified` を更新。
4. **登録 alias の一本化**: 全登録例を `bag_page_feedback` に、preflight 検出を `bag_page_feedback` のみに
   絞り、「旧 alias は付け替える」移行コマンドを各所に明記。

## どうやって
- ツール名リネームは単純置換ではない（image 2 種は `_image` 付与）。最長一致順の置換で bare 名
  （`get_feedback`/`get_latest_feedback`）混入ゼロを grep 検証。
- 図は機械的多ファイル置換のため perl を使用。標準形 `visual_feedback`（WS type）と
  パッケージ名 `bag-visual-feedback-daemon` は負の文脈で保護し、daemon 名 `bag-visual-feedback` のみ
  `bag-page-feedback` へ移行。JSON は parse 検証。
- 旧 alias `bag_visual_feedback` は「移行コマンドの引数」としてのみ docs に残置（移行手順として必要）。

## 影響
- **破壊的変更（意図的）**: 旧ツール名 `*_visual_feedback*` で MCP を叩いていた手順は**動かなくなる**。
  反映には daemon 再起動（新ビルドで alias 消滅）が必要。
- **登録 alias**: 旧 `bag_visual_feedback` 登録のままだと preflight が absent 判定 → 付け替えが必要
  （本作業の一環でユーザーの登録も `bag_page_feedback` へ移行する）。
- WS payload `type:'visual_feedback'` / npm パッケージ名 `bag-visual-feedback-daemon` / `BAG_VF_*` /
  schema `bag.visual-feedback/v1` は**不変**（別レイヤ・現行 canonical）。

## トレードオフ
- 後方互換（旧名 alias）を捨てる代わりに、`tools/list` が 5 件に戻りモデルの誤用余地・ノイズが消える。
  ユーザー明示依頼に基づく判断。
- 旧 alias の「移行コマンド」は docs に残す（消すと legacy 登録ユーザーが移行手段を失うため）。

## 残作業（このPRでは未対応）
- なし（in-repo の deprecated tool alias 参照は全撤去）。daemon パッケージ名・WS payload・env・schema は
  alias ではなく現行 canonical のため対象外（必要なら別PR）。

## ファイル構造（変更点）
- daemon: `src/server.js`（alias 撤去）, `test/{mcp,store,http-shot,image-fallback}.test.mjs`, `README.md`
- docs: `docs/mcp-daemon-flow.{html,artifact.spec.json}`, `docs/mcp-extension-connection.{html,artifact.spec.json}`, `docs/visual-feedback-mvp-usage.md`, `AGENTS.md`
- glossary: `glossary/daemon/visual-feedback.md`
- skill: `.claude/skills/bag-workflow/{SKILL.md,references/daemon-mcp.md,references/fallbacks.md,scripts/preflight.sh}`
- review: `REVIEW.md`

## レビュー依頼
- deprecated alias を即時撤去してよいか（後方互換を切る破壊的変更・ユーザー明示依頼）。
- preflight を `bag_page_feedback` のみ検出に絞った点（旧 alias 登録ユーザーは付け替え前提）。

## 検証
- daemon `npm test` **103/103 pass**（tools/list 5 件厳密一致・全 callTool 新名）、
  `node scripts/e2e-smoke.mjs` 実バイナリで新名通過。
- ガバナンススイート 54/54 pass、`check-hook-refs` OK、`bash -n preflight.sh` OK、
  preflight 検出が `bag_page_feedback` のみにマッチ（旧 alias は非マッチ）を機能確認。
- `check:markers`（14）/ `check:glossary`（警告0）/ `glossary:staleness`（変更コード0）緑。
- 図 4 ファイルの旧名/旧 alias 消滅・WS payload/パッケージ名保持・JSON parse を検証。
- 敵対的検証ワークフロー（後述）で多レンズ確認。
- 重い Playwright/browser テストは拡張ソース無変更のため対象外（意図的スキップ）。
