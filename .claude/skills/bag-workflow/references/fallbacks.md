# フォールバック集 — 「○○が無い」を詰まらせず復旧する

非エンジニアが詰まったら、スタックトレースではなく**そのままコピペできるコマンド**を日本語＋英語で出す。
preflight の `STATUS` 行で状況を判定し、該当ブロックを案内する。

---

## daemon が停止している (daemon=down)

> お描きを届けるプロセスが動いていません。下のコマンドを**順番に1行ずつ**ターミナルに貼ってください。
> The daemon is not running. Paste these into your terminal, one line at a time:

```bash
cd /Users/a13973/dev/buddypia/browser-agent-guide/daemon   # ① daemon フォルダへ移動 / go to the folder
npm install                                                # ② 初回のみ準備 / first-time setup
npm start                                                  # ③ サービス起動 / start the service
```
別のターミナルを開いて確認 / open another terminal to verify:
```bash
curl -s http://127.0.0.1:8765/healthz
```
daemon が `down` でも、お描きが既にファイルとして残っていれば (`capture=yes`) **FILE 経路で続行できる** (起動を待たなくてよい)。
進めてよいか一言添える。

---

## daemon は動くが MCP 未登録 (mcp=absent)

ファイル直読み (FILE 経路) で**今すぐ進められる**。あわせて次回のため 1 回だけ登録を勧める。

> 今回はお描きをファイルから直接読みます。次回から自動取得したい場合はこれを 1 回:
> Reading the drawing from files this time. To auto-fetch next time, run once:

```bash
claude mcp add --transport http bag_visual_feedback http://127.0.0.1:8765/mcp
claude mcp list   # bag_visual_feedback が出れば OK
```

FILE 経路で読むもの (preflight の `latest=` フォルダ):
`shot.png`(vision) / `raw.png`(before) / `annotation.json`(構造) / `memo.md`(人間可読)。
それも無ければ: `node /Users/a13973/dev/buddypia/browser-agent-guide/daemon/scripts/probe.mjs ~/Downloads/ai-inbox --url <断片>`

---

## お描きが見つからない (capture=no / source_branch=NONE)

> お描きがまだありません。拡張機能の「お描き / Draw」で直したい所を丸や矢印で囲み、
> 番号付きでメモ (例「ここを大きく」) を書いて送信してから、もう一度 `/bag-workflow` を実行してください。
> No drawing yet. Use the extension's お描き/Draw to circle the target, add a numbered memo, submit, then re-run.

`urlContains` (ページアドレスの一部、例 `example.com`) を渡したのに 0 件なら、フィルタを外すか `list_visual_feedback` で一覧を見せて選ばせる。

---

## ライブブラウザの手段が無い (browser=none かつ claude --chrome / browser MCP も無し)

**静的検証のみ**に切り替える (ライブ目視はスキップ):
1. `raw.png` (before) と `annotation.json` の `anchorLabel`/`selector` でソースを特定。
2. 編集。
3. リポジトリのゲートで検証: `npm run check` (必要なら `cd daemon && npm test`)。
4. 「ライブでの見た目確認はスキップしました」と明記する。

playwright-cli を入れたい場合の案内 (任意):
```bash
playwright-cli --version || echo "playwright-cli が見つかりません"
```

---

## ログイン必須でページが開けない

使い捨てブラウザでは入れない → ユーザーのログイン済みセッションを使う:
- ネイティブ: `claude --chrome` または セッション内で `/chrome` (要 有料プラン + Claude in Chrome 拡張)
- もしくは (要セットアップ): Chrome を `--remote-debugging-port=9222` で起動してから `playwright-cli attach --cdp=http://127.0.0.1:9222`。非エンジニアには上の `claude --chrome` が簡単。

---

## @agent: マーカーが無い要素 (主要UIには付与済み)

正常。主要UI(sidepanel/options)には付与済みだが大半の要素は未付与。`agent-markers.md` の通り **selector / anchorLabel フォールバック**で特定する。
`anchorLabel` の表示テキストを `rg` で探すのが最有効。マーカー付与はユーザー opt-in 時のみ (黙って失敗にしない)。

---

## CLI が MCP の image(vision) を扱えない (例: 一部 IDE)

MCP は image と一緒に**絶対 `file_path`** を必ず返す。vision が使えない時は、その `file_path` の
`shot.png` / `annotation.json` を Read して指示を読む (テキスト fallback)。

---

## 共有 inbox で別プロジェクトのお描きが返る

`~/Downloads/ai-inbox` は全プロジェクト共有。必ず `urlContains` / `titleContains` でスコープする。
それでも曖昧なら `list_visual_feedback({ urlContains })` で候補を出し、ユーザーに slug を選ばせる。

---

## Codex でライブページを読みたいと言われた

不可。`codex:rescue` / `codex exec` は **ブラウザ非搭載** (web 検索のみ)。
ライブ読み取りは Claude 側の playwright-cli / `claude --chrome` を使う。
Codex の browser/computer-use はデスクトップアプリの `@chrome`/`@browser`/`@computer` のみ (`browser-tools.md` 参照)。
