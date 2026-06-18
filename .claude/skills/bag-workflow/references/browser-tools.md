# ブラウザ連携 — ライブページのデータを読む手段

お描き(=指示)に加えて、**実際に表示されているページ**を読む手段。優先順位つき。
非エンジニア最優先＝追加設定ゼロの `playwright-cli`。

## 優先順位

1. **playwright-cli** (既にインストール済み・ただの Bash・主経路)
2. **claude --chrome / /chrome** (ログイン必須ページ。ユーザーのログイン済み Chrome を使う。要 有料プラン)
3. **chrome-devtools-mcp / @playwright/mcp** (深いデバッグ / トークン効率)
4. **Codex computer-use** — 逃げ道のみ。後述の制約に注意

---

## 1. playwright-cli (主)

追加設定ゼロ。コードを編集するのと同じ Claude セッション内でページを読めるので受け渡しロスが無い。
`data-bag-id`(拡張の目印) も `data-agent-id`(@agent:マーカー) も `eval` で読める。

```bash
playwright-cli open "<url>"            # ブラウザを開いて遷移 (open https://… でも可)
playwright-cli goto "<url>"
playwright-cli snapshot                # アクセシビリティツリー (要素ref e1,e2…)。--boxes で座標も
playwright-cli screenshot --filename=before.png
playwright-cli eval "document.title"
playwright-cli eval "el => el.getAttribute('data-agent-id')" e7   # 特定要素の属性
playwright-cli console                 # console ログ
playwright-cli requests                # ネットワーク一覧
playwright-cli request 5               # 個別リクエストの中身
playwright-cli reload                  # 検証時に再読込
playwright-cli show --annotate         # ★ 画面に描いて指示する組み込みレビュー (お描きと類似)
playwright-cli close
```

> ⚠️ **playwright-cli は `file:` プロトコルをブロックする（実測: `Access to "file:" protocol is blocked`）。** お描きの url が `file://` のローカルHTMLなら、ブラウザでなく Read で読む。どうしてもライブDOM/eval したいときは `python3 -m http.server --directory <dir>` で配信して `http://localhost:<port>/…` を開く（この経路で eval が data-agent-id / data-bag-id を取得できることは実測済み）。

**お描き対象を画面で特定する一発 eval** (`--raw` で素の出力にして JSON を取り出す):
```bash
playwright-cli --raw eval "JSON.stringify([...document.querySelectorAll('[data-bag-id],[data-agent-id]')].map(e=>({tag:e.tagName,bag:e.getAttribute('data-bag-id'),agent:e.getAttribute('data-agent-id'),text:e.textContent.trim().slice(0,40)})))"
```

**ユーザーのログイン済み Chrome に繋ぐ** (使い捨てブラウザで入れないページ。**要セットアップ**):
```bash
# 事前に Chrome を --remote-debugging-port=9222 付きで起動しておく必要がある。
# --cdp は CDP(Chrome DevTools Protocol) エンドポイントの URL を取る ("chrome" のような文字列は不可):
playwright-cli attach --cdp=http://127.0.0.1:9222
playwright-cli attach --extension
```
> 非エンジニアには下の `claude --chrome` の方が簡単。attach はセットアップが要るので、迷ったらチームに相談。

---

## 2. claude --chrome / /chrome (ログイン必須ページの最良手)

MCP 設定不要でユーザーの**実際のサインイン済み Chrome** を操作 (DOM/console/network 読み取り、フォーム入力)。
- 必要: Claude Code >= 2.0.73 (ローカルは 2.1.179)、Claude in Chrome 拡張 >= 1.0.36、**有料プラン (Pro/Max/Team/Enterprise)**。
- 起動: `claude --chrome` か、セッション内で `/chrome`。ツールは `/mcp` で `claude-in-chrome` 配下に出る。
- ヘッドレス不可。日常的にログイン後ページを扱うなら、これを主にしてもよい。

---

## 3. chrome-devtools-mcp / @playwright/mcp (深掘り / 軽量)

```bash
# Google Chrome DevTools MCP — 45+ tools。network/console/perf/Lighthouse まで。
claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest
#   --autoConnect で起動中の Chrome 144+ に接続 / --browserUrl http://127.0.0.1:9222 / --isolated で一時プロファイル
#   主なツール: take_snapshot, take_screenshot, evaluate_script, list_network_requests, list_console_messages, lighthouse_audit

# Microsoft 公式 Playwright MCP — a11y スナップショット主体でトークン安い (~200-400/snapshot)
claude mcp add playwright npx @playwright/mcp@latest
#   browser_navigate / browser_snapshot / browser_evaluate / browser_network_requests / browser_console_messages …
```
`evaluate_script` / `browser_evaluate` で `data-bag-id` / `data-agent-id` を読める。
chrome-devtools-mcp はツールが多くコンテキスト消費も大きい点に注意。

---

## 4. Codex computer-use — 逃げ道のみ (重要な制約)

- **ライブページ読み取りを `codex:rescue` / `codex exec` に投げてはいけない**。これらは headless で、
  **ブラウザ / computer-use を持たない** (web 検索のみ)。
- Codex の本物の browser/computer-use は **Codex デスクトップアプリ**の `@chrome` / `@browser` / `@computer` のみ。
  OSレベル (ブラウザ外) の操作が要る稀ケースでだけ言及する。
- コード編集 (ブラウジングではない) を Codex に委譲したい時は `/codex:rescue --write "<task>"` が使えるが、
  スクショは自分で撮れないので **`-i/--image` で撮影済み画像 (shot.png) を渡す**こと。

---

## browser-use (非推奨・参考)

`uvx browser-use[cli] --mcp` で MCP 化できるが、uv/Python と抽出用 LLM キーが必要で**非エンジニアには重い**。
拡張自身の affordance システムと役割が重複するため、このスキルでは採用しない。

## フォールバック連鎖

playwright-cli が無い → `claude --chrome` → chrome-devtools-mcp / @playwright/mcp →
それも無ければ **静的検証のみ** (daemon の `raw.png`(before) + `annotation.json` でソース特定 → 編集 →
`npm run check` で検証、ライブ目視はスキップした旨を明記)。詳細 `fallbacks.md`。
