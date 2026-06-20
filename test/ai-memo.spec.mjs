// お描き完了（「完了」押下）で中間モーダルを挟まず、図形のすぐ隣に編集可能な「AIメモ」が即生成され、
// 本文の保存ボタン・forAIトグル・削除・件数・再配置・forAIによる文脈除外が正しく働くことを検証する。
// content/content-script.js を chrome スタブ付きで直接注入して実ブラウザDOMで確認する。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');
// content-script は SW から GET_I18N でロケール辞書を受け取る。テストでは日本語辞書を供給する。
const jaLocaleJson = fs.readFileSync(path.join(projectRoot, 'sidepanel/locales/ja.json'), 'utf8');

// 左側に明確な対象要素(#target)を置き、その上にお描きする。
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
  <button id="target" style="position:fixed;left:60px;top:300px;width:160px;height:48px">CTAボタン</button>
</body></html>`;

// chrome スタブ。storage はメモリ実装で、保存内容を window.__store から検証できる。
const CHROME_STUB = `
  window.__bagListener = null;
  window.__store = {};
  window.__bagI18n = ${jaLocaleJson};
  window.__runtimeMessages = [];
  const __clone = (v) => (v === undefined ? undefined : structuredClone(v));
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'GET_I18N') {
          const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
          if (typeof cb === 'function') { cb(r); return; }
          return Promise.resolve(r);
        }
        window.__runtimeMessages.push(__clone(msg));
        if (typeof cb === 'function') { cb({ ok: true }); return; }
        return Promise.resolve({ ok: true });
      },
      get lastError() { return null; },
    },
    storage: {
      local: {
        get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: __clone(window.__store[k]) } : __clone(window.__store)),
        set: (obj) => { for (const [key, val] of Object.entries(obj)) window.__store[key] = __clone(val); return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
  };
`;

// 図形をドラッグして「完了」を押すと、中間の確認モーダルを挟まず、図形の隣に編集可能な
// AIメモが即生成される（新フロー）。直前の枚数+1になったことで生成を確認する。
async function drawRect(page) {
  const before = await page.locator('.bag-memo').count();
  await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'START_DRAWING' }, {}, r)));
  await expect(page.locator('.bag-draw-overlay')).toHaveCount(1);
  await page.locator('.bag-draw-tool[data-tool="rect"]').click();
  // #target(60,300)-(220,348) を覆う矩形をドラッグで描く。
  await page.mouse.move(70, 308);
  await page.mouse.down();
  await page.mouse.move(150, 330, { steps: 6 });
  await page.mouse.move(210, 342, { steps: 6 });
  await page.mouse.up();
  await page.locator('.bag-draw-op[data-op="done"]').click();
  await expect(page.locator('.bag-author')).toHaveCount(0); // 中間モーダルは出ない
  await expect(page.locator('.bag-memo')).toHaveCount(before + 1); // 図形の隣にメモが即出る
}

// 完了直後に出たAIメモへ、任意で本文を書いて確定（blur）する。note 省略/空なら空のまま。
async function saveDrawingMemo(page, note) {
  await expect(page.locator('.bag-author')).toHaveCount(0);
  const memo = page.locator('.bag-memo').last();
  await expect(memo).toBeVisible();
  if (note) {
    await memo.locator('.bag-memo-text').fill(note);
    await memo.locator('.bag-memo-text').blur();
  }
}

async function drawRectAndFinish(page, note = '') {
  await drawRect(page);
  await saveDrawingMemo(page, note);
}

test.describe('お描き連動のAIメモ', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(PAGE_HTML);
    await page.addScriptTag({ content: CHROME_STUB });
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });
  });

  test('お描き完了で図形の隣に編集可能なAIメモが即生成される', async ({ page }) => {
    // 「完了」を押した時点で（確認モーダルを挟まず）図形の隣にAIメモが現れ、そのまま編集できる。
    await drawRect(page);

    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);
    // 生成直後のメモは空。編集用テキスト、明示保存ボタン、forAIトグルを持つ。
    await expect(memo.locator('.bag-memo-text')).toBeVisible();
    await expect(memo.locator('.bag-memo-text')).toHaveValue('');
    await memo.locator('.bag-memo-text').fill('最初の指示');
    await expect(memo.locator('.bag-memo-text')).toHaveValue('最初の指示');
    await expect(memo.locator('.bag-memo-save')).toHaveText('保存');
    await expect(memo.locator('.bag-memo-toggle input')).toBeChecked(); // forAI 既定ON

    // 図形(SVG)も永続レイヤに描かれている。
    await expect(page.locator('.bag-draw-layer .bag-draw-g rect')).toHaveCount(1);

    // サイドパネルのAI送信トレイ用に、LIST_ANNOTATIONS summary へ小さな図形プレビューが含まれる。
    const listed = await page.evaluate(
      () => new Promise((r) => window.__bagListener({ type: 'LIST_ANNOTATIONS' }, {}, r))
    );
    const summary = listed.annotations.find((a) => a.kind === 'drawing');
    expect(summary.shapePreview.color).toBe('#ef4444');
    expect(summary.shapePreview.shapes.length).toBeGreaterThan(0);
    expect(summary.shapePreview.shapes[0].type).toBe('rect');

    // 本文を編集し、保存ボタンを押すと storage(aiAdvisorAnnotations)へ即時保存される。
    await memo.locator('.bag-memo-text').fill('見出しをもっと短く');
    await memo.locator('.bag-memo-save').click();
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const map = window.__store.aiAdvisorAnnotations || {};
          const scope = location.origin + location.pathname;
          const list = map[scope] || [];
          const memo = list.find((a) => a.kind === 'drawing');
          return memo ? memo.note : null;
        });
      })
      .toBe('見出しをもっと短く');
  });

  test('「完了」を連打しても空メモは1つだけ生成される（再入ガード）', async ({ page }) => {
    // finishDrawing は async（storage を await）。連打/再入で空メモが二重生成されないことを検証する。
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'START_DRAWING' }, {}, r)));
    await expect(page.locator('.bag-draw-overlay')).toHaveCount(1);
    await page.locator('.bag-draw-tool[data-tool="rect"]').click();
    await page.mouse.move(70, 308);
    await page.mouse.down();
    await page.mouse.move(150, 330, { steps: 6 });
    await page.mouse.move(210, 342, { steps: 6 });
    await page.mouse.up();
    // 「完了」を同期的に2回クリックする。1回目で stopDrawing() が drawing.active=false にするため、
    // 2回目（detachされたツールバーへの click）は finishDrawing 冒頭の再入ガードで弾かれる。
    await page.evaluate(() => {
      const btn = document.querySelector('.bag-draw-op[data-op="done"]');
      btn.click();
      btn.click();
    });
    await expect(page.locator('.bag-memo')).toHaveCount(1);
    const drawingCount = await page.evaluate(() => {
      const map = window.__store.aiAdvisorAnnotations || {};
      const scope = location.origin + location.pathname;
      return (map[scope] || []).filter((a) => a.kind === 'drawing').length;
    });
    expect(drawingCount).toBe(1);
  });

  test('AIメモ保存とforAI切替で自動同期用の変更通知を送る', async ({ page }) => {
    await drawRectAndFinish(page, '自動同期して');
    await expect
      .poll(() =>
        page.evaluate(() => window.__runtimeMessages.filter((m) => m?.type === 'VISUAL_FEEDBACK_CHANGED').at(-1)?.sendCount)
      )
      .toBe(1);

    await page.locator('.bag-memo-toggle input').uncheck();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const events = window.__runtimeMessages.filter((m) => m?.type === 'VISUAL_FEEDBACK_CHANGED');
          return events.at(-1);
        })
      )
      .toMatchObject({ type: 'VISUAL_FEEDBACK_CHANGED', reason: 'update', sendCount: 0 });
  });

  test('メモは図形の隣(右既定)に置かれ、引き出し線で結ばれる', async ({ page }) => {
    // 右側に余白を確保するため広いビューポートにする(既定の390pxではメモ240pxが右に収まらない)。
    await page.setViewportSize({ width: 1000, height: 780 });
    await drawRectAndFinish(page);
    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);

    const box = await memo.boundingBox();
    const target = await page.locator('#target').boundingBox();
    // #target は左側(~60-220px)。右側に余白があっても画面端へ飛ばず、図形のすぐ右隣に出る。
    expect(box.x).toBeGreaterThanOrEqual(target.x + target.width - 16);
    expect(box.x).toBeLessThanOrEqual(target.x + target.width + 28);
    await expect(memo).toHaveAttribute('data-side', 'right');
    // コネクタ(引き出し線)が描かれている。
    await expect(page.locator('.bag-draw-layer .bag-memo-connector')).toHaveCount(1);
  });

  test('右に収まらなければ反転/下配置して画面外に出さない', async ({ page }) => {
    // 既定の狭いビューポート(390px)では右に収まらないので、左/下へ反転する。
    await drawRectAndFinish(page);
    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);
    const side = await memo.getAttribute('data-side');
    expect(['left', 'bottom']).toContain(side);
    // 画面外に出ていない(左端 >= 0 かつ 右端 <= ビューポート幅)。
    const box = await memo.boundingBox();
    const vw = page.viewportSize().width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw + 1);
  });

  test('forAIトグルOFFは保存され、文脈(EXPORT/COLLECT)から除外される', async ({ page }) => {
    await drawRectAndFinish(page);
    const memo = page.locator('.bag-memo');
    await memo.locator('.bag-memo-text').fill('AIには渡さない私的メモ');
    await memo.locator('.bag-memo-text').blur();
    await memo.locator('.bag-memo-toggle input').uncheck();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const map = window.__store.aiAdvisorAnnotations || {};
          const scope = location.origin + location.pathname;
          return (map[scope] || []).find((a) => a.kind === 'drawing')?.forAI;
        })
      )
      .toBe(false);

    // buildContextText(EXPORT_CONTEXT) には forAI=false のメモ本文が含まれない。
    const ctx = await page.evaluate(
      () => new Promise((r) => window.__bagListener({ type: 'EXPORT_CONTEXT' }, {}, (res) => r(res.text)))
    );
    expect(ctx).not.toContain('AIには渡さない私的メモ');

    // COLLECT_CONTEXT の annotations サマリには forAI=false が反映される。
    const ctxData = await page.evaluate(
      () => new Promise((r) => window.__bagListener({ type: 'COLLECT_CONTEXT' }, {}, r))
    );
    const summary = ctxData.annotations.find((a) => a.kind === 'drawing');
    expect(summary.forAI).toBe(false);
  });

  test('PREPARE_CAPTURE が data-agent-id を軽量文脈用メタとして含める', async ({ page }) => {
    await page.locator('#target').evaluate((el) => {
      el.setAttribute('data-agent-id', '@agent:test/cta');
    });
    await drawRectAndFinish(page, 'このCTAを調整');

    const vf = await page.evaluate(
      () => new Promise((r) => window.__bagListener({ type: 'PREPARE_CAPTURE' }, {}, r))
    );
    expect(vf.items[0].dataAgentId).toBe('@agent:test/cta');
    expect(vf.items[0].selector).toBe('[data-agent-id="@agent:test/cta"]');
    expect(vf.items[0].role).toBe('button');
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'FINISH_CAPTURE' }, {}, r)));
  });

  test('削除でメモと図形が消え、保存からも除かれる', async ({ page }) => {
    await drawRectAndFinish(page);
    await expect(page.locator('.bag-memo')).toHaveCount(1);
    await page.evaluate(() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'bag-draw-layer');
      svg.setAttribute('data-bag-ui', '1');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'bag-memo-connector');
      line.setAttribute('x1', '10');
      line.setAttribute('y1', '10');
      line.setAttribute('x2', '120');
      line.setAttribute('y2', '60');
      svg.appendChild(line);
      document.documentElement.appendChild(svg);
    });
    await expect(page.locator('.bag-memo-connector')).toHaveCount(2);
    await page.locator('.bag-memo .bag-memo-del').click();

    await expect(page.locator('.bag-memo')).toHaveCount(0);
    await expect(page.locator('.bag-draw-layer .bag-draw-g')).toHaveCount(0);
    await expect(page.locator('.bag-memo-connector')).toHaveCount(0);
    const remaining = await page.evaluate(() => {
      const map = window.__store.aiAdvisorAnnotations || {};
      const scope = location.origin + location.pathname;
      return (map[scope] || []).length;
    });
    expect(remaining).toBe(0);
  });

  test('AIメモ生成時に折り畳み用の余分なボタンを作らない', async ({ page }) => {
    await drawRectAndFinish(page);
    const memo = page.locator('.bag-memo');
    await expect(memo).toBeVisible();
    await expect(page.locator('.bag-memo-collapse')).toHaveCount(0);
    await expect(page.locator('.bag-memo-badge')).toHaveCount(0);
  });

  test('forAI未設定の旧レコードもメモとして復元され既定でAIに渡る(後方互換)', async ({ page }) => {
    // forAI を持たない旧スキーマの drawing レコードを直接 storage に流し込み、再読込で復元する。
    await page.evaluate(() => {
      const scope = location.origin + location.pathname;
      window.__store.aiAdvisorAnnotations = {
        [scope]: [
          {
            id: 'legacy-1',
            kind: 'drawing',
            createdAt: new Date().toISOString(),
            note: '旧メモ本文',
            intent: '',
            anchor: { selector: '#target', tag: 'button', role: 'button', text: 'CTAボタン' },
            shapes: [{ type: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.5, color: '#ef4444', width: 3 }],
          },
        ],
      };
    });
    await page.evaluate(
      () => new Promise((r) => window.__bagListener({ type: 'LIST_ANNOTATIONS' }, {}, r))
    );
    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);
    await expect(memo.locator('.bag-memo-toggle input')).toBeChecked(); // forAI未設定→ON扱い
    await expect(memo.locator('.bag-memo-text')).toHaveValue('旧メモ本文');
  });

  test('Amazon風の商品カードDOMが差し替わってもdata-asinでAIメモを再解決する', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 820 });
    await page.evaluate(() => {
      document.body.innerHTML = `
        <main>
          <section>
            <div class="s-result-item" data-asin="B012345678" style="position:fixed;left:60px;top:120px;width:420px;height:260px;border:1px solid #ddd;background:#fff">
              <div class="a-section" style="position:absolute;inset:0">
                <div class="image-shell" style="position:absolute;left:24px;top:42px;width:156px;height:156px;background:#eef2f7"></div>
                <div style="position:absolute;left:210px;top:54px;width:170px">Amazon dynamic card</div>
              </div>
            </div>
          </section>
        </main>`;
    });

    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'START_DRAWING' }, {}, r)));
    await page.locator('.bag-draw-tool[data-tool="rect"]').click();
    await page.mouse.move(78, 174);
    await page.mouse.down();
    await page.mouse.move(150, 232, { steps: 5 });
    await page.mouse.move(205, 268, { steps: 5 });
    await page.mouse.up();
    await page.locator('.bag-draw-op[data-op="done"]').click();
    await saveDrawingMemo(page, 'この商品画像を確認');
    await expect(page.locator('.bag-memo')).toHaveCount(1);
    await page.locator('.bag-memo-text').blur();

    const savedAnchor = await page.evaluate(() => {
      const map = window.__store.aiAdvisorAnnotations || {};
      const scope = location.origin + location.pathname;
      return (map[scope] || []).find((a) => a.kind === 'drawing')?.anchor;
    });
    expect(savedAnchor.dataAsin).toBe('B012345678');
    expect(savedAnchor.selector).toBe('[data-asin="B012345678"]');

    await page.evaluate(() => {
      document.querySelector('[data-asin="B012345678"]').remove();
      const article = document.createElement('article');
      article.className = 's-result-item hydrated';
      article.setAttribute('data-asin', 'B012345678');
      article.style.cssText = 'position:fixed;left:60px;top:430px;width:420px;height:260px;border:1px solid #ddd;background:#fff';
      article.innerHTML = `
        <a href="/dp/B012345678" style="position:absolute;left:20px;top:34px;width:170px;height:170px;background:#e2e8f0;display:block"></a>
        <div style="position:absolute;left:220px;top:60px;width:170px">Rehydrated card</div>`;
      document.body.appendChild(article);
    });

    await expect
      .poll(async () => {
        const box = await page.locator('.bag-memo').boundingBox();
        return Math.round(box?.y || 0);
      })
      .toBeGreaterThan(360);

    const vf = await page.evaluate(
      () => new Promise((r) => window.__bagListener({ type: 'PREPARE_CAPTURE' }, {}, r))
    );
    expect(vf.items[0].resolved).toBe(true);
    expect(vf.items[0].anchorLabel).toContain('Rehydrated card');
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'FINISH_CAPTURE' }, {}, r)));
  });

  test('商品画像だけを囲んだお描きでも近傍の商品リンク候補をcaptureに残す', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 820 });
    await page.route('https://example.com/deals', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
          <section style="position:fixed;left:40px;top:80px;width:700px;height:420px">
            <h2>Fashion x 初夏 タイムセール祭り</h2>
            <ol>
              <li class="product-card" style="position:fixed;left:80px;top:150px;width:260px;height:280px">
                <a href="/dp/B012345678?ref_=test" style="display:block;width:180px;height:180px">
                  <div id="product-art" style="width:180px;height:180px;background:#e2e8f0"></div>
                </a>
                <div class="product-title">Stable Product Name</div>
              </li>
            </ol>
          </section>
        </body></html>`,
      })
    );
    await page.goto('https://example.com/deals');
    await page.addScriptTag({ content: CHROME_STUB });
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });
    await page.evaluate(() => {
      const scope = location.origin + location.pathname;
      window.__store.aiAdvisorAnnotations = {
        [scope]: [
          {
            id: 'image-only-target',
            kind: 'drawing',
            createdAt: new Date().toISOString(),
            note: 'このアイテムをカートに入れる',
            intent: 'このアイテムをカートに入れる',
            forAI: true,
            anchor: {
              selector: '#product-art',
              tag: 'div',
              role: 'div',
              text: '',
            },
            shapes: [{ type: 'rect', x: -0.03, y: -0.04, w: 1.06, h: 1.08, color: '#ef4444', width: 3 }],
          },
        ],
      };
    });

    const vf = await page.evaluate(
      () => new Promise((r) => window.__bagListener({ type: 'PREPARE_CAPTURE' }, {}, r))
    );
    const item = vf.items[0];
    expect(item.anchorLabel).toContain('Stable Product Name');
    expect(item.href).toBe('https://example.com/dp/B012345678');
    expect(item.dataAsin).toBe('B012345678');
    expect(item.targetCandidates.map((c) => c.source)).toEqual(
      expect.arrayContaining(['nearest-link', 'item-container', 'section-heading'])
    );
    expect(item.targetCandidates.some((c) => c.label.includes('Fashion x 初夏'))).toBe(true);
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'FINISH_CAPTURE' }, {}, r)));
  });

  test('Amazonの旧商品URLキーに保存済みのAIメモをASIN正規化キーへ移行する', async ({ page }) => {
    const oldKey = 'https://www.amazon.com/Some-Product-Name/dp/B012345678';
    const canonicalKey = 'https://www.amazon.com/dp/B012345678';
    await page.route(`${canonicalKey}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
          <div data-asin="B012345678" style="position:fixed;left:60px;top:120px;width:420px;height:220px">
            Amazon migrated card
          </div>
        </body></html>`,
      })
    );
    await page.goto(canonicalKey);
    await page.addScriptTag({ content: CHROME_STUB });
    await page.evaluate(
      ({ oldKey }) => {
        window.__store.aiAdvisorAnnotations = {
          [oldKey]: [
            {
              id: 'legacy-amazon',
              kind: 'drawing',
              createdAt: new Date().toISOString(),
              note: '旧URLで保存されたメモ',
              anchor: {
                selector: '[data-asin="B012345678"]',
                tag: 'div',
                role: 'div',
                text: 'Amazon migrated card',
                dataAsin: 'B012345678',
              },
              shapes: [{ type: 'rect', x: 0.02, y: 0.08, w: 0.4, h: 0.5, color: '#ef4444', width: 3 }],
            },
          ],
        };
      },
      { oldKey }
    );
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });

    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);
    await expect(memo.locator('.bag-memo-text')).toHaveValue('旧URLで保存されたメモ');
    expect(
      await page.evaluate(
        ({ oldKey, canonicalKey }) => {
          const map = window.__store.aiAdvisorAnnotations || {};
          return {
            hasOld: Object.prototype.hasOwnProperty.call(map, oldKey),
            hasCanonical: Object.prototype.hasOwnProperty.call(map, canonicalKey),
            note: map[canonicalKey]?.[0]?.note,
          };
        },
        { oldKey, canonicalKey }
      )
    ).toEqual({ hasOld: false, hasCanonical: true, note: '旧URLで保存されたメモ' });

    await memo.locator('.bag-memo-text').fill('正規キーへ移行したメモ');
    await memo.locator('.bag-memo-text').blur();
    await expect
      .poll(() =>
        page.evaluate(
          ({ oldKey, canonicalKey }) => {
            const map = window.__store.aiAdvisorAnnotations || {};
            return {
              hasOld: Object.prototype.hasOwnProperty.call(map, oldKey),
              hasCanonical: Object.prototype.hasOwnProperty.call(map, canonicalKey),
              note: map[canonicalKey]?.[0]?.note,
            };
          },
          { oldKey, canonicalKey }
        )
      )
      .toEqual({ hasOld: false, hasCanonical: true, note: '正規キーへ移行したメモ' });
  });

  // 同じ#target上に2つ別色で描き、番号バッジ/引き出し線/メモ枠が図形色で束ねられること、
  // 生成直後にホバー無しで他メモが減光しないこと、ホバーで対象ペアが強調・他が減光することを検証する。
  test('番号と図形色でペアが束ねられ、生成直後に減光が残らずホバーで相互ハイライトする', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });

    // 1つ目: 既定色(赤)を#target(60,300)に描く
    await drawRectAndFinish(page);
    // 2つ目: 別要素#target2(60,500)を用意し、青(#3b82f6)で描く(メモが重ならないよう分離)。
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'target2';
      b.textContent = 'CTA2';
      b.style.cssText = 'position:fixed;left:60px;top:500px;width:160px;height:48px';
      document.body.appendChild(b);
    });
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'START_DRAWING' }, {}, r)));
    await page.locator('.bag-draw-tool[data-tool="rect"]').click();
    await page.locator('.bag-draw-color').nth(4).click();
    await page.mouse.move(66, 506);
    await page.mouse.down();
    await page.mouse.move(150, 528, { steps: 5 });
    await page.mouse.move(205, 540, { steps: 5 });
    await page.mouse.up();
    await page.locator('.bag-draw-op[data-op="done"]').click();
    await saveDrawingMemo(page);
    // 生成直後の境界イベント対策でマウスを十分離す。
    await page.mouse.move(960, 760);

    const memos = page.locator('.bag-memo');
    await expect(memos).toHaveCount(2);

    // 図形のとなりに通し番号バッジ。メモヘッダにも同番号チップ。
    await expect(page.locator('.bag-anno-num')).toHaveCount(2);
    await expect(page.locator('.bag-anno-num').first()).toHaveText('1');
    await expect(memos.first().locator('.bag-memo-num')).toHaveText('1');

    // 図形色がメモ枠・引き出し線・番号バッジで共有される(1つ目=赤)。
    const red = 'rgb(239, 68, 68)';
    await expect(page.locator('.bag-anno-num').first()).toHaveCSS('background-color', red);
    await expect(memos.first()).toHaveCSS('border-top-color', red);
    await expect(page.locator('.bag-memo-connector').first()).toHaveCSS('stroke', red);

    // 回帰ガード: 生成直後(ホバー無し)はどのメモも減光されない。
    const opacities = await page.evaluate(() =>
      [...document.querySelectorAll('.bag-memo')].map((m) => Number(getComputedStyle(m).opacity))
    );
    expect(Math.min(...opacities)).toBeGreaterThan(0.99);

    // マウスを実際に動かして1つ目へホバー → 対象が強調・他が減光。
    const b0 = await memos.first().boundingBox();
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
    await page.mouse.move(b0.x + b0.width / 2 + 5, b0.y + b0.height / 2 + 4);
    await expect(memos.first()).toHaveClass(/bag-memo--active/);
    await expect(memos.nth(1)).toHaveClass(/bag-memo--dim/);

    // マウスを離すと減光が解除される(残らない)。
    await page.mouse.move(960, 760);
    await expect(memos.nth(1)).not.toHaveClass(/bag-memo--dim/);
  });

  // 左側に複数の図形があり右側に余白がある時も、各メモは画面端ではなく図形の隣に出て重ならない。
  test('複数メモも各図形のすぐ隣に配置され、互いに重ならない', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 820 });
    await page.evaluate(() => {
      for (const [id, top] of [
        ['gA', 120],
        ['gB', 320],
        ['gC', 520],
      ]) {
        const b = document.createElement('button');
        b.id = id;
        b.textContent = id;
        b.style.cssText = `position:fixed;left:60px;top:${top}px;width:160px;height:46px`;
        document.body.appendChild(b);
      }
    });
    const drawOver = async (y) => {
      await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'START_DRAWING' }, {}, r)));
      await page.locator('.bag-draw-tool[data-tool="rect"]').click();
      await page.mouse.move(66, y + 4);
      await page.mouse.down();
      await page.mouse.move(150, y + 22, { steps: 5 });
      await page.mouse.move(205, y + 38, { steps: 5 });
      await page.mouse.up();
      await page.locator('.bag-draw-op[data-op="done"]').click();
      await saveDrawingMemo(page);
      await page.mouse.move(1040, 780); // メモから離す
    };
    await drawOver(120);
    await drawOver(320);
    await drawOver(520);

    const memos = page.locator('.bag-memo');
    await expect(memos).toHaveCount(3);

    const boxes = [];
    for (let i = 0; i < 3; i += 1) {
      await expect(memos.nth(i)).toHaveAttribute('data-side', 'right');
      boxes.push(await memos.nth(i).boundingBox());
    }
    // 各図形(右端およそ205px)の近くに出て、画面右端の遠いレールへ飛ばない。
    const lefts = boxes.map((b) => Math.round(b.x));
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(1);
    expect(Math.min(...lefts)).toBeGreaterThanOrEqual(205);
    expect(Math.max(...lefts)).toBeLessThanOrEqual(260);
    // メモ同士が縦に重ならない(上から順に、次のtop >= 前のbottom)。
    const sorted = boxes.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].height - 1);
    }
  });

  // 図形が画面右に寄っている場合は、画面外へ出さず左/下へ退避する。
  test('図形が画面右に寄っている場合は画面内の左/下へ退避する', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 760 });
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'rightTarget';
      b.textContent = 'R';
      b.style.cssText = 'position:fixed;left:560px;top:300px;width:200px;height:48px';
      document.body.appendChild(b);
    });
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'START_DRAWING' }, {}, r)));
    await page.locator('.bag-draw-tool[data-tool="rect"]').click();
    await page.mouse.move(566, 306);
    await page.mouse.down();
    await page.mouse.move(650, 328, { steps: 5 });
    await page.mouse.move(755, 340, { steps: 5 });
    await page.mouse.up();
    await page.locator('.bag-draw-op[data-op="done"]').click();
    await saveDrawingMemo(page);
    await page.mouse.move(850, 720);

    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);
    const side = await memo.getAttribute('data-side');
    expect(['left', 'bottom']).toContain(side);
  });

  // ヘッダ(タグ部分)を掴んでドラッグするとメモが移動し、図形ボックス相対オフセット(memoPos)が
  // storage に保存され、再描画(storage 再読込)後も同じ位置に復元される。
  test('ヘッダをドラッグするとメモが移動し、位置が保存され再描画後も復元される', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 780 });
    await drawRectAndFinish(page);
    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);
    await page.mouse.move(960, 740); // 生成直後の境界イベント対策で十分離す

    const before = await memo.boundingBox();
    // 'AIメモ'タグを掴んでドラッグする。
    const tag = memo.locator('.bag-memo-tag');
    const tb = await tag.boundingBox();
    const sx = tb.x + tb.width / 2;
    const sy = tb.y + tb.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 200, sy + 160, { steps: 8 });
    await page.mouse.move(sx - 320, sy + 240, { steps: 8 });
    await page.mouse.up();

    // 目に見えて移動している。
    const after = await memo.boundingBox();
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(80);
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(80);

    // memoPos(図形ボックス相対オフセット)が保存される。
    await expect
      .poll(() =>
        page.evaluate(() => {
          const map = window.__store.aiAdvisorAnnotations || {};
          const scope = location.origin + location.pathname;
          const a = (map[scope] || []).find((x) => x.kind === 'drawing');
          return a && a.memoPos && Number.isFinite(a.memoPos.dx) && Number.isFinite(a.memoPos.dy) ? 'yes' : 'no';
        })
      )
      .toBe('yes');

    // storage から再読込して再描画(再訪相当)→ 手動位置が復元される。
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'LIST_ANNOTATIONS' }, {}, r)));
    const restored = page.locator('.bag-memo');
    await expect(restored).toHaveCount(1);
    const rb = await restored.boundingBox();
    expect(Math.abs(rb.x - after.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(rb.y - after.y)).toBeLessThanOrEqual(3);
  });

  // ドラッグで手動配置したメモは、ヘッダのダブルクリックで自動配置(右ガター/となり)に戻る。
  test('ヘッダのダブルクリックで覚えた位置を破棄して自動配置に戻る', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 780 });
    await drawRectAndFinish(page);
    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveAttribute('data-side', 'right'); // 既定は右側
    await page.mouse.move(960, 740);

    // まずドラッグして手動配置にする。
    const tag = memo.locator('.bag-memo-tag');
    const tb = await tag.boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x - 260, tb.y + 180, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const map = window.__store.aiAdvisorAnnotations || {};
          const scope = location.origin + location.pathname;
          return (map[scope] || []).find((x) => x.kind === 'drawing')?.memoPos ? 'has' : 'none';
        })
      )
      .toBe('has');

    // ヘッダ左側(タグ付近)をダブルクリック → memoPos が消え、自動配置へ戻る。
    await memo.locator('.bag-memo-head').dblclick({ position: { x: 6, y: 8 } });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const map = window.__store.aiAdvisorAnnotations || {};
          const scope = location.origin + location.pathname;
          return (map[scope] || []).find((x) => x.kind === 'drawing')?.memoPos ? 'has' : 'none';
        })
      )
      .toBe('none');
    await expect(memo).toHaveAttribute('data-side', 'right');
  });

  // 回帰ガード(フォーカスのハズレ): お描き後にAIメモへ日本語(IME変換中)を入力している最中、
  // メモ保存→(サイドパネルの storage 監視経由で)LIST_ANNOTATIONS による再描画が走っても、
  // 入力中のテキストエリアが作り直されず、ノード同一性・本文・IME変換が保持されること。
  test('IME変換中はページ再描画でメモが作り直されず、フォーカス/本文が保たれる', async ({ page }) => {
    await drawRectAndFinish(page);
    await expect(page.locator('.bag-memo-text')).toHaveCount(1);

    // テキストエリアにマーク(JSプロパティ)を付け、フォーカスして「IME変換中」に本文を入れる。
    // CompositionEvent を実発火することで content 側の memoComposing=true を成立させる。
    await page.evaluate(() => {
      const ta = document.querySelector('.bag-memo-text');
      ta.__bagMark = 'm1';
      ta.focus();
      ta.dispatchEvent(new CompositionEvent('compositionstart'));
      ta.value = '見出しをみじかく';
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });

    // サイドパネルの storage 監視 → LIST_ANNOTATIONS 相当の再描画を起こす(これが従来フォーカスを奪っていた)。
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'LIST_ANNOTATIONS' }, {}, r)));

    // 同一ノードが生き残り(作り直されていない)、入力中の本文も保持されている。
    const survived = await page.evaluate(() => {
      const ta = document.querySelector('.bag-memo-text');
      return { mark: ta && ta.__bagMark, value: ta && ta.value, count: document.querySelectorAll('.bag-memo').length };
    });
    expect(survived.mark).toBe('m1'); // 作り直されればプロパティは消える
    expect(survived.value).toBe('見出しをみじかく');
    expect(survived.count).toBe(1);

    // 変換確定(compositionend)→blur で保存され、本文は失われない。
    await page.evaluate(() => {
      const ta = document.querySelector('.bag-memo-text');
      ta.dispatchEvent(new CompositionEvent('compositionend'));
      ta.blur();
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const map = window.__store.aiAdvisorAnnotations || {};
          const scope = location.origin + location.pathname;
          return (map[scope] || []).find((a) => a.kind === 'drawing')?.note;
        })
      )
      .toBe('見出しをみじかく');

    // 保存後に再描画(再訪相当)しても本文が残る。
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'LIST_ANNOTATIONS' }, {}, r)));
    await expect(page.locator('.bag-memo-text')).toHaveValue('見出しをみじかく');
  });

  // 回帰ガード: 補足フォームを1欄化した後も、AIが作った目印(marker)を編集すると目的(intent)が
  // その1欄に出て編集でき、保存しても種類・名前・枠線は保持される(空欄化・データ破壊しない)。
  test('AI作成の目印を簡素化フォームで編集してもintentを編集でき、種類/名前は保持される', async ({ page }) => {
    await page.evaluate(() => {
      const scope = location.origin + location.pathname;
      window.__store.aiAdvisorAnnotations = {
        [scope]: [
          {
            id: 'marker-1',
            kind: 'marker',
            createdAt: new Date().toISOString(),
            name: '送信ボタン',
            intent: 'フォームを送信する',
            outline: true,
            anchor: { selector: '#target', tag: 'button', role: 'button', text: 'CTAボタン' },
          },
        ],
      };
    });
    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'LIST_ANNOTATIONS' }, {}, r)));

    await page.evaluate(() => new Promise((r) => window.__bagListener({ type: 'EDIT_ANNOTATION', id: 'marker-1' }, {}, r)));
    const author = page.locator('.bag-author');
    await expect(author).toBeVisible();
    // 1欄(AI向けの内容)に目印の目的(intent)が出る。種類セレクタは無い。空欄ではない。
    await expect(author.locator('[data-f="kind"]')).toHaveCount(0);
    await expect(author.locator('[data-f="note"]')).toHaveValue('フォームを送信する');

    await author.locator('[data-f="note"]').fill('フォームを正しく送信する');
    await author.locator('[data-f="save"]').click();
    await expect(author).toHaveCount(0);

    const saved = await page.evaluate(() => {
      const map = window.__store.aiAdvisorAnnotations || {};
      const scope = location.origin + location.pathname;
      return (map[scope] || []).find((a) => a.id === 'marker-1');
    });
    expect(saved.kind).toBe('marker'); // noteに化けない
    expect(saved.name).toBe('送信ボタン'); // 識別子(名前)は保持
    expect(saved.intent).toBe('フォームを正しく送信する'); // AI向けの内容を更新
    expect(saved.outline).toBe(true); // 目印の枠線体裁を保持
  });
});
