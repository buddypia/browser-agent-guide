# 実地確認スクリプト / Live checks

`npm run check` の Playwright テストは手元の fixture だけを使う。ここのスクリプトは、**実サイト**や**実 CLI** で同じ流れが
通るかを人が確かめるためのもので、check にも CI にも入っていない(ネットワーク・サイトの変更・課金に左右されるため)。
どれも使い捨ての Chrome プロファイルに拡張を読み込み、終わったらプロファイルごと消す。結果は OS の一時ディレクトリの
`bag-live-*/report.json` に書き、最後の行にパスを出す。全項目が通れば exit 0。

These scripts exercise real sites / real CLIs and are **not** part of `npm run check` or CI. Each one loads the unpacked
extension into a throwaway Chrome profile, deletes it afterwards, writes `report.json` under the OS temp dir and exits 0 only
when every check passed.

| スクリプト | 確かめること |
|---|---|
| `workflow-wikipedia.mjs` | ja.wikipedia.org で人の操作を記録 → 別セッションで自動実行。入力 → 動的な検索候補から選ぶ → 記事 → ツール → PDF ページ → ダウンロード完了(`check.type:'download'`)まで、ページを跨いで進む |
| `element-fix-via-cli.mjs` | 実拡張 + 実 daemon + MCP + 実 CLI(Claude Code / Codex / Antigravity)。「AIに渡す」にチェックしたメモだけが MCP に届き、CLI がその要素だけを `execute_actions` で直し、チェックを外したメモの要素は触らない。daemon は memory モードで inbox を作らない |
| `workflow-amazon.mjs` | amazon.co.jp(未ログイン)で記録 → 自動実行。検索 → 動的な結果から商品を選ぶ → 商品ページまで進み、「今すぐ買う」は承認まで押さずに止まる(購入は成立しない) |

```bash
node scripts/live/workflow-wikipedia.mjs
node scripts/live/workflow-amazon.mjs
node scripts/live/element-fix-via-cli.mjs claude codex agy   # 1つ以上。各 CLI のログインが要り、トークンを消費する
# 候補選びを System One(Jev)にも任せる回を足す(1回ずつ API を呼ぶ):
TYPESAFE_API_KEY=... node scripts/live/workflow-wikipedia.mjs
# 同じ回をローカル EmbeddingGemma 2 で(EG2_URL 既定 http://127.0.0.1:38765。課金なし):
BAG_LIVE_JUDGE=eg2 node scripts/live/workflow-wikipedia.mjs
```

- `TYPESAFE_API_KEY` も `BAG_LIVE_JUDGE=eg2` も無ければ、記録したルールでの選び方だけを確かめる。キーは使い捨てプロファイルの storage にだけ置く。
- 判断AIが確信を持てずに止めたときは、スクリプトが人の代わりに示された候補を承認し(`judgeHeld` に記録)、その候補で先へ進むかを見る。
- eg2 は埋め込みの類似度で選ぶので、「黒(他色ではない)」のような否定は読めない。amazon では近い他色(ブルーブラック)を最有力にした
  (確信度の差が小さく保留になった)。人なら承認しない候補でも、スクリプトは承認して先を見る。
- 実サイトの文言や DOM が変わると、記録の段階(人の操作の再現)で失敗する。その時はスクリプトのセレクタを直す。
- 報告には入力した文字列を書かない(`{変数}` だけ残す)。
- `agy` は CLI 引数で MCP を渡せないため、実行中だけ一意な名前 `baglive_<乱数>` でグローバル設定に登録し、終了時(Ctrl-C を含む)に外す。
  強制終了(kill -9)で残ったら `agy mcp list` で確かめて `agy mcp remove <名前>`。
- claude は `--allowedTools`、codex は `-s read-only` で使える道具を絞るが、`agy` には同等の制限が無い(プロンプトで MCP だけを使うよう頼むだけ)。
  作業ディレクトリは一時ディレクトリにしている。
