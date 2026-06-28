# 用語エントリのスキーマ (Living Glossary)

このファイルは **人間向けの仕様書** です。機械的な正典(SoT)は
`scripts/glossary/validate.mjs` の `REQUIRED` / `ENUMS` 定数で、frontmatter は
依存ゼロの STRICT パーサ `scripts/glossary/lib/frontmatter.mjs` が解釈します。
パーサが解釈できる YAML サブセットの厳密な定義は frontmatter.mjs の先頭コメントを参照。

## 1ファイル = 1用語

- 置き場所: `glossary/<bounded_context>/<id>.md`
- `id` が **安定キー**。これだけが参照に使われる(リネーム耐性)。
- 先頭が `_` のファイル(本ファイル等)、`README.md`、自動生成の `TRACEABILITY.md` は
  用語エントリとして扱われない。

## frontmatter フィールド

| key | 必須 | 型 | 説明 |
|---|---|---|---|
| `id` | ● | scalar | 安定ID。`^[a-z0-9][a-z0-9-]*$`。ファイル名(拡張子除く)と一致させる。|
| `term` | ● | scalar | 表示名。JP/EN 併記可。|
| `status` | ● | enum | `draft` / `in-progress` / `stable` / `deprecated` |
| `owner` | ● | scalar | 責任者。`@handle` 形式推奨(CODEOWNERS 相当)。|
| `bounded_context` | ● | scalar | DDD の境界づけられたコンテキスト。フォルダ名と一致。|
| `last_verified` | ● | scalar | `YYYY-MM-DD`。**最後に人が内容を検証した日**。鮮度ゲートの基準。|
| `confidence` | ● | enum | `high` / `medium` / `low`。AI に不確実性を伝える。|
| `aliases` | | list | 別名・英略称。|
| `deprecated_terms` | | list | 使ってはいけない旧称(traceability が新規出現を警告)。|
| `progress` | | map | `state`(`planned`/`in-progress`/`shipped`) と `tracking`(Issue/PR の URL)。進捗の正本は Issue/PR で、ここはリンクのみ。|
| `source_refs` | | list\<map\> | 仕様書/設計ドキュメント。`{ type, path, anchor? }`。`path` の存在を検証。|
| `code_refs` | | list\<map\> | 実装の正本。`{ path, symbol? }`。`path` の存在と `symbol` の出現を検証。|
| `api_refs` | | list\<map\> | 利用する API。`{ name, spec? }`(OpenAPI operationId など)。|
| `db_refs` | | list\<map\> | 利用する DB/テーブル/dbt model。`{ name, source? }`。|
| `related` | | list | 関連用語の `id`。存在を検証(孤立リンク禁止)。|

本文(frontmatter の後)には最低限 `## 定義` を書く。「やってはいけないこと」など補足は任意。

## コードとの双方向トレーサビリティ

- **順方向(用語→実装)**: 上記 `code_refs` / `source_refs`。
- **逆方向(実装→用語)**: コード中の `@term: <id>` マーカー。マーカー行から次の
  `@term:` / `@endterm` / EOF までが **ガード範囲** で、そこが変更されると
  `check-staleness.mjs` がその用語の再検証(= `last_verified` の更新)を要求する。
  これが「コードを直したらドキュメントを更新する」を機械的に強制する核。

## 不変条件(validate.mjs / traceability が守る)

1. `id` は全用語で一意。ファイル名(拡張子除く)と一致。
2. 必須フィールドが揃い、enum は許可値のみ。
3. `source_refs.path` / `code_refs.path` は実在し、`code_refs.symbol` はそのファイルに出現する。
4. `related` と `@term:` マーカーの id は実在する用語を指す(孤立禁止)。
5. `status: stable` の用語は `last_verified` が一定日数以内(既定 180 日)。
