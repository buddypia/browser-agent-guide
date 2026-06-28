# Living Glossary — 運用メカニズム (runbook)

> 目的: 自然言語の指示で AI が誤解して別作業をしないよう、**SSOT の用語集**を起点に
> 「各用語がどの仕様書/DB/API を参照し、どれくらい進捗しているか」を AI が即座に把握でき、
> かつ **機能開発のたびに参照元と用語集が陳腐化せず正しく更新され続ける** ことを機械的に保証する。
>
> 設計方針(multi-llm-debate の合意): **生成優先・手動最小・観測可能性重視・重要箇所のみ強制**。
> 「完全自動で陳腐化ゼロ」は狙わない。狙うのは「ズレを検出可能にし、重要箇所だけ強制」すること。

このリポジトリ自身が *「LLM に自由な DOM 操作を与えず、閉じた決定的な verb registry(制約付き語彙)
で操作させる」* 思想で出来ている。本メカニズムは **同じ思想を開発ワークフローへ適用** したもの
— 自由な自然言語を、用語 id という制約付き語彙にアンカーする。

## 全体像

```
            ┌─────────────────────────┐
  人間が編集 │ glossary/<ctx>/<id>.md   │  定義・owner・status・参照(仕様/DB/API)・last_verified
            └────────────┬────────────┘
                         │ frontmatter(機械可読)
   ┌─────────────────────┼───────────────────────────────────┐
   │順方向: code_refs/source_refs           逆方向: @term: マーカー(コード内)
   ▼                                                          ▼
validate.mjs(参照存在/enum/鮮度/孤立)        check-staleness.mjs(ガード範囲が変わったら
                                              last_verified の前進を要求 = ドキュメント更新の強制)
   └──────────── npm run check / pre-commit hook / CI(.github/workflows/glossary.yml) ───────────┘
```

## 構成要素

| ファイル | 役割 |
|---|---|
| `glossary/<ctx>/<id>.md` | 用語の定義。frontmatter が機械可読の真実。|
| `glossary/_schema.md` | スキーマ(人間向け)。機械の正典は `validate.mjs`。|
| コード中の `// @term: <id>` 〜 `// @endterm` | その用語に紐づく **ガード範囲**(逆引き)。|
| `scripts/glossary/validate.mjs` | スキーマ/参照存在/鮮度/孤立マーカーの検証。`npm run check:glossary`。|
| `scripts/glossary/check-staleness.mjs` | **コードを直したら用語を再検証させる核**。|
| `scripts/glossary/build-traceability.mjs` | 用語⇄コードの RTM を生成(`npm run glossary:trace`)。|
| `scripts/glossary/touch.mjs` | `last_verified` を今日に更新(`npm run glossary:touch <id>`)。|
| `scripts/glossary/install-git-hook.sh` | pre-commit hook を導入(ローカル早期ゲート)。|
| `.github/workflows/glossary.yml` | サーバ側の最終ゲート(hook を回避しても必ず捕捉)。|

## なぜ「コードを直したら用語を更新」が機械的に効くのか

1. 用語に紐づく **load-bearing なコード領域** を `@term: <id>` 〜 `@endterm` で囲む。
2. `check-staleness.mjs` は git diff の **変更行範囲** と、新しいファイル内の **ガード範囲** の
   重なりを見る。重なったら「その用語に影響する変更」とみなす。
3. その用語エントリの `last_verified` が **同じ変更の中で前進している** ことを要求する。
   前進していなければ「コードを変えたのに用語を再検証していない」として **exit 1**。
4. 変更がガード範囲の **外** なら何も要求しない(誤検出しない)。→ ノイズで形骸化させない。

> file 単位ではなく **マーカーのガード範囲単位** で見るのが肝。大きいファイル(例 4000 行の
> content-script.js)で file 単位にすると無関係な変更まで用語更新を要求し、結局ゲートが
> `--no-verify` で回避されて死ぬ。精密に紐付けることで「強制」が現実に機能し続ける。

## 日常ワークフロー

### A. 機能を実装/修正したとき

```bash
# 1. 変更が用語のガード範囲に触れたかを確認
npm run glossary:staleness            # 既定 --base origin/main。ローカルは --working でも可
# → 「用語 X の last_verified が更新されていません」と出たら:
#    1) その用語エントリを開いて定義/参照(code_refs/api_refs/db_refs)/status が現状と合うか直す
#    2) 再検証済みとして日付を前進
npm run glossary:touch X
# 2. 用語集全体の整合
npm run check:glossary
```

### B. 新しい用語を足すとき

1. `glossary/<bounded_context>/<id>.md` を作る(`_schema.md` の必須フィールドを埋める)。
2. その用語の load-bearing なコードに `// @term: <id>` 〜 `// @endterm` を置く。
3. `npm run check:glossary` で参照存在・マーカー解決を確認。
4. (任意)`npm run glossary:trace` で RTM を見て関連を確認。

### C. AI にタスクを指示する前(誤解防止のプロトコル)

AI は着手前に、関連する用語エントリだけを読み、次を復唱してから作業する:

- 対象用語の `id` と定義
- 正本(`code_refs`)= 触るべき実装ファイル/シンボル
- `confidence`(low の用語に依存する変更はレビュー必須フラグ)
- `deprecated_terms` に該当する語は正称へ正規化

## 強制レイヤ(3段、強制は最小限)

1. **ローカル pre-commit hook**(`bash scripts/glossary/install-git-hook.sh`) … 最速のフィードバック。
   緊急回避は `git commit --no-verify`(CI が後段で必ず捕捉)。
2. **`npm run check`** … `check:glossary` + `test:glossary` を含む(手元の総合ゲート)。
3. **CI**(`.github/workflows/glossary.yml`) … hook を回避しても止まる最終ゲート。
   PR で `check-staleness --base origin/<base>` を回す。

## やらないこと(意図的な非ゴール)

- **意味的な正しさを CI で判定しない**。CI は機械検証できる事実(参照切れ/鮮度/孤立)だけを止める。
  定義文の妥当性・status 昇格は owner の人手レビュー(CODEOWNERS 相当)で守る。
- **完全自動の用語生成はしない**。生成するのはトレーサビリティ(派生ビュー)まで。定義は人間が書く。
- **`glossary/TRACEABILITY.md` はコミットしない**(生成物)。`npm run glossary:trace` で随時再生成。

## 計測(観測可能性)

導入効果は次で測り、ROI が出た bounded_context から横展開する:
AI タスク成功率 / 手戻り件数 / 未検証用語率(`last_verified` 切れ割合) / ゲート回避率(`--no-verify` 頻度)。
