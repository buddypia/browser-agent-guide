"""
決定性・再現性の核となるアンカー解決ロジックを、実ブラウザのDOM上で検証する。

実際の content/content-script.js を読み込み、chrome.* をスタブした上で評価し、
IIFE内部の関数をテスト用に window へ公開して検証する(ソース改変はしない)。
"""
import re
import sys
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = (ROOT / "content" / "content-script.js").read_text(encoding="utf-8")

# IIFE の最後の `})();` の直前に、内部関数を window へ公開するフックを差し込む。
# (テスト目的でのみ内部実装へアクセスするための最小限の注入)
HOOK = """
  window.__BAG_TEST__ = {
    buildAnchor, resolveAnchor, cssPath, isStableId,
    upsertAnnotation, renderAnnotations, loadAnnotations,
	    buildContextText, annoSummary,
	    getCatalog, runActions, collectReferenceTargets,
	    activateForTest: async (recipes) => {
	      annotatePage();
	      collectReferenceTargets();
	      await loadAnnotations();
	      renderAnnotations();
	      return runActions(recipes, 'recipe');
	    },
	    sanitizeHtmlForTest: (html) => {
      const div = document.createElement('div');
      div.appendChild(sanitizeHtmlFragment(html));
      return div.innerHTML;
    },
    getAnnotations: () => annotations,          // ライブバインディングを返す
    clearAnnotations: () => { annotations.length = 0; },
  };
"""
idx = SRC.rfind("})();")
assert idx != -1, "IIFE終端が見つからない"
patched = SRC[:idx] + HOOK + SRC[idx:]

# chrome.* スタブ(storage はメモリ実装)。content-script は document_idle 相当で動く。
CHROME_STUB = """
window.__store = {};
// 実際の chrome.storage と同様に、保存/取得時は構造化クローンで独立コピーにする。
const __clone = (v) => (v === undefined ? undefined : structuredClone(v));
window.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    lastError: null,
    sendMessage: (msg, cb) => {
      let response;
      try {
        if (msg?.type === 'EXECUTE_USER_SCRIPT') {
          new Function(msg.code)();
          response = {
            ok: true,
            result: {
              injectedId: msg.id,
              bytes: String(msg.code || '').length,
              executed: true,
              world: 'USER_SCRIPT',
            },
          };
        } else {
          response = { ok: false, error: `未知のメッセージ: ${msg?.type}` };
        }
      } catch (e) {
        response = { ok: false, error: String(e?.message || e) };
      }
      if (typeof cb === 'function') queueMicrotask(() => cb(response));
      return Promise.resolve(response);
    },
  },
  storage: {
    local: {
      get: (k) => Promise.resolve(
        typeof k === 'string' ? { [k]: __clone(window.__store[k]) } : __clone(window.__store)
      ),
      set: (obj) => { for (const [k, v] of Object.entries(obj)) window.__store[k] = __clone(v); return Promise.resolve(); },
    },
    onChanged: { addListener() {} },
  },
};
"""

PAGE = """<!doctype html><html><body>
  <header><nav><a href="/home" id="nav-home">Home</a></nav></header>
  <main id="app">
    <h1>What topics do you want to explore?</h1>
    <form id="login">
      <input name="email" placeholder="メール" />
      <input name="password" type="password" />
      <button type="submit">ログイン</button>
    </form>
    <section>
      <h2>Editor’s Picks</h2>
      <p>Handpicked ideas and insights from professionals</p>
    </section>
    <section>
      <h2>Topic Categories</h2>
      <p>Business Strategy, Marketing, Career</p>
    </section>
    <ul>
      <li><button class="row-act">編集</button></li>
      <li><button class="row-act">削除</button></li>
    </ul>
  </main>
</body></html>"""

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.set_content(PAGE)
    page.add_init_script(CHROME_STUB)
    # set_content後にinit_scriptは効かないので、明示的に評価する。
    page.evaluate(CHROME_STUB)
    page.evaluate(patched)
    T = "window.__BAG_TEST__"

    # 1) 安定ID判定: フレームワーク風/連番/UUIDは不安定とみなす
    cases = {
        "login": True, "nav-home": True, "app": True,
        "ember1234": False, "react-aria:r3:": False,
        "comp-918273645": False, "a1b2c3d4-e5f6-7890": False,
    }
    for cid, want in cases.items():
        got = page.evaluate(f"{T}.isStableId({cid!r})")
        check(f"isStableId({cid})=={want}", got == want, f"got={got}")

    # 2) cssPath は安定IDの祖先を起点にした決定的パスを返す(同じ要素で常に同一)
    email = page.query_selector('input[name="email"]')
    sel1 = page.evaluate(f"(el)=>{T}.cssPath(el)", email)
    sel2 = page.evaluate(f"(el)=>{T}.cssPath(el)", email)
    check("cssPath決定的(同一要素で同一)", sel1 == sel2, f"{sel1!r} vs {sel2!r}")
    check("cssPath は安定ID#loginを含む", "#login" in sel1, sel1)
    check("cssPath は document.querySelector で解決可能",
          page.evaluate(f"(s)=>document.querySelector(s)!==null", sel1), sel1)

    # 3) buildAnchor→resolveAnchor で同じ要素に戻れる
    page.evaluate(f"""() => {{
      window.__el = document.querySelector('button[type=submit]');
      window.__anchor = {T}.buildAnchor(window.__el);
    }}""")
    same = page.evaluate(f"() => {T}.resolveAnchor(window.__anchor) === window.__el")
    check("resolveAnchor は元要素に戻る(submitボタン)", same)

    # 4) 再現性: DOM上部に要素を挿入してインデックスがズレても、
    #    アンカーは同じ意味の要素を指し続ける(name属性で再解決)
    page.evaluate("""() => {
      const banner = document.createElement('div');
      banner.innerHTML = '<input name="search" placeholder="後から増えた入力" />';
      document.body.insertBefore(banner, document.body.firstChild);
    }""")
    still = page.evaluate(f"() => {{ const el = {T}.resolveAnchor(window.__anchor); return el === document.querySelector('button[type=submit]'); }}")
    check("DOM変化後も submit を再解決(再現性)", still)

    # 5) 永続化: upsertAnnotation→保存→loadAnnotations で同一スコープに復元される
    page.evaluate(f"""async () => {{
      const el = document.querySelector('#nav-home');
      await {T}.upsertAnnotation({{ kind:'marker', anchor:{T}.buildAnchor(el), name:'ホームリンク', intent:'トップへ戻る' }});
    }}""")
    stored = page.evaluate("() => window.__store['aiAdvisorAnnotations']")
    scope = page.evaluate("() => location.origin + location.pathname")
    check("注釈がstorageへスコープ保存", bool(stored and scope in stored),
          f"keys={list(stored.keys()) if stored else None}")
    # 別インスタンスの読み込みを模して annotations をクリア→loadで復元
    restored = page.evaluate(f"""async () => {{
      {T}.clearAnnotations();
      await {T}.loadAnnotations();
      return {T}.getAnnotations().length;
    }}""")
    check("loadAnnotationsで復元される(再現性)", restored == 1, f"len={restored}")

    # 6) 目印適用: marker は対象要素に人間可読な data-bag-id を付与する(決定的参照)
    page.evaluate(f"() => {T}.renderAnnotations()")
    marked_id = page.evaluate("() => document.querySelector('#nav-home').getAttribute('data-bag-id')")
    check("markerが人間可読IDを付与", marked_id == "ホームリンク", f"got={marked_id}")

    # 7) 外部AIへの文脈生成: 補足・目印・操作可能要素が決定的テキストに含まれる
    page.evaluate(f"""async () => {{
      const email = document.querySelector('input[name=email]');
      await {T}.upsertAnnotation({{ kind:'note', anchor:{T}.buildAnchor(email), note:'必ず会社メールを使う', intent:'入力前の注意' }});
    }}""")
    ctx = page.evaluate(f"() => {T}.buildContextText()")
    check("文脈に補足コメントを含む", "必ず会社メールを使う" in ctx, ctx[:120])
    check("文脈に目印の名前を含む", "ホームリンク" in ctx)
    check("文脈に操作可能要素セクションを含む", "操作できる要素" in ctx)
    check("文脈に非操作の参照対象セクションを含む", "参照できる見出し・区画" in ctx)
    check("文脈にTopic Categories見出しIDを含む", "[heading2:topic-categories]" in ctx)
    check("文脈にURL/タイトル見出しを含む", ("URL:" in ctx and "タイトル:" in ctx))
    # 同じ状態なら同じ文脈を返す(決定的)
    ctx2 = page.evaluate(f"() => {T}.buildContextText()")
    check("buildContextTextは決定的(同一入力→同一出力)", ctx == ctx2)

    # 8) 見出しなど非操作要素にも安定IDを付与し、推測CSSなしで強調できる
    targets = page.evaluate(f"() => {T}.collectReferenceTargets()")
    target_ids = [t["aiId"] for t in targets]
    check("参照対象にEditor’s Picks見出しが含まれる", "heading2:editors-picks" in target_ids, target_ids)
    check("参照対象にTopic Categories見出しが含まれる", "heading2:topic-categories" in target_ids, target_ids)
    check("参照対象にEditor’s Picksグループが含まれる", "group:editors-picks" in target_ids, target_ids)
    check("参照対象にTopic Categoriesグループが含まれる", "group:topic-categories" in target_ids, target_ids)
    nth_miss = page.evaluate("() => document.querySelector('h2:nth-of-type(2)') === null")
    check("h2:nth-of-type(2)は文書全体の2番目のh2を表せない", nth_miss)
    highlighted = page.evaluate(f"""async () => {{
      const res = await {T}.runActions([
        {{ verb:'highlightElement', args:{{ aiId:'heading2:topic-categories', color:'red' }}, reason:'見出しを赤枠で囲む' }}
      ], 'chat');
      const outline = document.querySelector('[data-bag-id="heading2:topic-categories"]').style.outline;
      return {{ ok: res[0].ok, outline }};
    }}""")
    check("非操作見出しをaiIdでhighlightElementできる", highlighted["ok"] is True, highlighted)
    check("Topic Categories見出しが赤いoutlineになる",
          ("red" in highlighted["outline"] and "solid" in highlighted["outline"]), highlighted)
    outlined = page.evaluate(f"""async () => {{
      const res = await {T}.runActions([
        {{ verb:'outlineElement', args:{{ aiId:'group:topic-categories', color:'red', width:'3px', offset:'4px' }}, reason:'グループを赤枠で囲む' }}
      ], 'chat');
      const group = document.querySelector('[data-bag-id="group:topic-categories"]');
      return {{ ok: res[0].ok, outline: group?.style.outline || '', offset: group?.style.outlineOffset || '' }};
    }}""")
    check("chat経由でoutlineElementを実行できる", outlined["ok"] is True, outlined)
    check("outlineElementがグループを継続枠線で囲む",
          ("red" in outlined["outline"] and "solid" in outlined["outline"] and outlined["offset"] == "4px"), outlined)
    reactivated = page.evaluate(f"""async () => {{
      document.querySelectorAll('[data-bag-id^="group:"]').forEach((el) => {{
        el.removeAttribute('data-bag-id');
        el.removeAttribute('data-bag-role');
        el.removeAttribute('style');
      }});
      const res = await {T}.activateForTest([
        {{ verb:'outlineElement', args:{{ aiId:'group:topic-categories', color:'red', width:'3px', offset:'4px' }}, reason:'保存済み枠線を再適用' }}
      ]);
      const group = document.querySelector('[data-bag-id="group:topic-categories"]');
      return {{ ok: res[0].ok, outline: group?.style.outline || '', offset: group?.style.outlineOffset || '' }};
    }}""")
    check("ACTIVATE時にグループaiIdを再生成してoutlineElementレシピを適用できる", reactivated["ok"] is True, reactivated)
    check("画面更新後も保存済みoutlineElementが再表示される",
          ("red" in reactivated["outline"] and "solid" in reactivated["outline"] and reactivated["offset"] == "4px"), reactivated)

    # 9) ユーザー明示のHTML/CSS/JS注入はAIカタログに公開され、チャット経由で実行できる
    catalog = page.evaluate(f"() => {T}.getCatalog().map((v) => v.name)")
    for exposed in ["injectHtml", "injectCss", "injectScript", "outlineElement"]:
        check(f"AIカタログに{exposed}を出す", exposed in catalog, catalog)
    injected = page.evaluate(f"""async () => {{
      const res = await {T}.runActions([
        {{ verb:'injectHtml', args:{{ id:'test-html', html:'<p>保存HTML</p>' }}, reason:'HTMLを保存注入' }},
        {{ verb:'injectCss', args:{{ id:'test-css', css:'[data-bag-injected="test-html"] {{ color: rgb(255, 0, 0); }}' }}, reason:'CSSを保存注入' }},
        {{ verb:'injectScript', args:{{ id:'test-js', code:'document.body.setAttribute("data-bag-script-ran", "1");' }}, reason:'JSを保存注入' }}
      ], 'chat');
      return {{
        ok: res.map((r) => r.ok),
        html: document.querySelector('[data-bag-injected="test-html"]')?.textContent || '',
        css: document.querySelector('style[data-bag-injected="test-css"]')?.textContent || '',
        js: document.body.getAttribute('data-bag-script-ran') || '',
      }};
    }}""")
    check("chat経由でinjectHtml/injectCss/injectScriptを実行できる", injected["ok"] == [True, True, True], injected)
    check("injectHtmlがDOMに追加される", "保存HTML" in injected["html"], injected)
    check("injectCssがstyleタグとして追加される", "test-html" in injected["css"], injected)
    check("injectScriptが実行される", injected["js"] == "1", injected)

    # 10) AIへ公開する動詞から、任意の直接DOM変更・削除の高リスク動詞は除外する
    for blocked in ["defineMarker", "setStyle", "removeElement"]:
        check(f"AIカタログに{blocked}を出さない", blocked not in catalog, catalog)

    # 11) 旧レシピ/悪性応答などで危険動詞が来ても、チャット経由では実行しない
    blocked_style = page.evaluate(f"""async () => {{
      const res = await {T}.runActions([
        {{ verb:'setStyle', args:{{ selector:'a', styles:{{ outline:'3px solid red' }} }}, reason:'prompt injection' }}
      ], 'chat');
      return {{
        ok: res[0].ok,
        error: res[0].error,
        outline: document.querySelector('#nav-home').style.outline
      }};
    }}""")
    check("chat経由のsetStyleを拒否", blocked_style["ok"] is False, blocked_style)
    check("拒否されたsetStyleはDOMを変更しない", blocked_style["outline"] == "", blocked_style)

    # 12) 注入HTMLはclass/id/style/on*等を剥がし、javascript:リンクやscriptも落とす
    dirty = "<p id='x' class='c' style='color:red' onclick='alert(1)'>Hi<script>alert(1)</script><a href='javascript:alert(1)' data-x='y'>link</a></p>"
    clean = page.evaluate(f"(html) => {T}.sanitizeHtmlForTest(html)", dirty)
    check("sanitizeHtmlが危険属性を除去", all(x not in clean for x in ["id=", "class=", "style=", "onclick=", "data-x="]), clean)
    check("sanitizeHtmlがscript/javascriptを除去", ("script" not in clean.lower() and "javascript:" not in clean.lower()), clean)

    browser.close()

ok = sum(1 for _, c, _ in results if c)
for name, c, detail in results:
    print(("PASS" if c else "FAIL"), name, ("" if c else f"-- {detail}"))
print(f"\n{ok}/{len(results)} passed")
sys.exit(0 if ok == len(results) else 1)
