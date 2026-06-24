// Deterministic anchor tests executed through playwright-cli.
// This intentionally avoids the Python `playwright` module; npm test shells out to
// `playwright-cli run-code`, which owns the browser session.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = join(root, '.tmp');
mkdirSync(tmpDir, { recursive: true });

const contentScript = readFileSync(join(root, 'content/content-script.js'), 'utf8');
const jaLocaleJson = readFileSync(join(root, 'sidepanel/locales/ja.json'), 'utf8');

const hook = `
  window.__BAG_TEST__ = {
    buildAnchor, resolveAnchor, cssPath, isStableId,
    upsertAnnotation, renderAnnotations, loadAnnotations,
    buildContextText, annoSummary,
    getCatalog, runActions, collectReferenceTargets,
    rectCoversShape, isDrawingFractionBroken, hasDurableAnchorSignal,
    pickAnchorElement, pickDurableAnchorElement,
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
    getAnnotations: () => annotations,
    clearAnnotations: () => { annotations.length = 0; },
    getOutlineBoxes: () => outlineBoxes,
  };
`;

const iifeEnd = contentScript.lastIndexOf('})();');
if (iifeEnd === -1) throw new Error('content/content-script.js の IIFE 終端が見つかりません');
const patchedContentScript = contentScript.slice(0, iifeEnd) + hook + contentScript.slice(iifeEnd);

const pageHtml = `<!doctype html><html><body>
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
</body></html>`;

const runnerSource = `async page => {
  const contentScript = ${JSON.stringify(patchedContentScript)};
  const pageHtml = ${JSON.stringify(pageHtml)};
  const jaLocale = ${jaLocaleJson};
  const chromeStub = ${JSON.stringify(`
    window.__store = {};
    window.__bagI18n = __JA_LOCALE__;
    const __clone = (v) => (v === undefined ? undefined : structuredClone(v));
    window.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        get lastError() { return null; },
        sendMessage: (msg, cb) => {
          let response;
          try {
            if (msg && msg.type === 'GET_I18N') {
              response = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
            } else if (msg && msg.type === 'EXECUTE_USER_SCRIPT') {
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
              response = { ok: false, error: '未知のメッセージ: ' + (msg && msg.type) };
            }
          } catch (e) {
            response = { ok: false, error: String((e && e.message) || e) };
          }
          if (typeof cb === 'function') queueMicrotask(() => cb(response));
          return Promise.resolve(response);
        },
      },
      storage: {
        local: {
          get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: __clone(window.__store[k]) } : __clone(window.__store)),
          set: (obj) => { for (const [key, val] of Object.entries(obj)) window.__store[key] = __clone(val); return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
    };
  `)}.replace('__JA_LOCALE__', JSON.stringify(jaLocale));

  const results = [];
  const check = (name, cond, detail = '') => results.push({ name, pass: Boolean(cond), detail: cond ? '' : String(detail) });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(pageHtml);
  await page.addScriptTag({ content: chromeStub });
  await page.addScriptTag({ content: contentScript });

  const cases = {
    login: true,
    'nav-home': true,
    app: true,
    ember1234: false,
    'react-aria:r3:': false,
    'comp-918273645': false,
    'a1b2c3d4-e5f6-7890': false,
  };
  for (const [cid, want] of Object.entries(cases)) {
    const got = await page.evaluate((id) => window.__BAG_TEST__.isStableId(id), cid);
    check('isStableId(' + cid + ')==' + want, got === want, 'got=' + got);
  }

  const email = await page.$('input[name="email"]');
  const sel1 = await page.evaluate((el) => window.__BAG_TEST__.cssPath(el), email);
  const sel2 = await page.evaluate((el) => window.__BAG_TEST__.cssPath(el), email);
  check('cssPath決定的(同一要素で同一)', sel1 === sel2, JSON.stringify([sel1, sel2]));
  check('cssPath は安定ID#loginを含む', sel1.includes('#login'), sel1);
  check('cssPath は document.querySelector で解決可能', await page.evaluate((s) => document.querySelector(s) !== null, sel1), sel1);

  await page.evaluate(() => {
    window.__el = document.querySelector('button[type=submit]');
    window.__anchor = window.__BAG_TEST__.buildAnchor(window.__el);
  });
  check(
    'resolveAnchor は元要素に戻る(submitボタン)',
    await page.evaluate(() => window.__BAG_TEST__.resolveAnchor(window.__anchor) === window.__el)
  );

  await page.evaluate(() => {
    const banner = document.createElement('div');
    banner.innerHTML = '<input name="search" placeholder="後から増えた入力" />';
    document.body.insertBefore(banner, document.body.firstChild);
  });
  check(
    'DOM変化後も submit を再解決(再現性)',
    await page.evaluate(() => window.__BAG_TEST__.resolveAnchor(window.__anchor) === document.querySelector('button[type=submit]'))
  );

  await page.evaluate(async () => {
    const el = document.querySelector('#nav-home');
    await window.__BAG_TEST__.upsertAnnotation({
      kind: 'marker',
      anchor: window.__BAG_TEST__.buildAnchor(el),
      name: 'ホームリンク',
      intent: 'トップへ戻る',
    });
  });
  const storedInfo = await page.evaluate(() => {
    const stored = window.__store.aiAdvisorAnnotations;
    const scope = location.origin + location.pathname;
    return { hasScope: Boolean(stored && stored[scope]), keys: stored ? Object.keys(stored) : [] };
  });
  check('注釈がstorageへスコープ保存', storedInfo.hasScope, JSON.stringify(storedInfo.keys));
  const restored = await page.evaluate(async () => {
    window.__BAG_TEST__.clearAnnotations();
    await window.__BAG_TEST__.loadAnnotations();
    return window.__BAG_TEST__.getAnnotations().length;
  });
  check('loadAnnotationsで復元される(再現性)', restored === 1, 'len=' + restored);

  await page.evaluate(() => window.__BAG_TEST__.renderAnnotations());
  const markedId = await page.evaluate(() => document.querySelector('#nav-home').getAttribute('data-bag-id'));
  check('markerが人間可読IDを付与', markedId === 'ホームリンク', 'got=' + markedId);

  await page.evaluate(async () => {
    const emailEl = document.querySelector('input[name=email]');
    await window.__BAG_TEST__.upsertAnnotation({
      kind: 'note',
      anchor: window.__BAG_TEST__.buildAnchor(emailEl),
      note: '必ず会社メールを使う',
      intent: '入力前の注意',
    });
  });
  const ctx = await page.evaluate(() => window.__BAG_TEST__.buildContextText());
  check('文脈に補足コメントを含む', ctx.includes('必ず会社メールを使う'), ctx.slice(0, 120));
  check('文脈に目印の名前を含む', ctx.includes('ホームリンク'));
  check('文脈に操作可能要素セクションを含む', ctx.includes('操作できる要素'));
  check('文脈に非操作の参照対象セクションを含む', ctx.includes('参照できる見出し・区画'));
  check('文脈にTopic Categories見出しIDを含む', ctx.includes('[heading2:topic-categories]'));
  check('文脈にURL/タイトル見出しを含む', ctx.includes('URL:') && ctx.includes('タイトル:'));
  check('buildContextTextは決定的(同一入力→同一出力)', ctx === (await page.evaluate(() => window.__BAG_TEST__.buildContextText())));

  const targets = await page.evaluate(() => window.__BAG_TEST__.collectReferenceTargets());
  const targetIds = targets.map((t) => t.aiId);
  check('参照対象にEditor’s Picks見出しが含まれる', targetIds.includes('heading2:editors-picks'), JSON.stringify(targetIds));
  check('参照対象にTopic Categories見出しが含まれる', targetIds.includes('heading2:topic-categories'), JSON.stringify(targetIds));
  check('参照対象にEditor’s Picksグループが含まれる', targetIds.includes('group:editors-picks'), JSON.stringify(targetIds));
  check('参照対象にTopic Categoriesグループが含まれる', targetIds.includes('group:topic-categories'), JSON.stringify(targetIds));
  check('h2:nth-of-type(2)は文書全体の2番目のh2を表せない', await page.evaluate(() => document.querySelector('h2:nth-of-type(2)') === null));
  const highlighted = await page.evaluate(async () => {
    const res = await window.__BAG_TEST__.runActions([
      { verb: 'highlightElement', args: { aiId: 'heading2:topic-categories', color: 'red' }, reason: '見出しを赤枠で囲む' },
    ], 'chat');
    const outline = document.querySelector('[data-bag-id="heading2:topic-categories"]').style.outline;
    return { ok: res[0].ok, outline };
  });
  check('非操作見出しをaiIdでhighlightElementできる', highlighted.ok === true, JSON.stringify(highlighted));
  check('Topic Categories見出しが赤いoutlineになる', highlighted.outline.includes('red') && highlighted.outline.includes('solid'), JSON.stringify(highlighted));
  const outlined = await page.evaluate(async () => {
    const res = await window.__BAG_TEST__.runActions([
      { verb: 'outlineElement', args: { aiId: 'group:topic-categories', color: 'red', width: '3px', offset: '4px' }, reason: 'グループを赤枠で囲む' },
    ], 'chat');
    const group = document.querySelector('[data-bag-id="group:topic-categories"]');
    return { ok: res[0].ok, outline: (group && group.style.outline) || '', offset: (group && group.style.outlineOffset) || '' };
  });
  check('chat経由でoutlineElementを実行できる', outlined.ok === true, JSON.stringify(outlined));
  check('outlineElementがグループを継続枠線で囲む', outlined.outline.includes('red') && outlined.outline.includes('solid') && outlined.offset === '4px', JSON.stringify(outlined));
  const reactivated = await page.evaluate(async () => {
    document.querySelectorAll('[data-bag-id^="group:"]').forEach((el) => {
      el.removeAttribute('data-bag-id');
      el.removeAttribute('data-bag-role');
      el.removeAttribute('style');
    });
    const res = await window.__BAG_TEST__.activateForTest([
      { verb: 'outlineElement', args: { aiId: 'group:topic-categories', color: 'red', width: '3px', offset: '4px' }, reason: '保存済み枠線を再適用' },
    ]);
    const group = document.querySelector('[data-bag-id="group:topic-categories"]');
    return { ok: res[0].ok, outline: (group && group.style.outline) || '', offset: (group && group.style.outlineOffset) || '' };
  });
  check('ACTIVATE時にグループaiIdを再生成してoutlineElementレシピを適用できる', reactivated.ok === true, JSON.stringify(reactivated));
  check('画面更新後も保存済みoutlineElementが再表示される', reactivated.outline.includes('red') && reactivated.outline.includes('solid') && reactivated.offset === '4px', JSON.stringify(reactivated));

  const catalog = await page.evaluate(() => window.__BAG_TEST__.getCatalog().map((v) => v.name));
  for (const exposed of ['injectHtml', 'injectCss', 'injectScript', 'outlineElement']) {
    check('AIカタログに' + exposed + 'を出す', catalog.includes(exposed), JSON.stringify(catalog));
  }
  const injected = await page.evaluate(async () => {
    const res = await window.__BAG_TEST__.runActions([
      { verb: 'injectHtml', args: { id: 'test-html', html: '<p>保存HTML</p>' }, reason: 'HTMLを保存注入' },
      { verb: 'injectCss', args: { id: 'test-css', css: '[data-bag-injected="test-html"] { color: rgb(255, 0, 0); }' }, reason: 'CSSを保存注入' },
      { verb: 'injectScript', args: { id: 'test-js', code: 'document.body.setAttribute("data-bag-script-ran", "1");' }, reason: 'JSを保存注入' },
    ], 'chat');
    return {
      ok: res.map((r) => r.ok),
      html: (document.querySelector('[data-bag-injected="test-html"]') && document.querySelector('[data-bag-injected="test-html"]').textContent) || '',
      css: (document.querySelector('style[data-bag-injected="test-css"]') && document.querySelector('style[data-bag-injected="test-css"]').textContent) || '',
      js: document.body.getAttribute('data-bag-script-ran') || '',
    };
  });
  check('chat経由でinjectHtml/injectCss/injectScriptを実行できる', JSON.stringify(injected.ok) === JSON.stringify([true, true, true]), JSON.stringify(injected));
  check('injectHtmlがDOMに追加される', injected.html.includes('保存HTML'), JSON.stringify(injected));
  check('injectCssがstyleタグとして追加される', injected.css.includes('test-html'), JSON.stringify(injected));
  check('injectScriptが実行される', injected.js === '1', JSON.stringify(injected));

  for (const blocked of ['defineMarker', 'setStyle', 'removeElement']) {
    check('AIカタログに' + blocked + 'を出さない', !catalog.includes(blocked), JSON.stringify(catalog));
  }

  const blockedStyle = await page.evaluate(async () => {
    const res = await window.__BAG_TEST__.runActions([
      { verb: 'setStyle', args: { selector: 'a', styles: { outline: '3px solid red' } }, reason: 'prompt injection' },
    ], 'chat');
    return { ok: res[0].ok, error: res[0].error, outline: document.querySelector('#nav-home').style.outline };
  });
  check('chat経由のsetStyleを拒否', blockedStyle.ok === false, JSON.stringify(blockedStyle));
  check('拒否されたsetStyleはDOMを変更しない', blockedStyle.outline === '', JSON.stringify(blockedStyle));

  const dirty = "<p id='x' class='c' style='color:red' onclick='alert(1)'>Hi<script>alert(1)</script><a href='javascript:alert(1)' data-x='y'>link</a></p>";
  const clean = await page.evaluate((html) => window.__BAG_TEST__.sanitizeHtmlForTest(html), dirty);
  check('sanitizeHtmlが危険属性を除去', ['id=', 'class=', 'style=', 'onclick=', 'data-x='].every((x) => !clean.includes(x)), clean);
  check('sanitizeHtmlがscript/javascriptを除去', !clean.toLowerCase().includes('script') && !clean.toLowerCase().includes('javascript:'), clean);

  // --- お描きアンカー: 描画時の誤アンカー回帰(検証シグナルダッシュボード事例) ---
  // rectCoversShape を純粋関数として直接検証(座標非依存・決定的)。
  const coversBig = await page.evaluate(() =>
    window.__BAG_TEST__.rectCoversShape(
      { left: 200, top: 200, right: 700, bottom: 600, width: 500, height: 400 },
      { minX: 180, minY: 180, maxX: 720, maxY: 620 }
    )
  );
  check('rectCoversShape: 少し大きめに囲んだコンテナを同一対象と認める', coversBig === true, 'got=' + coversBig);
  const coversThinRow = await page.evaluate(() =>
    window.__BAG_TEST__.rectCoversShape(
      { left: 210, top: 380, right: 690, bottom: 420, width: 480, height: 40 },
      { minX: 180, minY: 180, maxX: 720, maxY: 620 }
    )
  );
  check('rectCoversShape: box内の細い小行(面積比~0.08)は同一対象と認めない', coversThinRow === false, 'got=' + coversThinRow);
  const coversOffCenter = await page.evaluate(() =>
    window.__BAG_TEST__.rectCoversShape(
      { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
      { minX: 180, minY: 180, maxX: 720, maxY: 620 }
    )
  );
  check('rectCoversShape: box中心を含まない隣接要素は弾く', coversOffCenter === false, 'got=' + coversOffCenter);

  // 壊れた保存比率(C: 暴発描画の抑止)の検出。
  const brokenFrac = await page.evaluate(() =>
    window.__BAG_TEST__.isDrawingFractionBroken([{ type: 'rect', x: -0.0785, y: -3.6928, w: 1.1619, h: 9.0557 }])
  );
  check('isDrawingFractionBroken: 本件の壊れ比率(y=-3.69,h=9.05)を検出', brokenFrac === true, 'got=' + brokenFrac);
  const normalFrac = await page.evaluate(() =>
    window.__BAG_TEST__.isDrawingFractionBroken([{ type: 'rect', x: 0.05, y: 0.05, w: 0.9, h: 0.9 }])
  );
  check('isDrawingFractionBroken: 正常比率(0..1)は壊れ扱いしない', normalFrac === false, 'got=' + normalFrac);
  const slightlyOutFrac = await page.evaluate(() =>
    window.__BAG_TEST__.isDrawingFractionBroken([{ type: 'rect', x: -0.15, y: -0.15, w: 1.3, h: 1.3 }])
  );
  check('isDrawingFractionBroken: 少し外側に囲んだ比率は壊れ扱いしない', slightlyOutFrac === false, 'got=' + slightlyOutFrac);

  // pickDurableAnchorElement 統合: 大コンテナを少し大きめに囲んでも、中心直下の小子要素でなく
  // コンテナにアンカーする(仮説Aの E2E 回帰)。durable シグナルを避けるため id は連番風にする。
  // 注: position:absolute の子は positioned 親(boardZone7777/wrapZone7777)基準で配置されるため、
  // 子の left/top は親内オフセットで指定する(metricRow8888 の絶対座標は 210,280 / btnInner7777 は 300,560)。
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'draw-fixture';
    host.innerHTML =
      '<div id="boardZone7777" style="position:absolute; left:200px; top:100px; width:500px; height:400px; background:#eee;">' +
      '<div id="metricRow8888" style="position:absolute; left:10px; top:180px; width:480px; height:40px;">토론 밀도 0%</div>' +
      '</div>' +
      '<div id="wrapZone7777" style="position:absolute; left:200px; top:540px; width:400px; height:160px;">' +
      '<button id="btnInner7777" style="position:absolute; left:100px; top:20px; width:120px; height:40px;">click</button>' +
      '</div>';
    document.body.appendChild(host);
  });
  const rectSanity = await page.evaluate(() => {
    const r = document.querySelector('#boardZone7777').getBoundingClientRect();
    const m = document.querySelector('#metricRow8888').getBoundingClientRect();
    return {
      board: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      rowAbs: { left: Math.round(m.left), top: Math.round(m.top), width: Math.round(m.width), height: Math.round(m.height) },
    };
  });
  check(
    'お描きfixture: #boardZone7777 の rect が想定どおり(座標テスト前提)',
    rectSanity.board.left === 200 && rectSanity.board.top === 100 && rectSanity.board.width === 500 && rectSanity.board.height === 400,
    JSON.stringify(rectSanity)
  );
  check(
    'お描きfixture: #metricRow8888 の絶対rectが box中心(450,300)を含む',
    rectSanity.rowAbs.left === 210 && rectSanity.rowAbs.top === 280 && rectSanity.rowAbs.width === 480 && rectSanity.rowAbs.height === 40,
    JSON.stringify(rectSanity)
  );
  const durableSanity = await page.evaluate(() => ({
    board: window.__BAG_TEST__.hasDurableAnchorSignal(document.querySelector('#boardZone7777')),
    row: window.__BAG_TEST__.hasDurableAnchorSignal(document.querySelector('#metricRow8888')),
  }));
  check(
    'お描きfixture: コンテナ/小行とも安定シグナル無し(緩和判定のテスト前提)',
    durableSanity.board === false && durableSanity.row === false,
    JSON.stringify(durableSanity)
  );
  const bigCircle = await page.evaluate(() => {
    const box = { minX: 180, minY: 80, maxX: 720, maxY: 520, cx: 450, cy: 300 };
    const start = window.__BAG_TEST__.pickAnchorElement(box.cx, box.cy);
    const target = window.__BAG_TEST__.pickDurableAnchorElement(start, box);
    return { startId: start && start.id, targetId: target && target.id };
  });
  check('お描き: 中心直下の起点は小行になる(誤アンカーの起点)', bigCircle.startId === 'metricRow8888', JSON.stringify(bigCircle));
  check('お描き: 少し大きめに囲んでもコンテナにアンカーする(小子要素に落ちない)', bigCircle.targetId === 'boardZone7777', JSON.stringify(bigCircle));
  const tightCircle = await page.evaluate(() => {
    const box = { minX: 295, minY: 555, maxX: 425, maxY: 605, cx: 360, cy: 580 };
    const start = window.__BAG_TEST__.pickAnchorElement(box.cx, box.cy);
    const target = window.__BAG_TEST__.pickDurableAnchorElement(start, box);
    return { startId: start && start.id, targetId: target && target.id };
  });
  check('お描き: 要素をぴったり囲んだら要素自身に留まる(親へ昇格しない)', tightCircle.targetId === 'btnInner7777', JSON.stringify(tightCircle));

  // C 統合: 旧仕様で壊れた比率(極端 shapesFrac)の drawing は、解決できても暴発描画しない。
  const suppressedRects = await page.evaluate(async () => {
    window.__BAG_TEST__.clearAnnotations();
    const board = document.querySelector('#boardZone7777'); // 安定シグナル無しの要素
    await window.__BAG_TEST__.upsertAnnotation({
      kind: 'drawing',
      anchor: window.__BAG_TEST__.buildAnchor(board),
      shapes: [{ type: 'rect', x: -0.0785, y: -3.6928, w: 1.1619, h: 9.0557, color: '#ef4444', width: 3 }],
      note: '壊れた比率の旧注釈',
    });
    window.__BAG_TEST__.renderAnnotations();
    return document.querySelectorAll('.bag-draw-layer rect').length;
  });
  check('C: 壊れた比率の古い注釈は暴発描画されない(図形が出ない)', suppressedRects === 0, 'rects=' + suppressedRects);
  const normalRects = await page.evaluate(async () => {
    window.__BAG_TEST__.clearAnnotations();
    const board = document.querySelector('#boardZone7777');
    await window.__BAG_TEST__.upsertAnnotation({
      kind: 'drawing',
      anchor: window.__BAG_TEST__.buildAnchor(board),
      shapes: [{ type: 'rect', x: 0.05, y: 0.05, w: 0.9, h: 0.9, color: '#ef4444', width: 3 }],
      note: '正常な比率の注釈',
    });
    window.__BAG_TEST__.renderAnnotations();
    return document.querySelectorAll('.bag-draw-layer rect').length;
  });
  check('C: 正常な比率の注釈は従来どおり描画される(抑止は壊れたものだけ)', normalRects === 1, 'rects=' + normalRects);
  await page.evaluate(() => {
    window.__BAG_TEST__.clearAnnotations();
    document.querySelector('#draw-fixture')?.remove();
  });

  // --- 解決時の誤バインド回帰(nichenext.com/ko 事例: 選択要素と違う要素に赤枠が出る) ---
  // 近傍由来の非一意シグナル(同一hrefの繰り返しリンク / 祖先testid / 共有aria-label)が
  // 別要素を掴むのを resolveAnchor が防ぎ、クリックした“その”要素へ戻ることを検証する。
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'misbind-fixture';
    host.innerHTML =
      // FM1: サムネ用<a>と見出し<a>が同一URLを指す記事カード。クリックは見出しリンク。
      '<div id="feedZone">' +
      '  <article>' +
      '    <a href="/ko/post/aaa" class="thumb" aria-label="썸네일"><span>img</span></a>' +
      '    <h3><a href="/ko/post/aaa" class="title">첫번째 글 제목</a></h3>' +
      '  </article>' +
      '</div>' +
      // FM3: 祖先<li>が共有 data-testid を持つカード列。クリックは2枚目の見出しテキスト。
      '<ul id="cardList">' +
      '  <li data-testid="post-card"><a href="/ko/x"><span class="ttl">카드 가</span></a></li>' +
      '  <li data-testid="post-card"><a href="/ko/y"><span class="ttl">카드 나</span></a></li>' +
      '</ul>' +
      // FM2: アイコンボタンが aria-label を共有(テキストで識別)。クリックは2つ目。
      '<div id="iconBar">' +
      '  <button aria-label="더보기" class="more">가옵션</button>' +
      '  <button aria-label="더보기" class="more">나옵션</button>' +
      '</div>';
    document.body.appendChild(host);
  });

  const fm1 = await page.evaluate(() => {
    const titleLink = document.querySelector('#feedZone a.title');
    const resolved = window.__BAG_TEST__.resolveAnchor(window.__BAG_TEST__.buildAnchor(titleLink));
    return { ok: resolved === titleLink, resolvedClass: resolved && resolved.className };
  });
  check('解決: 同一href繰り返しリンクで見出しリンク自身に戻る(サムネに落ちない)', fm1.ok, JSON.stringify(fm1));

  const fm3 = await page.evaluate(() => {
    const ttlB = document.querySelectorAll('#cardList .ttl')[1];
    const resolved = window.__BAG_TEST__.resolveAnchor(window.__BAG_TEST__.buildAnchor(ttlB));
    return { ok: resolved === ttlB, resolvedText: resolved && (resolved.textContent || '').trim() };
  });
  check('解決: 祖先共有testidの子テキストで子要素自身に戻る(先頭カードに落ちない)', fm3.ok, JSON.stringify(fm3));

  const fm2 = await page.evaluate(() => {
    const btnB = document.querySelectorAll('#iconBar .more')[1];
    const resolved = window.__BAG_TEST__.resolveAnchor(window.__BAG_TEST__.buildAnchor(btnB));
    return { ok: resolved === btnB, resolvedText: resolved && (resolved.textContent || '').trim() };
  });
  check('解決: 共有aria-labelでも選んだボタン自身に戻る(先頭ボタンに落ちない)', fm2.ok, JSON.stringify(fm2));

  // end-to-end: メモ(note)の赤枠オーバーレイが“選んだ”要素にだけ束縛されることを確認。
  // 枠は CSS outline ではなく独立した .bag-anno-outline-box で、レジストリ(outlineBoxes)の
  // target が対象要素を指す。「枠が1つだけ・target が選んだ見出しリンク」で別リンクへの暴発を検出する
  // (このランナーは content.css を読まないため、ピクセル幾何ではなく束縛先を直接検証する)。
  const outlineOnRight = await page.evaluate(async () => {
    window.__BAG_TEST__.clearAnnotations();
    const titleLink = document.querySelector('#feedZone a.title');
    await window.__BAG_TEST__.upsertAnnotation({
      kind: 'note',
      anchor: window.__BAG_TEST__.buildAnchor(titleLink),
      note: 'ここの文言を直す',
      outline: true,
    });
    window.__BAG_TEST__.renderAnnotations();
    const boxes = window.__BAG_TEST__.getOutlineBoxes();
    const onTitle = boxes.length === 1 && boxes[0].target === titleLink && boxes[0].kind === 'note';
    return { onTitle, boxCount: boxes.length, targetIsTitle: boxes.length === 1 && boxes[0].target === titleLink };
  });
  check('メモ赤枠: 選んだ見出しリンクだけが囲まれる(別リンクに暴発しない)', outlineOnRight.onTitle, JSON.stringify(outlineOnRight));

  // メモは「手順N」としてAI文脈に番号付きで出る + annoSummary.step=N(AIにも人間にもステップだと伝わる)。
  const stepContext = await page.evaluate(async () => {
    window.__BAG_TEST__.clearAnnotations();
    const link = document.querySelector('#feedZone a.title');
    const saved = await window.__BAG_TEST__.upsertAnnotation({
      kind: 'note',
      anchor: window.__BAG_TEST__.buildAnchor(link),
      note: 'ここを直す',
      outline: true,
    });
    const text = window.__BAG_TEST__.buildContextText();
    return { inText: text.includes('手順1（人の補足') && text.includes(': ここを直す'), step: saved?.step };
  });
  check('メモ手順: AI文脈に「手順1（補足）」で出る + annoSummary.step=1', stepContext.inText && stepContext.step === 1, JSON.stringify(stepContext));

  // 対象未解決の補足は浮遊キャプション(.bag-step-caption.bag-floating)で番号付き常時表示する。
  const floatingNote = await page.evaluate(async () => {
    window.__BAG_TEST__.clearAnnotations();
    const host = document.createElement('div');
    host.id = 'floaty-host';
    const el = document.createElement('button');
    el.id = 'floaty-target';
    el.textContent = 'ユニークに消える対象xyz';
    host.appendChild(el);
    document.body.appendChild(host);
    await window.__BAG_TEST__.upsertAnnotation({
      kind: 'note',
      anchor: window.__BAG_TEST__.buildAnchor(el),
      note: '浮遊メモ',
    });
    host.remove(); // 対象を消す → 次の render で未解決 → floating 経路
    window.__BAG_TEST__.renderAnnotations();
    const fc = document.querySelectorAll('.bag-step-caption.bag-floating');
    return {
      count: fc.length,
      num: fc[0]?.querySelector('.bag-step-caption-num')?.textContent,
      text: fc[0]?.querySelector('.bag-step-caption-text')?.textContent,
    };
  });
  check(
    '浮遊メモ: 対象未解決の補足は floating キャプションで番号付き常時表示',
    floatingNote.count === 1 && floatingNote.num === '1' && floatingNote.text === '浮遊メモ',
    JSON.stringify(floatingNote)
  );

  await page.evaluate(() => {
    window.__BAG_TEST__.clearAnnotations();
    document.querySelector('#floaty-host')?.remove();
    document.querySelector('#misbind-fixture')?.remove();
  });

  // --- MUST-FIX 1: 共有testidの兄弟でテキストが変化/重複しても、選んだ位置の要素へ戻る ---
  // (テキスト+300がセレクタ位置を上書きし、古い値を持つ兄弟へ赤枠が逃げた回帰の防止)
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'stale-fixture';
    host.innerHTML =
      '<div class="grid">' +
      '<article data-testid="metricRow">42%</article>' +
      '<article data-testid="metricRow">17%</article>' +
      '</div>';
    document.body.appendChild(host);
  });
  const staleMutated = await page.evaluate(() => {
    const cards = document.querySelectorAll('#stale-fixture [data-testid="metricRow"]');
    const anchor = window.__BAG_TEST__.buildAnchor(cards[1]); // 2枚目(位置1)を選ぶ。捕捉時 text="17%"
    cards[1].textContent = '55%'; // 選んだカードのテキストが更新され…
    cards[0].textContent = '17%'; // …古い値("17%")が兄弟(位置0)へ移る(ライブ更新の典型)
    const resolved = window.__BAG_TEST__.resolveAnchor(anchor);
    return { ok: resolved === cards[1], text: resolved && resolved.textContent };
  });
  check('MUST-FIX1: テキスト変化後も選んだ2枚目へ戻る(古い値を持つ兄弟に逃げない)', staleMutated.ok, JSON.stringify(staleMutated));
  const dupText = await page.evaluate(() => {
    const cards = document.querySelectorAll('#stale-fixture [data-testid="metricRow"]');
    cards[0].textContent = '0%';
    cards[1].textContent = '0%'; // 最初から同一テキスト("토론 밀도 0%"事例)で2枚目を選ぶ
    const anchor = window.__BAG_TEST__.buildAnchor(cards[1]);
    const resolved = window.__BAG_TEST__.resolveAnchor(anchor);
    return { ok: resolved === cards[1] };
  });
  check('MUST-FIX1: 兄弟が同一テキストでも選んだ2枚目へ戻る(文書順先頭に逃げない)', dupText.ok, JSON.stringify(dupText));
  await page.evaluate(() => document.querySelector('#stale-fixture')?.remove());

  // MUST-FIX1b: 捕捉後に手前へ新カードが挿入され位置がズレても、ユニークなテキストで拾い直す
  // (フィードの「新着を先頭に挿入」= SPA定番。位置インデックスが古くなる回帰の防止)
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'prepend-fixture';
    host.innerHTML =
      '<ul id="feed2">' +
      '<li data-testid="post-card"><h3>알파 기사</h3></li>' +
      '<li data-testid="post-card"><h3>베타 기사</h3></li>' +
      '<li data-testid="post-card"><h3>감마 기사</h3></li>' +
      '</ul>';
    document.body.appendChild(host);
  });
  const prepend = await page.evaluate(() => {
    const beta = document.querySelectorAll('#feed2 li[data-testid="post-card"] > h3')[1];
    const anchor = window.__BAG_TEST__.buildAnchor(beta); // 捕捉: selectorIndex=1, selectorCount=3, text="베타 기사"
    const feed = document.querySelector('#feed2');
    const li = document.createElement('li');
    li.setAttribute('data-testid', 'post-card');
    const h = document.createElement('h3');
    h.textContent = '새 기사';
    li.appendChild(h);
    feed.insertBefore(li, feed.firstChild); // 先頭に新着を挿入 → 捕捉要素は index 2 へズレる
    const resolved = window.__BAG_TEST__.resolveAnchor(anchor);
    return { ok: resolved === beta, text: resolved && resolved.textContent };
  });
  check('MUST-FIX1b: 手前に挿入で位置がズレても捕捉したカード(베타)へ戻る(隣に逃げない)', prepend.ok, JSON.stringify(prepend));
  await page.evaluate(() => document.querySelector('#prepend-fixture')?.remove());

  // --- MUST-FIX 2: テキスト無し+近傍リンク無しのアイコン/SVGボタンでも buildAnchor が落ちない ---
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'icon-fixture';
    host.innerHTML = '<div id="iconbar2"><button class="ic"><svg width="10" height="10"></svg></button></div>';
    document.body.appendChild(host);
  });
  const iconAnno = await page.evaluate(() => {
    const btn = document.querySelector('#icon-fixture .ic');
    let threw = false;
    let anchor = null;
    try {
      anchor = window.__BAG_TEST__.buildAnchor(btn);
    } catch (e) {
      threw = String((e && e.message) || e);
    }
    const resolved = anchor ? window.__BAG_TEST__.resolveAnchor(anchor) : null;
    return { threw, resolvedOk: resolved === btn };
  });
  check('MUST-FIX2: テキスト無し+リンク無しのアイコンボタンでbuildAnchorが例外を投げない', iconAnno.threw === false, JSON.stringify(iconAnno));
  check('MUST-FIX2: そのアイコンボタンが自身へ解決する(注釈できる)', iconAnno.resolvedOk, JSON.stringify(iconAnno));
  await page.evaluate(() => document.querySelector('#icon-fixture')?.remove());

  // --- MUST-FIX 3: 共有testidのフィードで O(N^2) にならない(セレクタ照会はanchor毎1回・プール有界) ---
  const perf = await page.evaluate(async () => {
    window.__BAG_TEST__.clearAnnotations();
    const N = 40;
    const host = document.createElement('div');
    host.id = 'perf-fixture';
    let html = '';
    for (let i = 0; i < N; i += 1) {
      html += '<li data-testid="feedcard"><h3><a href="/feed/' + i + '"><span class="tt">記事' + i + '</span></a></h3></li>';
    }
    host.innerHTML = '<ul>' + html + '</ul>';
    document.body.appendChild(host);
    const spans = Array.from(document.querySelectorAll('#perf-fixture .tt'));
    for (const span of spans) {
      await window.__BAG_TEST__.upsertAnnotation({ kind: 'note', anchor: window.__BAG_TEST__.buildAnchor(span), note: 'x', outline: true });
    }
    // 1回の renderAnnotations 中の document.querySelectorAll 呼び出し回数を計測する。
    const orig = document.querySelectorAll.bind(document);
    let qsaCount = 0;
    document.querySelectorAll = function (...a) {
      qsaCount += 1;
      return orig(...a);
    };
    try {
      window.__BAG_TEST__.renderAnnotations();
    } finally {
      document.querySelectorAll = orig;
    }
    // 各注釈が自分のカードへ解決しているか(スケールしても誤バインドしない)。
    let correct = 0;
    for (let i = 0; i < spans.length; i += 1) {
      if (window.__BAG_TEST__.resolveAnchor(window.__BAG_TEST__.buildAnchor(spans[i])) === spans[i]) correct += 1;
    }
    return { N, qsaCount, correct };
  });
  // O(N^2) 版なら N*プール ≈ 数千回。修正版は anchor 毎おおむね1回 + 固定オーバーヘッドで線形。
  check('MUST-FIX3: renderのquerySelectorAll回数が線形に収まる(<6N)', perf.qsaCount < perf.N * 6, JSON.stringify(perf));
  check('MUST-FIX3: N枚の共有testidカードでも各注釈が自分のカードへ解決する', perf.correct === perf.N, JSON.stringify(perf));
  await page.evaluate(() => {
    window.__BAG_TEST__.clearAnnotations();
    document.querySelector('#perf-fixture')?.remove();
  });

  return { total: results.length, passed: results.filter((r) => r.pass).length, results };
}`;

const session = `bag-anchor-${process.pid}`;
const runnerFile = join(tmpDir, `anchor-runner-${process.pid}.js`);
writeFileSync(runnerFile, runnerSource, 'utf8');

function runCli(args, options = {}) {
  return execFileSync('playwright-cli', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

let raw = '';
try {
  runCli(['-s', session, 'open', 'about:blank']);
  raw = runCli(['-s', session, '--raw', 'run-code', `--filename=${runnerFile}`]);
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  try {
    runCli(['-s', session, 'close']);
  } catch {
    /* best effort cleanup */
  }
  rmSync(runnerFile, { force: true });
}

const report = JSON.parse(raw.trim());
for (const result of report.results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}${result.pass ? '' : ` -- ${result.detail}`}`);
}
console.log(`\n${report.passed}/${report.total} passed`);
if (report.passed !== report.total) process.exit(1);
