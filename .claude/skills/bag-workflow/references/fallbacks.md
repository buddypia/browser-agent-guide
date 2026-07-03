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
claude mcp add --transport http bag_page_feedback http://127.0.0.1:8765/mcp
claude mcp list   # bag_page_feedback が出れば OK
```

FILE 経路で読むもの (preflight の `latest=` フォルダ):
`shot.png`(vision) / `raw.png`(before) / `annotation.json`(構造) / `memo.md`(人間可読)。
それも無ければ: `node /Users/a13973/dev/buddypia/browser-agent-guide/daemon/scripts/probe.mjs ~/Downloads/ai-inbox --url <断片>`

---

## MCP は registered/Connected のはずなのに ToolSearch で見つからない (mcp=registered だが未接続)

preflight の `mcp=registered`(`claude mcp list`/`codex mcp list` で行がある)は、**その場で新規に
疎通確認した結果**でしかない。Claude Code は MCP サーバーへの接続を**この会話セッションが起動した
時点**で確立し、そこで失敗すると、daemon が後から立ち上がってもこのセッション内では自動回復しない
(切断からの自動再接続はある。未接続からの自動接続は無い)。よくある原因は「daemon をこの会話の
**後から**起動した」「`claude mcp add` をこの会話の**途中で**実行した」の2つ。

> MCP はこの会話セッションでは接続できていないようです(設定上は登録済みでも、セッション開始時に
> daemon との接続が確立できないと、このセッション内では自動回復しません)。ファイルから直接読める
> 場合はそちらで進めます。**次回から自動取得したい場合は、新しい会話を開始してから** `/bag-workflow`
> を実行し直してください。
> The MCP connection wasn't established for this session (even though it's registered) — Claude
> Code only connects to MCP servers at session startup and won't auto-recover mid-session. If a
> file capture exists, proceed with that. Otherwise, please start a new conversation and re-run.

`capture=yes` なら FILE 経路でそのまま続行できる。`capture=no` なら新しい会話セッションの開始を促す
(この preflight を再実行しても直らない — bash からは今のセッションの接続状態を検出できない)。

---

## お描き／メモが見つからない (capture=no / source_branch=NONE)

> お描き／メモがまだ届いていません。拡張機能の「お描き / Draw」で直したい所を丸や矢印で囲む、
> または「メモを残す / Add note」で要素にメモを書いてから、**サイドパネルの「画像でAIへ送る」を押して送信**し、
> もう一度 `/bag-workflow` を実行してください。
> Nothing received yet. Draw with お描き/Draw, or leave a memo with "Add note", then press
> "Send to AI" (画像でAIへ送る) in the side panel, then re-run.

> **「メモを残す」だけでは届かない**: メモはページに保存されるだけで、上の送信(または Options で
> daemon + autoSync を ON。既定 OFF)まで daemon には届かない。「見つからない」の最頻原因はこの未送信。
> A memo left on the page is NOT sent until you press "Send to AI" (or enable daemon+autoSync, both default OFF).

`urlContains` (ページアドレスの一部、例 `example.com`) を渡したのに 0 件なら、フィルタを外すか `list_feedback` で一覧を見せて選ばせる。

**「メモを残す」は書いたが送信していない、かつユーザーが送信操作をしたくない/できない場合**:
remote-debugging 付き Chrome (ユーザーが既に起動している、または起動できる) があれば、daemon を
一切経由せず `chrome.storage.local` から直接読める。

```bash
node /Users/a13973/dev/buddypia/browser-agent-guide/scripts/read-annotations-cdp.mjs --kind note
```

remote-debugging Chrome が無ければ、下のコマンドで起動を案内する(専用の複製プロファイルを使うこと。
普段のデフォルトプロファイルでは Chrome が remote-debugging を拒否する):

```bash
open -na "Google Chrome" --args --user-data-dir="$HOME/chrome-debug-clone" \
  --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check
```

詳細・安全上の注意 (読むキーは `aiAdvisorAnnotations` 固定で API キーには触れない、等) は
`docs/reading-annotations-via-cdp.md` 参照。**これは daemon/MCP 経路の代わりではなく最終手段**:
まずは「画像でAIへ送る」を案内し、それが無理な時だけこちらを使う。

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
それでも曖昧なら `list_feedback({ urlContains })` で候補を出し、ユーザーに slug を選ばせる。

---

## Codex でライブページを読みたいと言われた

不可。`codex:rescue` / `codex exec` は **ブラウザ非搭載** (web 検索のみ)。
ライブ読み取りは Claude 側の playwright-cli / `claude --chrome` を使う。
Codex の browser/computer-use はデスクトップアプリの `@chrome`/`@browser`/`@computer` のみ (`browser-tools.md` 参照)。
