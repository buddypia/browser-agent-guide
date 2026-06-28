# REVIEW: bag-workflow スキルの新ツール名追従 + 登録 alias 寄せ

## 概要
PR #59（daemon MCP ツール改名 + HTML/a11y キャプチャ）の**残作業**として、`bag-workflow` スキルを
新ツール名へ追従させ、推奨 CLI 登録 alias を `bag_visual_feedback` → `bag_page_feedback` へ寄せた。
**docs / skill のみの変更**で、拡張・daemon のソースコードは一切触っていない。

## なぜ
- PR #59 でツール名を `*_visual_feedback*` → `*_feedback_context` / `*_feedback_image` に改名し旧名は
  deprecated エイリアスで温存したが、スキル（SKILL.md / references / preflight.sh）は旧名のままで、
  「`.claude` 変更はガバナンススイート実行を伴う」ため明示的に別PRへ繰り延べていた。
- 同 PR で「推奨登録 alias を `bag_page_feedback` へ寄せる」移行手順は daemon/README に記載済み。
  実例とスキル記述を新 alias に揃えると新規ユーザーがそのまま新名で運用できる。
- ユーザ依頼: 上記2点（skill 新名追従 / alias 寄せ）を実施。

## 何を
1. **skill 新名追従**: SKILL.md・references/{daemon-mcp,fallbacks}.md・scripts/preflight.sh の
   ツール名を 5 種すべて新名へ（image 2 種は `_image` サフィックス付与に注意）。
2. **alias 寄せ**: 全登録例（claude/codex/antigravity/.mcp.json/ツール呼び出し接頭辞）を
   `bag_page_feedback` に。旧 `bag_visual_feedback` は「再登録不要」で温存。
3. **移行安全策**: preflight.sh の登録検出 grep を `grep -qiE 'bag_page_feedback|bag_visual_feedback'` に。
   旧 alias 登録ユーザーが黙って FILE 経路へ落ちるのを防ぐ。
4. **HTML/a11y（schema v1）の周知**: context ツールが画像なしで `html`/`a11y` を返すことを SKILL.md の
   読み取り項目・daemon-mcp.md のツール表/スキーマ例に反映（PR #59 の機能をスキルが使えるように）。
5. **AGENTS.md 整合**: alias gotcha・「未同期」注記・Skills cues・関連 stale 名を新名へ統一。

## どうやって
- リネームは単純置換ではない（`get_latest_visual_feedback` → `get_latest_feedback_image`、
  `get_visual_feedback` → `get_feedback_image` は `_image` 付与）。最長一致順で手当てし、
  bare `get_feedback`/`get_latest_feedback`（サフィックス欠落）が混入しないことを grep で確認。
- 旧 alias は「移行ノート」「両 alias 検出 grep」以外には残さない方針で限定。
- daemon-mcp.md の annotation.json 例を v0 → `bag.visual-feedback/v1` に更新し `html`/`a11y` と
  `dataAgentId` を追記（優先度行の先頭昇格と例の整合）。

## 影響
- **後方互換**: 旧ツール名は daemon 側の deprecated エイリアスで動作継続。旧 alias `bag_visual_feedback`
  で登録済みのユーザーは**再登録不要**（preflight も両 alias を検出）。
- **コード非接触**: 拡張/daemon の挙動・テストに影響なし（差分は md / sh のドキュメントのみ）。
- 反映には Claude Code セッション再起動（スキル再読込）と、新名を `tools/list` に出すための
  daemon 再起動が必要（任意・旧名でも動く）。

## トレードオフ
- 旧 alias を docs に残すことで記述がやや増える（移行の安全性・既存ユーザー保護を優先）。
- 生成図 `docs/mcp-*.html` は本PRでは未同期（旧名 alias で動作するため別作業に繰り延べ）。

## 残作業（このPRでは未対応）
- 生成図 `docs/mcp-*.html` / `*.artifact.spec.json` の新名再同期（再生成系・旧名 alias で動作継続）。
- daemon npm パッケージ名 `bag-visual-feedback-daemon` は対象外（ツール名/登録 alias の話とは別レイヤ）。

## ファイル構造（変更点・6+1 ファイル）
- skill: `.claude/skills/bag-workflow/SKILL.md`, `references/daemon-mcp.md`, `references/fallbacks.md`,
  `scripts/preflight.sh`
- docs: `daemon/README.md`, `AGENTS.md`
- review: `REVIEW.md`（本ファイル）

## レビュー依頼
- 推奨登録 alias を `bag_page_feedback` に寄せる方針で良いか（旧 alias は強制再登録なしで温存）。
- daemon パッケージ名 `bag-visual-feedback-daemon` を将来揃えるか（今回は対象外）。

## 検証
- `bash -n scripts/preflight.sh` OK ＋ grep 交替の機能確認（新旧 alias 検出 / 無関係行は非マッチ）。
- ガバナンススイート `node --test .claude/scripts/lib/__tests__/*.test.mjs` 53/53 pass、
  `node .claude/scripts/check-hook-refs.mjs` OK。
- `npm run check:markers`（14 マーカー）/ `check:glossary`（警告0）/ `glossary:staleness`（変更コード0）緑。
- 敵対的検証ワークフロー（rename-mapping / alias-migration / consistency / scope-guard）全 4 レンズ PASS
  （唯一の nit＝例に `dataAgentId` 欠落 を修正済み）。
- 重い Playwright/browser テスト（`test` / `test:vf` / `test:ui`）は拡張/daemon ソース無変更のため対象外
  （意図的スキップ。#59 で確認済みの spa-recipe フレークは本PRと無関係）。
