# 「メモを残す」注釈を capture 抜きで読む (CDP 直読み)

## 解決する問題

「メモを残す」(**Add note**) はページ上の要素にメモを付ける操作だが、保存先は拡張機能自身の
`chrome.storage.local` (キー `aiAdvisorAnnotations`) **だけ**で、daemon/MCP には自動送信されない。
daemon に届くのは、サイドパネルの「画像でAIへ送る」を明示的に押した時 (または Options の
`daemon` + `pageFeedback.autoSync`、いずれも既定 OFF、を有効化している時) だけである。

そのため、メモを書いただけで capture 操作をしていない場合、`bag_page_feedback` の MCP ツールは
「0件」を返す。メモはページ上には確かに残っているのに daemon 経由では見えない、という状態になる。

本スクリプト (`scripts/read-annotations-cdp.mjs`) は、daemon/MCP を一切経由せず、**拡張機能自身の
実行コンテキスト**(サイドパネル / オプションページ)に対して Chrome DevTools Protocol (CDP) の
`Runtime.evaluate` を直接叩き、`chrome.storage.local.get('aiAdvisorAnnotations')` を呼び出すことで
この注釈を直接読み出す。capture 操作は一切不要。

## 前提: remote-debugging 付き Chrome

このスクリプトが繋ぐ先は、`--remote-debugging-port` を付けて起動した Chrome インスタンス。
**ユーザーの普段使いの Chrome をそのまま使うことはできない**(Chrome はデフォルトプロファイルへの
remote-debugging を許可しない)。専用の複製プロファイルで別プロセスとして起動するのが安全:

```bash
open -na "Google Chrome" --args \
  --user-data-dir="$HOME/chrome-debug-clone" \
  --remote-debugging-port=9333 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check
```

- `--user-data-dir` は普段使いのプロファイルの**複製**を強く推奨 (ログイン状態を保った専用プロファイル)。
  普段の Chrome とは別プロセスとして並走できる (`open -na` で起動すれば普段の Chrome は落ちない)。
- 対象の拡張機能 (Browser Agent Guide) がその複製プロファイルに読み込まれている必要がある
  (`chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」、または `--load-extension=<repo>`)。
- ポートは任意。本スクリプトは既定で `9333`→`9222` の順に試す(`--port` で明示指定、または
  `CHROME_DEBUG_PORT` 環境変数でも可)。

## 使い方

```bash
npm run read-annotations                                  # 既定ポート候補を順に試し、全件を人間可読で表示
node scripts/read-annotations-cdp.mjs --kind note          # メモ(お描きを除く)だけ
node scripts/read-annotations-cdp.mjs --scope example.com  # scope(ページ origin+pathname)の部分一致で絞込み
node scripts/read-annotations-cdp.mjs --since 2026-07-01   # 指定日時以降の createdAt だけ
node scripts/read-annotations-cdp.mjs --json               # JSON 出力 (annotation.json の item 形式 + scope)
node scripts/read-annotations-cdp.mjs --extension-id <id>  # 拡張IDを固定し自動判別をスキップ
node scripts/read-annotations-cdp.mjs --port 9222 --limit 5
```

全オプションは `node scripts/read-annotations-cdp.mjs --help` を参照。

## 動作の仕組み

1. `--port` 候補(既定 `9333, 9222`)へ順に `http://127.0.0.1:<port>/json/version` を叩き、生きている
   remote-debugging エンドポイントを見つける。
2. `/json/list` でターゲット一覧を取得し、`chrome-extension://` ページのうち
   `sidepanel/sidepanel.html` または `options/options.html` で終わるものを候補として集める
   (既にサイドパネル/オプションが開いていれば、それをそのまま再利用する — 新規タブは開かない)。
3. ターゲットの再利用には優先順位がある: (a) 開いているページ(sidepanel/options)があればそれを
   再利用し、(b) 無ければ `/json/list` 上に既に存在する当該拡張の `service_worker`(MV3)/
   `background_page`(MV2)ターゲットを探して再利用する — どちらも新規タブは一切開かない。
   (c) それでも見つからない場合に**限り最後の手段として**、CDP `Target.createTarget` で候補拡張ID
   の `options/options.html` を **バックグラウンドタブとして**新規に開く(フォーカスは奪わない)。
4. `Target.attachToTarget({flatten:true})` でセッションを張り、`chrome.runtime.getManifest().name`
   を評価して対象拡張(既定 `"Browser Agent Guide"`、`--extension-name` で変更可)であることを確認する。
   一致しなければ(自分で開いたタブなら)閉じて次の候補へ進む — 無関係な拡張機能を最大
   `MAX_CANDIDATE_EXTENSIONS`(既定8)件まで試す。
5. 一致したセッションに対して `chrome.storage.local.get('aiAdvisorAnnotations')` を評価し、結果を
   `--kind` / `--scope` / `--since` / `--limit` でフィルタして表示する。
6. 自分で新規に開いたタブは、既定では後片付けとして閉じる(`--keep-tab` で残せる)。**既にユーザーが
   開いていたページは絶対に閉じない。**

## 安全上の注意

- 読み出すキーは **`aiAdvisorAnnotations` 固定**。拡張の設定ブロブ `aiAdvisorSettings` には AI の
  API キーが含まれるため、本スクリプトはこれに一切触れない設計になっている(`--key` のような
  任意キー指定オプションは意図的に用意していない)。
- `--remote-debugging-port` は**その PC 上の任意のプロセスがブラウザを完全に操作できる**ことを意味する。
  信頼できない環境では有効化しない。デバッグ用途が終わったらそのプロセスは終了する。

## chrome-devtools-mcp ではなく自前スクリプトである理由

同じ用途に Google 公式 [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) を
使うことも検討したが、**v1.4.0 時点では非対応**であることをソース読解で確認した:
拡張機能ターゲット(`chrome-extension://` の service worker / ページ)を可視化する
`--categoryExtensions` フラグは、chrome-devtools-mcp が**自分で新規に Chrome を起動する経路
(pipe接続)でしか有効にならない**よう明示的に配線されており(`src/index.ts` `getContext()`)、
`--autoConnect` / `--browserUrl` / `--wsEndpoint` による**既存 Chrome への接続(attach)経路とは
互換性がない**(`CHANGELOG.md`: "mark categoryExtensions flag mutually exclusive with autoConnect"、
意図的な仕様)。つまり「ユーザーが既に開いている Chrome にそのまま繋いで拡張機能のストレージを読む」
は、この版の chrome-devtools-mcp では実現できない。

本スクリプトは chrome-devtools-mcp を経由せず、`/json/list` + 生の CDP WebSocket
(`Target.createTarget` / `Target.attachToTarget` / `Runtime.evaluate`)を直接叩くことでこの制約を
回避している。将来 chrome-devtools-mcp 側でこの制約が緩和された場合も、本スクリプトは依存パッケージ
ゼロ(Node 組み込みの `fetch`/`WebSocket` のみ)で動き続ける。

## 既知の制限

- Node 22+ が必要(組み込み `WebSocket` を使用)。古い Node では明示的なエラーで停止する。
- 対象拡張機能がその Chrome インスタンスに読み込まれていない場合は読めない(あたりまえだが、
  普段使いのプロファイルではなく専用の複製プロファイルを起動している場合、そちらにも拡張機能を
  読み込んでおく必要がある)。
- 複数の Chrome ウィンドウ/プロファイルにまたがる探索はしない。対象は `--port` で指定した
  remote-debugging エンドポイント1つに閉じる。
- 候補拡張に開いているページも生きている service_worker/background_page も無い場合(例: MV3 の
  service worker がアイドルで終了済み)は、上記の再利用ができないため、manifest name を確認するのに
  一時的にバックグラウンドタブを1つ開いて閉じる、という副作用が今も残る。これは
  `MAX_CANDIDATE_EXTENSIONS`(既定8)で上限を設けているが、「事前情報なしに未知の拡張機能の正体を
  確認する」という処理そのものに内在する限界であり、完全には無くせない。
