# glossary/ — ドメイン用語の SSOT (Living Glossary)

自然言語のタスク指示を **用語 id** にアンカーし、各用語が「どの仕様書を参照し / どれくらい
進捗していて / どの DB・API を使うか」を AI が即座に把握できるようにするための単一の真実。

- 1ファイル = 1用語: `glossary/<bounded_context>/<id>.md`
- スキーマ: [`_schema.md`](./_schema.md)(人間向け仕様。機械の正典は `scripts/glossary/validate.mjs`)
- 運用手順(コードを直したら用語を更新する仕組み): [`../docs/glossary-mechanism.md`](../docs/glossary-mechanism.md)

## よく使うコマンド

```bash
npm run check:glossary     # スキーマ/参照/鮮度/マーカーを検証
npm run glossary:staleness # コード変更↔用語の未更新を検出(既定 --base origin/main)
npm run glossary:touch <id># 再検証済みとして last_verified を今日に更新
npm run glossary:trace     # 用語⇄コードのトレーサビリティ表を生成(glossary/TRACEABILITY.md)
npm run test:glossary      # メカニズム自体のテスト
```

## AI への渡し方(誤解防止)

タスク着手前に、関連する用語エントリだけを読み、`id` / 定義 / 正本(`code_refs`) / `confidence`
を復唱してから作業する。`deprecated_terms` に該当する語は正称へ正規化する。
