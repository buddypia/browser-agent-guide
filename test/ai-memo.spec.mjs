// お描き完了で、図形のすぐ隣に編集可能な「AIメモ」がページ上に生成され、
// 本文編集・forAIトグル・削除・件数・再配置・forAIによる文脈除外が正しく働くことを検証する。
// content/content-script.js を chrome スタブ付きで直接注入して実ブラウザDOMで確認する。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');

// 左側に明確な対象要素(#target)を置き、その上にお描きする。
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
  <button id="target" style="position:fixed;left:60px;top:300px;width:160px;height:48px">CTAボタン</button>
</body></html>`;

// chrome スタブ。storage はメモリ実装で、保存内容を window.__store から検証できる。
const CHROME_STUB = `
  window.__bagListener = null;
  window.__store = {};
  const __clone = (v) => (v === undefined ? undefined : structuredClone(v));
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
      sendMessage: (_msg, cb) => { if (typeof cb === 'function') cb({ ok: true }); },
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

async function drawRectAndFinish(page) {
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
}

test.describe('お描き連動のAIメモ', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(PAGE_HTML);
    await page.addScriptTag({ content: CHROME_STUB });
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });
  });

  test('お描き完了で図形の隣に編集可能なAIメモが生成され保存される', async ({ page }) => {
    await drawRectAndFinish(page);

    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);
    // メモは編集用テキストとforAIトグルを持つ。
    await expect(memo.locator('.bag-memo-text')).toBeVisible();
    await expect(memo.locator('.bag-memo-toggle input')).toBeChecked(); // forAI 既定ON

    // 図形(SVG)も永続レイヤに描かれている。
    await expect(page.locator('.bag-draw-layer .bag-draw-g rect')).toHaveCount(1);

    // 本文を編集すると storage(aiAdvisorAnnotations)へ保存される。
    await memo.locator('.bag-memo-text').fill('見出しをもっと短く');
    await memo.locator('.bag-memo-text').blur();
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

  test('メモは図形の隣(右既定)に置かれ、引き出し線で結ばれる', async ({ page }) => {
    // 右側に余白を確保するため広いビューポートにする(既定の390pxではメモ240pxが右に収まらない)。
    await page.setViewportSize({ width: 1000, height: 780 });
    await drawRectAndFinish(page);
    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);

    const box = await memo.boundingBox();
    // #target は左側(~60-220px)。右側に余白があるので、メモは図形の右隣に出る。
    expect(box.x).toBeGreaterThan(220);
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

  test('削除でメモと図形が消え、保存からも除かれる', async ({ page }) => {
    await drawRectAndFinish(page);
    await expect(page.locator('.bag-memo')).toHaveCount(1);
    await page.locator('.bag-memo .bag-memo-del').click();

    await expect(page.locator('.bag-memo')).toHaveCount(0);
    await expect(page.locator('.bag-draw-layer .bag-draw-g')).toHaveCount(0);
    const remaining = await page.evaluate(() => {
      const map = window.__store.aiAdvisorAnnotations || {};
      const scope = location.origin + location.pathname;
      return (map[scope] || []).length;
    });
    expect(remaining).toBe(0);
  });

  test('畳むとバッジになり、再度クリックで展開する(密集回避)', async ({ page }) => {
    await drawRectAndFinish(page);
    const memo = page.locator('.bag-memo');
    await memo.locator('.bag-memo-collapse').click();
    await expect(memo).toBeHidden();
    await expect(page.locator('.bag-memo-badge')).toBeVisible();
    await page.locator('.bag-memo-badge').click();
    await expect(memo).toBeVisible();
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

  // 左側に複数の図形があり右側に余白がある時、メモは右レール(右ガター)に縦整列し重ならない。
  test('右ガター整列: 右に余白があれば複数メモが右レールに縦整列し、互いに重ならない', async ({ page }) => {
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
    // 全メモが同じ左端(右レール)に整列し、右側に寄っている。
    const lefts = boxes.map((b) => Math.round(b.x));
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(1);
    expect(Math.min(...lefts)).toBeGreaterThan(600);
    // メモ同士が縦に重ならない(上から順に、次のtop >= 前のbottom)。
    const sorted = boxes.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].height - 1);
    }
  });

  // 図形が画面右まで広がり右レールと重なる場合は、ガターを使わず図形のとなりへ退避する。
  test('図形が画面右に寄っている場合は右ガターを使わず図形のとなりへ退避する', async ({ page }) => {
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
    await page.mouse.move(850, 720);

    const memo = page.locator('.bag-memo');
    await expect(memo).toHaveCount(1);
    // 右レール(644〜)は図形右端(~760)と重なるため、右ガターは無効 → 左/下へ退避。
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
    // 畳むボタン(ヘッダ右端)を避け、'AIメモ'タグを掴んでドラッグする。
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
});
