// お描きモード中に、サイト側の「モーダル外をクリック/タップで閉じる」挙動で
// 既存のモーダル/ポップアップが閉じてしまわないことを検証するリグレッションスペック。
// content/content-script.js を chrome スタブ付きで直接注入し、START_DRAWING を発火させて
// ページ上(モーダル外)をドラッグする。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');
// content-script は SW から GET_I18N でロケール辞書を受け取る。テストでは日本語辞書を供給して
// ツールバー等が実文言(短い)で描画されるようにする(キー文字列のままだと寸法がズレる)。
const jaLocaleJson = fs.readFileSync(path.join(projectRoot, 'sidepanel/locales/ja.json'), 'utf8');

// 「モーダル外をクリックで閉じる」を capture/bubble の両段で実装したテストページ。
// 実サイトでよくある実装(pointerdown/mousedown/click のいずれか)を網羅する。
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div id="modal" style="position:fixed;left:120px;top:300px;width:160px;height:160px;background:#fff;border:2px solid #333">
    モーダル
  </div>
  <script>
    const modal = document.getElementById('modal');
    function maybeClose(e){ if(!modal.contains(e.target)) modal.dataset.closed = '1'; }
    document.addEventListener('pointerdown', maybeClose, true); // capture 段
    document.addEventListener('mousedown', maybeClose);          // bubble 段
    document.addEventListener('click', maybeClose);              // bubble 段
  </script>
</body></html>`;

const AUTHOR_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
  <button id="target" style="position:fixed;left:72px;top:620px;width:210px;height:48px">下部の対象</button>
</body></html>`;

// content-script を chrome スタブ + content.css + 日本語ロケール付きでページへ注入する。
// 補足オーバーレイ系テスト(複数)で共有するため共通化する。
async function installContentScript(page, html, viewport) {
  if (viewport) await page.setViewportSize(viewport);
  await page.setContent(html);
  await page.addScriptTag({
    content: `
      window.__bagListener = null;
      window.__bagI18n = ${jaLocaleJson};
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
          sendMessage: (msg, cb) => {
            if (msg && msg.type === 'GET_I18N') {
              const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
              if (typeof cb === 'function') { cb(r); return; }
              return Promise.resolve(r);
            }
            if (typeof cb === 'function') { cb({ ok: true }); return; }
            return Promise.resolve({ ok: true });
          },
          get lastError() { return null; },
        },
        // 実際に永続化する in-memory ストア。START_PICKER は毎回 loadAnnotations() で
        // storage から読み直すため、空スタブだと複数回ピックで前の補足が消えてしまう
        // (本番は chrome.storage が永続化するので問題ない。これはテスト環境の再現用)。
        storage: {
          local: {
            // 参照ではなく値で出し入れする(本物の chrome.storage と同じく aliasing しない)。
            get: async (k) => {
              const s = (window.__bagStore = window.__bagStore || {});
              const pick = (key) => structuredClone(s[key]);
              if (k == null) return structuredClone(s);
              if (typeof k === 'string') return (k in s) ? { [k]: pick(k) } : {};
              if (Array.isArray(k)) { const o = {}; for (const kk of k) if (kk in s) o[kk] = pick(kk); return o; }
              const o = { ...k }; for (const kk of Object.keys(k)) if (kk in s) o[kk] = pick(kk); return o;
            },
            set: async (obj) => { Object.assign((window.__bagStore = window.__bagStore || {}), structuredClone(obj)); },
          },
          onChanged: { addListener() {} },
        },
      };
    `,
  });
  await page.addStyleTag({ content: contentCss });
  await page.addScriptTag({ content: contentScript });
}

// ピッカーを起動し、対象をホバー→クリックして補足本文を入力・保存する(= 'note' 赤枠を確定)。
async function pickAndSaveNote(page, selector, note) {
  await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'START_PICKER' }, {}, r)));
  await page.locator(selector).hover();
  await page.locator(selector).click();
  const author = page.locator('.bag-author');
  await expect(author).toBeVisible();
  await author.locator('[data-f="note"]').fill(note);
  await author.locator('[data-f="save"]').click();
  await expect(author).toHaveCount(0);
}

// 対象矩形(2px外側に広げた赤枠)と box の矩形が中心・サイズとも一致するか。
function boxWrapsTarget(page, boxSel, targetSel) {
  return page.evaluate(
    ([bSel, tSel]) => {
      const t = document.querySelector(tSel).getBoundingClientRect();
      const b = document.querySelector(bSel).getBoundingClientRect();
      return (
        Math.abs(b.left + b.width / 2 - (t.left + t.width / 2)) < 3 &&
        Math.abs(b.top + b.height / 2 - (t.top + t.height / 2)) < 3 &&
        Math.abs(b.width - (t.width + 4)) < 3 &&
        Math.abs(b.height - (t.height + 4)) < 3
      );
    },
    [boxSel, targetSel]
  );
}

test('お描きツールバーはi18n読み込み完了後に描画される', async ({ page }) => {
  await page.setContent(PAGE_HTML);
  await page.addScriptTag({
    content: `
      window.__bagListener = null;
      window.__bagI18n = ${jaLocaleJson};
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
          sendMessage: (msg, cb) => {
            if (msg && msg.type === 'GET_I18N') {
              const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
              const p = new Promise((resolve) => setTimeout(() => resolve(r), 80));
              if (typeof cb === 'function') { p.then(cb); return; }
              return p;
            }
            if (typeof cb === 'function') { cb({ ok: true }); return; }
            return Promise.resolve({ ok: true });
          },
          get lastError() { return null; },
        },
        storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      };
    `,
  });
  await page.addStyleTag({ content: contentCss });
  await page.addScriptTag({ content: contentScript });

  await page.evaluate(
    () => new Promise((resolve) => window.__bagListener({ type: 'START_DRAWING' }, {}, resolve))
  );

  await expect(page.locator('.bag-draw-tool[data-tool="ellipse"]')).toContainText('円');
  await expect(page.locator('.bag-draw-toolbar')).not.toContainText('cs.draw.toolEllipse');
});

test('補足フォームはヘッダをドラッグして移動できる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(AUTHOR_PAGE_HTML);
  await page.addScriptTag({
    content: `
      window.__bagListener = null;
      window.__bagI18n = ${jaLocaleJson};
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
          sendMessage: (msg, cb) => {
            if (msg && msg.type === 'GET_I18N') {
              const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
              if (typeof cb === 'function') { cb(r); return; }
              return Promise.resolve(r);
            }
            if (typeof cb === 'function') { cb({ ok: true }); return; }
            return Promise.resolve({ ok: true });
          },
          get lastError() { return null; },
        },
        storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      };
    `,
  });
  await page.addStyleTag({ content: contentCss });
  await page.addScriptTag({ content: contentScript });

  await page.evaluate(
    () => new Promise((resolve) => window.__bagListener({ type: 'START_PICKER' }, {}, resolve))
  );
  await page.locator('#target').click();

  const author = page.locator('.bag-author');
  await expect(author).toBeVisible();
  // 補足フォームはAI向けの指示1欄だけ(種類セレクタは廃止)。
  await expect(author.locator('[data-f="note"]')).toBeVisible();

  const before = await author.boundingBox();
  const head = await author.locator('.bag-author-head').boundingBox();
  await page.mouse.move(head.x + 20, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(28, 28, { steps: 8 });
  await page.mouse.up();

  const after = await author.boundingBox();
  expect(after.y).toBeLessThan(before.y);
  await expect(author.locator('[data-f="save"]')).toBeVisible();
  await author.locator('[data-f="note"]').fill('下でも保存できる');
  await author.locator('[data-f="save"]').click();
  await expect(author).toHaveCount(0);
});

test('補足は種類選択なしのAI指示1欄で、選択した要素を赤枠で囲む', async ({ page }) => {
  const red = 'rgb(239, 68, 68)';
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(AUTHOR_PAGE_HTML);
  await page.addScriptTag({
    content: `
      window.__bagListener = null;
      window.__bagI18n = ${jaLocaleJson};
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
          sendMessage: (msg, cb) => {
            if (msg && msg.type === 'GET_I18N') {
              const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
              if (typeof cb === 'function') { cb(r); return; }
              return Promise.resolve(r);
            }
            if (typeof cb === 'function') { cb({ ok: true }); return; }
            return Promise.resolve({ ok: true });
          },
          get lastError() { return null; },
        },
        storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      };
    `,
  });
  await page.addStyleTag({ content: contentCss });
  await page.addScriptTag({ content: contentScript });

  await page.evaluate(
    () => new Promise((resolve) => window.__bagListener({ type: 'START_PICKER' }, {}, resolve))
  );

  // 選択中ハイライト枠は赤い破線（ページ本来の実線ボーダーと区別する）。
  await page.locator('#target').hover();
  await expect(page.locator('.bag-pick-overlay')).toHaveCSS('border-top-color', red);
  await expect(page.locator('.bag-pick-overlay')).toHaveCSS('border-top-style', 'dashed');

  await page.locator('#target').click();
  const author = page.locator('.bag-author');
  await expect(author).toBeVisible();
  // 種類セレクタ/名前/目的の各欄は廃止し、AI向けの指示1欄だけにする。
  await expect(author.locator('[data-f="kind"]')).toHaveCount(0);
  await expect(author.locator('[data-f="label"]')).toHaveCount(0);
  await expect(author.locator('[data-f="intent"]')).toHaveCount(0);
  await expect(author.locator('[data-f="note"]')).toHaveCount(1);

  await author.locator('[data-f="note"]').fill('送信前に内容を確認する');
  await author.locator('[data-f="save"]').click();
  await expect(author).toHaveCount(0);

  // 補足を付けると、対象を囲む赤い破線のオーバーレイ枠が1つ現れる。CSS outline ではなく
  // 祖先から切り離した独立レイヤなので、サイトの overflow/z-index に影響されず確実に囲める。
  const outlineBox = page.locator('.bag-anno-outline-box');
  await expect(outlineBox).toHaveCount(1);
  await expect(outlineBox).toHaveCSS('border-top-color', red);
  await expect(outlineBox).toHaveCSS('border-top-style', 'dashed');
  // 枠は選択した #target に重なる(中心・サイズが一致。枠は 2px 外側へ広げて囲む)。
  const wraps = await page.evaluate(() => {
    const t = document.querySelector('#target').getBoundingClientRect();
    const b = document.querySelector('.bag-anno-outline-box').getBoundingClientRect();
    return (
      Math.abs(b.left + b.width / 2 - (t.left + t.width / 2)) < 3 &&
      Math.abs(b.top + b.height / 2 - (t.top + t.height / 2)) < 3 &&
      Math.abs(b.width - (t.width + 4)) < 3 &&
      Math.abs(b.height - (t.height + 4)) < 3
    );
  });
  expect(wraps).toBe(true);
});

// 本丸の回帰: 旧 CSS outline は対象自身に描かれるため、祖先 overflow:hidden(クリップ)や
// 高 z-index 兄弟(上塗り)・transform で枠が欠けた(Amazonで3回再発)。新方式は枠を
// 祖先から切り離した最上位 fixed レイヤ(.bag-anno-outline-host)に描くので、これらの
// 病的DOMでも対象を正しく囲める。枠が clip/transform サブツリーの外側にあること＋対象に
// 重なることを検証する(旧方式なら .bag-anno-outline-box 自体が存在せず必ず落ちる)。
test('補足赤枠: overflow:hidden + 高z-index兄弟 + transform 配下でも対象を囲む(クリップ/上塗りに耐える)', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
  <body style="margin:0">
    <div id="clip" style="position:absolute;left:30px;top:200px;width:300px;height:120px;overflow:hidden;transform:translateZ(0)">
      <div style="position:absolute;inset:0;background:#eef">
        <button id="target" style="position:absolute;left:20px;top:20px;width:260px;height:80px;z-index:1">対象カード</button>
        <!-- 旧 outline を上塗りしていた高z-index兄弟。pointer-events:none でクリックは対象に透過。 -->
        <div id="cover" style="position:absolute;inset:0;z-index:99;background:rgba(0,120,255,0.35);pointer-events:none"></div>
      </div>
    </div>
  </body></html>`;
  await installContentScript(page, html, { width: 420, height: 720 });
  await pickAndSaveNote(page, '#target', 'ここを直す');

  const box = page.locator('.bag-anno-outline-box');
  await expect(box).toHaveCount(1);
  // 枠は clip/transform サブツリーの外(最上位 host)にあり、祖先の overflow/transform に縛られない。
  const placement = await page.evaluate(() => {
    const b = document.querySelector('.bag-anno-outline-box');
    return {
      insideClip: Boolean(b.closest('#clip')),
      parentIsHost: Boolean(b.parentElement && b.parentElement.classList.contains('bag-anno-outline-host')),
      hostOnRoot: document.querySelector('.bag-anno-outline-host')?.parentElement === document.documentElement,
    };
  });
  expect(placement.insideClip).toBe(false);
  expect(placement.parentIsHost).toBe(true);
  expect(placement.hostOnRoot).toBe(true);
  // それでいて対象カードにぴったり重なる(クリップで欠けていない)。
  expect(await boxWrapsTarget(page, '.bag-anno-outline-box', '#target')).toBe(true);
});

// スクロール/リサイズ追従(新規配線。これが無いとレイアウト変化で枠がズレる)。
test('補足赤枠: スクロールしても対象に追従する(reposition 配線)', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
  <body style="margin:0;height:2000px">
    <button id="target" style="position:absolute;left:40px;top:140px;width:200px;height:60px">対象</button>
  </body></html>`;
  await installContentScript(page, html, { width: 420, height: 600 });
  await pickAndSaveNote(page, '#target', '追従の確認');

  await expect(page.locator('.bag-anno-outline-box')).toHaveCount(1);
  expect(await boxWrapsTarget(page, '.bag-anno-outline-box', '#target')).toBe(true);

  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(80); // scroll イベント→rAF→repositionOutlineBoxes を待つ
  // 対象は viewport 上で上へ動くが、枠も追従して重なり続ける。
  expect(await boxWrapsTarget(page, '.bag-anno-outline-box', '#target')).toBe(true);
});

// capture 時の可視性(html.bag-capturing 例外)。これが効かないと枠が全スクショから消える。
test('補足赤枠: capture 中(bag-capturing)も枠だけは可視のまま残る', async ({ page }) => {
  await installContentScript(page, AUTHOR_PAGE_HTML, { width: 420, height: 720 });
  await pickAndSaveNote(page, '#target', 'スクショに残す');

  await page.evaluate(() => document.documentElement.classList.add('bag-capturing'));
  // host(data-bag-ui)は隠れるが、box は html.bag-capturing 例外で可視のまま。
  await expect(page.locator('.bag-anno-outline-host')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('.bag-anno-outline-box')).toHaveCSS('visibility', 'visible');
  await expect(page.locator('.bag-anno-outline-box')).toBeVisible();
  // キャプション(本文)は capture 時は隠す(本文はAI文脈で渡るため、スクショを汚さない)。
  await expect(page.locator('.bag-step-caption')).toHaveCSS('visibility', 'hidden');
});

// 補足の本文を「常時表示の番号付き手順キャプション」として最上位レイヤに描く(z-index安全)。
test('補足キャプション: メモ本文と番号を常時表示し、最上位レイヤに置く', async ({ page }) => {
  await installContentScript(page, AUTHOR_PAGE_HTML, { width: 420, height: 720 });
  await pickAndSaveNote(page, '#target', '「送信」に文言を直す');

  const cap = page.locator('.bag-step-caption');
  await expect(cap).toHaveCount(1);
  await expect(cap).toBeVisible(); // hover 不要で常時表示
  await expect(cap.locator('.bag-step-caption-num')).toHaveText('1');
  await expect(cap.locator('.bag-step-caption-text')).toHaveText('「送信」に文言を直す');
  // 最上位の独立レイヤ(.bag-anno-outline-host)に置かれ、ページの z-index に隠されない。
  const placement = await page.evaluate(() => {
    const c = document.querySelector('.bag-step-caption');
    const host = document.querySelector('.bag-anno-outline-host');
    const b = document.querySelector('.bag-anno-outline-box').getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    return {
      inHost: Boolean(c.closest('.bag-anno-outline-host')),
      hostZ: Number(getComputedStyle(host).zIndex),
      // 枠と左揃え、かつ縦に隣接(枠の上 or 下)に置く。
      aligned: Math.abs(cr.left - b.left) < 10 && (cr.bottom <= b.top + 2 || cr.top >= b.bottom - 2),
    };
  });
  expect(placement.inHost).toBe(true);
  expect(placement.hostZ).toBeGreaterThan(2147483000);
  expect(placement.aligned).toBe(true);
});

// 補足は作成順に 1,2,... と採番される(ワークフローの手順番号)。
test('補足キャプション: 複数の補足は番号順(1,2)で振られる', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
  <body style="margin:0">
    <button id="a" style="position:fixed;left:40px;top:140px;width:160px;height:40px">A</button>
    <button id="b" style="position:fixed;left:40px;top:340px;width:160px;height:40px">B</button>
  </body></html>`;
  await installContentScript(page, html, { width: 420, height: 720 });
  await pickAndSaveNote(page, '#a', '最初のステップ');
  await pickAndSaveNote(page, '#b', '次のステップ');

  await expect(page.locator('.bag-step-caption')).toHaveCount(2);
  // 番号を要素に束縛して検証する(sort で順序を誤魔化さない)。先にピックした #a が手順1。
  const numByTarget = await page.evaluate(() => {
    const rectOf = (sel) => document.querySelector(sel).getBoundingClientRect();
    const caps = [...document.querySelectorAll('.bag-step-caption')];
    const numNear = (tr) => {
      // 対象に最も水平方向で近い(左揃え)キャプションの番号を返す。
      let best = null, bestDx = Infinity;
      for (const c of caps) {
        const cr = c.getBoundingClientRect();
        const dx = Math.abs(cr.left - tr.left) + Math.abs((cr.top + cr.height / 2) - (tr.top + tr.height / 2));
        if (dx < bestDx) { bestDx = dx; best = c; }
      }
      return best?.querySelector('.bag-step-caption-num')?.textContent;
    };
    return { a: numNear(rectOf('#a')), b: numNear(rectOf('#b')) };
  });
  expect(numByTarget.a).toBe('1'); // 先にピックした #a が手順1
  expect(numByTarget.b).toBe('2'); // 次の #b が手順2
});

// 本丸の回帰(キャプション版): 高 z-index のページ要素があってもキャプションが上塗りされない。
// キャプションは pointer-events:none なので elementFromPoint には出ない。代わりに「同一ルート
// stacking context で host の z-index がページ要素より大きい」=前面、を検証する(これが前面判定の本質)。
test('補足キャプション: 高z-indexのページ要素より前面に出る(z-index安全)', async ({ page }) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
  <body style="margin:0">
    <button id="target" style="position:fixed;left:60px;top:300px;width:200px;height:60px">対象</button>
    <!-- ページ側の非常に高い z-index の全画面覆い(pointer-events:none でクリックは対象へ透過)。 -->
    <div id="cover" style="position:fixed;inset:0;z-index:2147483000;background:rgba(0,120,255,0.3);pointer-events:none"></div>
  </body></html>`;
  await installContentScript(page, html, { width: 420, height: 720 });
  await pickAndSaveNote(page, '#target', 'ここを直す');

  const z = await page.evaluate(() => {
    const host = document.querySelector('.bag-anno-outline-host');
    const cover = document.querySelector('#cover');
    return {
      capInHost: Boolean(document.querySelector('.bag-step-caption')?.closest('.bag-anno-outline-host')),
      // 双方ともルート直下の positioned 要素 = 同一 stacking context。z の大小がそのまま前後関係。
      bothRootLevel:
        host.parentElement === document.documentElement &&
        (cover.parentElement === document.body || cover.parentElement === document.documentElement),
      hostZ: Number(getComputedStyle(host).zIndex),
      coverZ: Number(getComputedStyle(cover).zIndex),
    };
  });
  expect(z.capInHost).toBe(true);
  expect(z.bothRootLevel).toBe(true);
  expect(z.hostZ).toBeGreaterThan(z.coverZ); // host が前面 → その中のキャプションも覆いより前
});

test.describe('お描き中のモーダル保護', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(PAGE_HTML);
    // content-script が参照する chrome API を最小スタブ化し、onMessage リスナーを捕捉する。
    // content-script より前に評価する必要があるため、独立した script タグで先に注入する。
    await page.addScriptTag({
      content: `
        window.__bagListener = null;
        window.__bagI18n = ${jaLocaleJson};
        window.chrome = {
          runtime: {
            onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
            sendMessage: (msg, cb) => {
              if (msg && msg.type === 'GET_I18N') {
                const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
                if (typeof cb === 'function') { cb(r); return; }
                return Promise.resolve(r);
              }
              if (typeof cb === 'function') { cb({ ok: true }); return; }
              return Promise.resolve({ ok: true });
            },
            get lastError() { return null; },
          },
          storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
        };
      `,
    });
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });
    // START_DRAWING を発火してお描きモードへ。
    await page.evaluate(
      () => new Promise((resolve) => window.__bagListener({ type: 'START_DRAWING' }, {}, resolve))
    );
    await expect(page.locator('.bag-draw-overlay')).toHaveCount(1);
  });

  test('モーダル外をドラッグして描いてもモーダルは閉じない', async ({ page }) => {
    // モーダル(120,300)-(280,460) の外側=上部領域をドラッグして円を描く。
    await page.mouse.move(60, 80);
    await page.mouse.down();
    await page.mouse.move(140, 140, { steps: 8 });
    await page.mouse.move(300, 200, { steps: 8 });
    await page.mouse.up();

    // サイトの閉じる処理は発火していない。
    await expect(page.locator('#modal')).not.toHaveAttribute('data-closed', '1');
    // 図形は確定描画されている(確定グループに子要素が増える)。
    const drawn = await page.locator('.bag-draw-committed > *').count();
    expect(drawn).toBeGreaterThan(0);
  });

  test('ツールバーのボタン操作でもモーダルは閉じない', async ({ page }) => {
    await page.locator('.bag-draw-tool[data-tool="rect"]').click();
    await page.locator('.bag-draw-color').nth(1).click();
    await expect(page.locator('#modal')).not.toHaveAttribute('data-closed', '1');
    await expect(page.locator('.bag-draw-tool[data-tool="rect"]')).toHaveClass(/is-active/);
  });
});
