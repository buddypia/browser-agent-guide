# REVIEW — Living Glossary: 「コードを直したら関連ドキュメントを更新」を強制する SSOT メカニズム

## 概要
自然言語のタスク指示で AI が誤解して別作業をしないよう、ドメイン用語の SSOT(`glossary/<ctx>/<id>.md`)を
新設した。各用語は frontmatter で「定義 / owner / status / 参照(仕様 source_refs・実装 code_refs・
API api_refs・DB db_refs) / last_verified / confidence」を機械可読に持つ。さらに **コードを直したら
関連ドキュメントが必ず更新される** ことを、コード中の `@term:` ガード範囲と git diff の重なりで
機械的に強制する staleness ゲートを実装した。multi-llm-debate(Gemini×Claude×GPT)の合意
「生成優先・手動最小・観測可能性重視・重要箇所のみ強制」を設計原則にしている。

## なぜ
自然言語は無制約で多義的なので、AI は用語を取り違えて別作業をする。本リポジトリは既に
「LLM に自由な DOM 操作を与えず、閉じた verb registry(制約付き語彙)で操作させる」思想で出来ており、
同じ思想を開発ワークフローへ適用した。最大の課題「機能開発のたびに参照元と用語集が陳腐化する」を、
人手の規律ではなく **機械ゲート** で解く必要があった。

## 何を
- `glossary/` 新設: スキーマ(`_schema.md`)+ 実コードに紐づくシード用語 5 件
  (extension: verb-registry / recipe / affordance、daemon: entry-store / visual-feedback)。
- `scripts/glossary/`: 依存ゼロのツール群
  - `lib/frontmatter.mjs`(STRICT な YAML サブセットパーサ)/ `lib/entries.mjs` / `lib/markers.mjs` /
    `lib/git.mjs` / `lib/code.mjs`
  - `validate.mjs`(スキーマ/参照存在/鮮度/孤立マーカー検証)
  - `check-staleness.mjs`(**核**: 変更ガード範囲↔用語 last_verified の未更新を検出)
  - `build-traceability.mjs`(用語⇄コードの RTM 生成、生成物)/ `touch.mjs`(last_verified 更新)
  - `install-git-hook.sh`(pre-commit 導入)
- 実コード 7 箇所に `// @term: <id>` … `// @endterm` ガードを付与(content-script.js ×2,
  ai-client.js, recipe-merge.js, service-worker.js, store.js, compositor.js, offscreen.js)。
- テスト `test/glossary/*.test.mjs`(24 件、staleness の fail/success を一時 git repo で実証)。
- `.github/workflows/glossary.yml`(サーバ側の最終ゲート)。
- `package.json`(check:glossary / test:glossary / glossary:* を追加、check チェーンと check:js に組込)、
  `package-extension.sh`(glossary/・.github/ を zip 除外)、`.gitignore`(生成物 TRACEABILITY.md)、
  `AGENTS.md` / `docs/glossary-mechanism.md`(運用 runbook)。

## どうやって
staleness の判定は **file 単位ではなくマーカーのガード範囲単位**。`@term:` 行から次の
`@term:`/`@endterm`/EOF までをガード範囲とし、git diff の変更行範囲(`--unified=0` の `@@` ヘッダ解析)が
重なった用語だけ、その last_verified が同じ差分で前進していることを要求する。これにより大きい
ファイルでも無関係な変更で誤検出せず(=ゲートが `--no-verify` で形骸化しない)、かつ load-bearing な
変更は確実に捕捉する。モードは `--working`(ローカル)/ `--staged`(pre-commit)/ `--base REF`(CI/PR)。

## 影響
- `npm run check` に check:glossary + test:glossary が入る(いずれも Node のみ・依存ゼロ・高速)。
- CI は元来「無し」だったが、用語集 *だけ* を回す独立ワークフローを追加(playwright は含めない)。
- 既存の拡張/daemon 挙動には影響なし(追加したのは全てコメントマーカーと新規ファイル)。
  compositor.js の banned-token スキャン(test:vf)も通過。

## トレードオフ
- 強制は「マーカーで囲った領域」だけに効く。網羅性は `@term:` の付与に依存する(opt-in bootstrap、
  既存の `@agent:` マーカー文化と同じ)。最初から全コードは囲わない。
- frontmatter パーサは依存を増やさないため自前。未知構文は黙って誤解釈せず必ず throw する設計で安全側に倒した。
- RTM(TRACEABILITY.md)は二重ドリフトを避けるためコミットせず生成物にした(オンデマンド再生成)。
- 意味的な正しさは CI で判定しない(人手/owner レビューの責務)。これは意図的な非ゴール。

## 残作業
- なし(コア機構は完成・テスト済み)。横展開(用語の追加)は段階的に。
- ローカル強制を使うなら各自 `bash scripts/glossary/install-git-hook.sh` を一度実行。
- PR 前に `git fetch origin main` → `git diff --name-status origin/main...HEAD` で上流差分を確認。

## ファイル構造
```
glossary/_schema.md, README.md, extension/*.md, daemon/*.md   # ドメイン SSOT
scripts/glossary/{validate,check-staleness,build-traceability,touch}.mjs, lib/*.mjs, install-git-hook.sh
test/glossary/{frontmatter,markers,staleness,validate}.test.mjs
.github/workflows/glossary.yml
docs/glossary-mechanism.md                                    # 運用 runbook
content/content-script.js, lib/ai-client.js, lib/recipe-merge.js,
background/service-worker.js, daemon/src/store.js,
lib/visual-feedback/compositor.js, offscreen/offscreen.js     # @term: マーカー付与のみ
package.json, package-extension.sh, .gitignore, AGENTS.md
```

## レビュー依頼
- ガード範囲(`@term:`〜`@endterm`)の粒度: verb-registry を AI_VERBS 全体に掛けるのは妥当か(広すぎ/狭すぎ)。
- staleness の既定モード(`--base origin/main`)と CI の `--base origin/<base_ref>` の組合せが妥当か。
- frontmatter を自前パーサにした判断(依存ゼロ優先 vs js-yaml)への異論はないか。

## 検証
- `npm run check:js && npm run check:markers && npm run check:glossary && npm run test:glossary` → OK
- `npm run test:vf`(14)/ `test:recipe`(9)/ `test:prompt`(6)/ `test:workflow-lib`(17)/ `test:slug`(7) → 全 OK
- `cd daemon && npm test` → 87 OK
- `node --test 'test/glossary/*.test.mjs'` → 24 OK(staleness の fail/success 実証含む)
- 注: `npm test`(playwright-cli)/ `test:ui`(playwright)はブラウザ要のため別途。
