// コンテンツスクリプト: 対象ページ内で動く「動詞レジストリ」と実行器。
// AIが選んだ動詞を決定的に実行し、安定したaffordance IDを付与してAI協調を可能にする。
// ※ 通常のスクリプト(モジュール非対応)。グローバルを汚さないようIIFEで包む。

(() => {
  if (window.__AI_ADVISOR_INSTALLED__) return; // 二重注入防止
  window.__AI_ADVISOR_INSTALLED__ = true;

  // 仕込んだボタン等のクリック履歴(AIが後で読み取る手がかり)
  const signalLog = [];
  // 同一ページ読込内でのレシピ二重適用を防ぐための署名
  let appliedRecipeSig = null;

  // ---- i18n: ロケール辞書をサービスワーカー経由で受け取り、同期 t() で描画する ----
  // content script は非モジュールIIFEで sidepanel/i18n.js を import できず、ページ由来の fetch は
  // web_accessible_resources を要する。そこで拡張オリジンを持つ SW に辞書を要求し、ここでは同期解決する。
  // ※ AI へ渡すテキスト(動詞カタログ・図形の説明・文脈エクスポート)は対象外で日本語のまま。
  let i18nMessages = {};
  let i18nFallback = {};
  let i18nLoaded = false;
  let i18nLoadPromise = null;
  function t(key, vars) {
    const tpl = i18nMessages[key] ?? i18nFallback[key] ?? key;
    return String(tpl).replace(/\{(\w+)\}/g, (m, name) =>
      vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
    );
  }
  async function loadI18n({ force = false } = {}) {
    if (i18nLoadPromise) {
      if (!force) return i18nLoadPromise;
      await i18nLoadPromise;
    }
    if (i18nLoaded && !force) return;
    i18nLoadPromise = (async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'GET_I18N' });
        if (res?.ok && res.result) {
          const nextMessages = res.result.messages || {};
          const nextFallback = res.result.fallback || {};
          if (Object.keys(nextMessages).length || Object.keys(nextFallback).length) {
            i18nMessages = nextMessages;
            i18nFallback = nextFallback;
            i18nLoaded = true;
          }
        }
      } catch {
        /* SW未起動などはキー素通しで描画し、次回の更新で反映する */
      } finally {
        i18nLoadPromise = null;
      }
    })();
    return i18nLoadPromise;
  }

  // @term: affordance  (用語定義: glossary/extension/affordance.md)
  const ATTR = {
    id: 'data-bag-id',
    // @endterm: affordance
    role: 'data-bag-role',
    intent: 'data-bag-intent',
    intentSrc: 'data-bag-intent-src',
    injected: 'data-bag-injected',
    anno: 'data-bag-anno',
    ui: 'data-bag-ui',
    annoMarked: 'data-bag-anno-marked',
    annoOutline: 'data-bag-anno-outline',
  };

  const CHAT_BLOCKED_VERBS = new Set(['defineMarker', 'setStyle', 'removeElement']);
  const RECIPE_BLOCKED_VERBS = new Set(['defineMarker', 'setStyle', 'removeElement']);
  // 自動実行(autorun)は deny-by-default の allow-list。手順実行に必要な
  // 読み取り/スクロール/入力/(ガード付き)クリックだけ許可し、submitForm/navigateTo/inject*/
  // setStyle/removeElement/お描き系 等は拒否する。lib/workflow.js の AUTORUN_ALLOWED_VERBS と一致必須。
  const AUTORUN_ALLOWED_VERBS = new Set([
    'listAffordances', 'readText', 'extractData', 'readSignals', 'scrollToElement',
    'highlightElement', 'focusElement', 'waitForElement', 'explainWorkflow', 'listAnnotations',
    'exportContext', 'notify', 'noop',
    'clickAffordance', 'clickElement', 'fillAffordance', 'fillInput', 'selectOption',
  ]);
  // autorun で「対象ラベルが確定/購入系、または名前不明なら保留」する対象動詞(クリック系)。
  const AUTORUN_GUARD_VERBS = new Set(['clickAffordance', 'clickElement']);
  // 不可逆/確定系ラベル。lib/workflow.js の IRREVERSIBLE_KEYWORDS と一致必須(test がパリティ検査)。
  // ★ページ送り語(続行/続ける/進む/次へ/continue/proceed/next)は含めない(lib 側コメント参照)。
  const IRREVERSIBLE_KEYWORDS = [
    '確定', '確認', '決定', '同意', '購入', '買う', '今すぐ', '注文', '支払', '決済', '課金', '請求',
    '送金', '振込', '振り込み', '送信', '削除', '退会', '解約', '申込', '申し込み', 'チェックアウト',
    '予約', '登録', '寄付', 'サインアップ',
    'buy', 'purchase', 'order', 'place order', 'place your order', 'complete order', 'checkout', 'check out',
    'pay', 'payment', 'submit', 'confirm', 'agree', 'subscribe', 'sign up',
    'signup', 'donate', 'transfer', 'send money', 'book now', 'remove', 'delete',
  ];
  function isIrreversibleLabel(label) {
    const s = String(label || '').toLowerCase();
    return !!s && IRREVERSIBLE_KEYWORDS.some((kw) => s.includes(kw.toLowerCase()));
  }
  // autorun ガード用のラベル解決: labelOf に加え aria-labelledby / title / 子img[alt] も見る。
  // 名前が一切取れない(アイコンのみ等)場合は空を返し、ガード側で保留させる(fail-safe)。
  function guardLabelOf(el) {
    try {
      const base = labelOf(el);
      if (base && base.trim()) return base;
      const lb = el.getAttribute && el.getAttribute('aria-labelledby');
      if (lb) {
        const s = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
        if (s) return s;
      }
      const title = el.getAttribute && el.getAttribute('title');
      if (title && title.trim()) return title;
      const img = el.querySelector && el.querySelector('img[alt]');
      const alt = img && img.getAttribute('alt');
      if (alt && alt.trim()) return alt;
    } catch {
      /* 解決失敗は空扱い(保留) */
    }
    return '';
  }
  const MAX_INJECTED_TEXT_CHARS = 50000;

  // ---- 要素解決ヘルパー(優先: aiId > selector > injectedId) ----
  function getEl(args = {}) {
    if (args.aiId) {
      const el = document.querySelector(`[${ATTR.id}="${cssEscape(args.aiId)}"]`);
      if (el) return el;
    }
    if (args.id) {
      const el =
        document.getElementById(args.id) ||
        document.querySelector(`[${ATTR.injected}="${cssEscape(args.id)}"]`);
      if (el) return el;
    }
    if (args.selector) {
      const el = document.querySelector(args.selector);
      if (el) return el;
    }
    return null;
  }

  function requireEl(args) {
    const el = getEl(args);
    if (!el) throw new Error(t('cs.err.elementNotFound', { args: JSON.stringify(args) }));
    return el;
  }

  function cssEscape(s) {
    return String(s).replace(/"/g, '\\"');
  }

  function cssAttr(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // ---- affordance(操作可能要素)の決定的な注釈付け ----
  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    'summary',
    '[onclick]',
  ].join(',');

  const REFERENCE_TARGET_SELECTOR = [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    '[role="heading"]',
    'main[aria-label]',
    '[role="main"][aria-label]',
    'section[aria-label]',
    'section[aria-labelledby]',
    '[role="region"][aria-label]',
  ].join(',');

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return 'input-' + (el.getAttribute('type') || 'text');
    return tag;
  }

  function labelOf(el) {
    if (!el || el.nodeType !== 1) return ''; // nearestLink等が null を返す場合に getAttribute で落ちない
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const text = (el.innerText || el.textContent || '').trim();
    if (text) return text.replace(/\s+/g, ' ');
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    if (['button', 'submit', 'reset', 'image'].includes(inputType)) {
      const visibleValue = el.value || el.getAttribute('value') || el.getAttribute('alt') || '';
      if (visibleValue.trim()) return visibleValue.trim();
    }
    return (
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.value ||
      el.getAttribute('name') ||
      ''
    ).trim();
  }

  function referenceLabelOf(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (label) return label.replace(/\s+/g, ' ');
    }
    return labelOf(el);
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isOwnUi(el) {
    return Boolean(el?.closest?.(`[${ATTR.ui}],[${ATTR.injected}],[${ATTR.anno}]`));
  }

  // ページを走査し、role+連番で安定したaiIdを割り当てる。順序は文書順で決定的。
  // ※ ユーザーが付けた「目印(marker)」を持つ要素は、その人間可読な名前を優先して保持する
  //   (連番IDは要素の増減でズレるため、決定的な参照は marker を使うのが望ましい)。
  function annotatePage() {
    const counters = {};
    const list = [];
    const els = document.querySelectorAll(INTERACTIVE_SELECTOR);
    els.forEach((el) => {
      if (!isVisible(el)) return;
      if (isOwnUi(el)) return; // 拡張自身のUI(お描きツールバー/AIメモ等)はaffordanceに含めない
      const role = roleOf(el);
      // 目印付き要素は人間が付けた決定的な名前を維持する。
      if (el.hasAttribute(ATTR.annoMarked)) {
        list.push({
          aiId: el.getAttribute(ATTR.id) || `${role}#marked`,
          role: el.getAttribute(ATTR.role) || role,
          label: labelOf(el),
          intent: el.getAttribute(ATTR.intent) || '',
          value: 'value' in el ? String(el.value || '') : '',
        });
        return;
      }
      counters[role] = (counters[role] || 0) + 1;
      const aiId = `${role}#${counters[role]}`;
      el.setAttribute(ATTR.id, aiId);
      list.push({
        aiId,
        role,
        label: labelOf(el),
        value: 'value' in el ? String(el.value || '') : '',
      });
    });
    return list;
  }

  function collectAffordances() {
    return annotatePage();
  }

  function referenceRoleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  }

  function targetIdBase(el, label) {
    const role = referenceRoleOf(el);
    const level =
      el.getAttribute('aria-level') ||
      (/^H[1-6]$/.test(el.tagName) ? el.tagName.slice(1) : '');
    const kind = role === 'heading' ? 'heading' : role || el.tagName.toLowerCase();
    const slug = slugForId(label) || hashText(label || el.tagName.toLowerCase());
    return `${kind}${level ? level : ''}:${slug}`;
  }

  function groupIdBase(label) {
    return `group:${slugForId(label) || hashText(label || 'group')}`;
  }

  function slugForId(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’‘`]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  function hashText(text) {
    let hash = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i += 1) {
      hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    }
    return `text-${hash.toString(36)}`;
  }

  function uniqueId(base, seen) {
    let id = base;
    let n = 2;
    while (seen.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    seen.add(id);
    return id;
  }

  function collectReferenceTargets() {
    const seen = new Set();
    const list = [];
    const seenEls = new Set();
    collectHeadingGroups(seen, seenEls, list);
    const els = document.querySelectorAll(REFERENCE_TARGET_SELECTOR);
    els.forEach((el) => {
      if (!isVisible(el) || isOwnUi(el) || el.matches(INTERACTIVE_SELECTOR)) return;
      if (seenEls.has(el)) return;
      const label = referenceLabelOf(el).replace(/\s+/g, ' ').trim();
      if (!label) return;
      const existing = el.getAttribute(ATTR.id);
      const aiId = existing || uniqueId(targetIdBase(el, label), seen);
      seen.add(aiId);
      el.setAttribute(ATTR.id, aiId);
      if (!el.hasAttribute(ATTR.role)) el.setAttribute(ATTR.role, referenceRoleOf(el));
      list.push({
        aiId,
        role: el.getAttribute(ATTR.role) || referenceRoleOf(el),
        label,
        tag: el.tagName.toLowerCase(),
        level: el.getAttribute('aria-level') || (/^H[1-6]$/.test(el.tagName) ? el.tagName.slice(1) : ''),
      });
    });
    return list;
  }

  function collectHeadingGroups(seen, seenEls, list) {
    const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]');
    headings.forEach((heading) => {
      if (!isVisible(heading) || isOwnUi(heading)) return;
      const label = referenceLabelOf(heading).replace(/\s+/g, ' ').trim();
      if (!label) return;
      const group = findHeadingGroup(heading, label);
      if (!group || seenEls.has(group) || !isVisible(group) || isOwnUi(group)) return;
      const aiId = group.getAttribute(ATTR.id) || uniqueId(groupIdBase(label), seen);
      seen.add(aiId);
      seenEls.add(group);
      group.setAttribute(ATTR.id, aiId);
      group.setAttribute(ATTR.role, 'group');
      list.push({
        aiId,
        role: 'group',
        label: `${label} group`,
        tag: group.tagName.toLowerCase(),
        level: '',
      });
    });
  }

  function findHeadingGroup(heading, label) {
    const tokens = slugForId(label).split('-').filter((t) => t.length > 2);
    let fallback = null;
    let cur = heading.parentElement;
    for (let depth = 0; cur && cur !== document.body && cur !== document.documentElement && depth < 5; depth += 1) {
      if (!fallback && cur.children.length > 1) fallback = cur;
      const key = `${cur.id || ''} ${cur.className || ''}`.toLowerCase();
      if (tokens.some((token) => key.includes(token))) return cur;
      cur = cur.parentElement;
    }
    return fallback;
  }

  // ---- ページ内トースト ----
  function toast(message, level = 'info') {
    let host = document.getElementById('bag-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'bag-toast-host';
      host.className = 'bag-toast-host';
      document.documentElement.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `bag-toast bag-toast--${level}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.classList.add('bag-toast--in'), 10);
    setTimeout(() => {
      el.classList.remove('bag-toast--in');
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  // @term: verb-registry  (用語定義: glossary/extension/verb-registry.md。この領域を変えたら last_verified を更新)
  // ---- 動詞レジストリ(関数名はすべて動詞) ----
  // 各動詞: { description, args:{名前:説明}, run:async(args)=>戻り値 }
  const AI_VERBS = {
    annotatePage: {
      description: 'ページを走査し、操作可能要素に安定したaiIdを付与して一覧を返す。',
      args: {},
      run: async () => ({ count: annotatePage().length }),
    },
    listAffordances: {
      description: '現在の操作可能要素(aiId/役割/ラベル)の一覧を返す。',
      args: {},
      run: async () => ({ affordances: collectAffordances() }),
    },
    readText: {
      description: '要素のテキストを読み取る。',
      args: { aiId: '対象のaiId(任意)', selector: 'CSSセレクタ(任意)' },
      run: async (a) => ({ text: (requireEl(a).innerText || '').trim() }),
    },
    extractData: {
      description: '複数フィールドのテキストをまとめて抽出する。',
      args: { fields: '{名前: CSSセレクタ} の辞書' },
      run: async (a) => {
        const out = {};
        for (const [name, sel] of Object.entries(a.fields || {})) {
          const el = document.querySelector(sel);
          out[name] = el ? (el.innerText || '').trim() : null;
        }
        return { data: out };
      },
    },
    readSignals: {
      description: '仕込んだボタン等がクリックされた履歴(手がかり)を返す。',
      args: {},
      run: async () => ({ signals: signalLog.slice() }),
    },
    clickAffordance: {
      description: 'aiIdで指定した要素をクリックする(推奨)。',
      args: { aiId: '対象のaiId' },
      run: async (a) => {
        const el = requireEl(a);
        el.click();
        return { clicked: a.aiId || a.selector };
      },
    },
    clickElement: {
      description: 'CSSセレクタで指定した要素をクリックする。',
      args: { selector: 'CSSセレクタ' },
      run: async (a) => {
        requireEl(a).click();
        return { clicked: a.selector };
      },
    },
    fillAffordance: {
      description: 'aiIdの入力欄に値を入れinput/changeを発火する(推奨)。',
      args: { aiId: '対象のaiId', value: '入力値' },
      run: async (a) => fillValue(requireEl(a), a.value),
    },
    fillInput: {
      description: 'CSSセレクタの入力欄に値を入れる。',
      args: { selector: 'CSSセレクタ', value: '入力値' },
      run: async (a) => fillValue(requireEl(a), a.value),
    },
    selectOption: {
      description: 'select要素で指定値(value/ラベル)を選択する。',
      args: { aiId: 'aiId(任意)', selector: 'セレクタ(任意)', value: 'value または表示テキスト' },
      run: async (a) => {
        const el = requireEl(a);
        const opt = Array.from(el.options).find(
          (o) => o.value === a.value || o.text.trim() === String(a.value).trim()
        );
        if (!opt) throw new Error(t('cs.err.optionNotFound', { value: a.value }));
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: opt.value };
      },
    },
    submitForm: {
      description: '要素が属するフォームを送信する。',
      args: { aiId: 'aiId(任意)', selector: 'セレクタ(任意)' },
      run: async (a) => {
        const el = requireEl(a);
        const form = el.tagName === 'FORM' ? el : el.closest('form');
        if (!form) throw new Error(t('cs.err.formNotFound'));
        form.requestSubmit ? form.requestSubmit() : form.submit();
        return { submitted: true };
      },
    },
    focusElement: {
      description: '要素にフォーカスする。',
      args: { aiId: 'aiId(任意)', selector: 'セレクタ(任意)' },
      run: async (a) => {
        requireEl(a).focus();
        return { focused: true };
      },
    },
    scrollToElement: {
      description: '要素まで滑らかにスクロールする。',
      args: { aiId: 'aiId(任意)', selector: 'セレクタ(任意)' },
      run: async (a) => {
        requireEl(a).scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { scrolled: true };
      },
    },
    highlightElement: {
      description: '要素を一時的に強調表示する。',
      args: { aiId: 'aiId(任意)', selector: 'セレクタ(任意)', color: '枠色(任意)' },
      run: async (a) => {
        const el = requireEl(a);
        const prev = el.style.outline;
        const prevOffset = el.style.outlineOffset;
        el.style.outline = `3px solid ${a.color || '#0f766e'}`;
        el.style.outlineOffset = '2px';
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
          el.style.outline = prev;
          el.style.outlineOffset = prevOffset;
        }, 2500);
        return { highlighted: true };
      },
    },
    outlineElement: {
      description:
        '要素を継続的な枠線で囲む。highlightElementと違い自動で消えない。チャット成功時は保存され再訪時に再適用される。',
      args: {
        aiId: 'aiId(任意)',
        selector: 'セレクタ(任意)',
        color: '枠色(省略時red)',
        width: '線幅px(省略時3px)',
        style: 'solid|dashed|dotted|double(省略時solid)',
        offset: '外側余白px(省略時4px)',
      },
      run: async (a) => outlineElement(a),
    },
    injectHtml: {
      description:
        'ユーザーが明示的に依頼した限定HTMLをページに挿入する。idで再挿入時は置き換える。チャット成功時は保存され再訪時に再適用される。',
      args: {
        html: '挿入するHTML文字列(class/id/style/script/event属性は除去される)',
        anchorSelector: '基準要素のCSSセレクタ(省略時はbody)',
        position: 'beforebegin|afterbegin|beforeend|afterend(省略時beforeend)',
        id: '識別子(省略可。再適用で置換)',
      },
      run: async (a) => injectHtml(a),
    },
    injectCss: {
      description:
        'ユーザーが明示的に依頼したCSSをページへ追加する。idで再挿入時は置き換える。チャット成功時は保存され再訪時に再適用される。',
      args: {
        css: '追加するCSS文字列',
        id: '識別子(省略可。再適用で置換)',
      },
      run: async (a) => injectCss(a),
    },
    injectScript: {
      description:
        'ユーザーが明示的に依頼したJavaScriptをページへ追加して実行する。idで再挿入時は置き換える。チャット成功時は保存され再訪時に再適用される。',
      args: {
        code: '実行するJavaScript文字列。ネットワーク送信や秘密情報の読み取りは禁止。',
        id: '識別子(省略可。再適用で置換)',
      },
      run: async (a) => injectScript(a),
    },
    injectButton: {
      description:
        'AIが後で理解できる「手がかりボタン」をページに仕込む。クリックでintentがシグナルに記録される。',
      args: {
        label: 'ボタン表示名',
        intent: 'このボタンの目的(AI向けの手がかり)',
        id: '識別子(省略可)',
        anchorSelector: '基準要素のセレクタ(省略時は画面右下に固定)',
        position: '挿入位置(anchor指定時)',
      },
      run: async (a) => injectButton(a),
    },
    injectPanel: {
      description: '画面右下に浮かぶ情報パネル(タイトル+限定HTML)を仕込む。',
      args: { title: 'タイトル', html: '本文HTML(class/id/style/script/event属性は除去される)', id: '識別子(省略可)' },
      run: async (a) => injectPanel(a),
    },
    defineMarker: {
      description:
        '既存要素にAI向けの目印(aiId/role/intent)を付与し、以後一貫して参照できるようにする。',
      args: {
        selector: '対象のCSSセレクタ',
        aiId: '付与するaiId',
        role: '役割(任意)',
        intent: '目的(任意)',
      },
      exposeToAI: false,
      recipeSafe: false,
      run: async (a) => {
        const el = document.querySelector(a.selector);
        if (!el) throw new Error(t('cs.err.markerTargetNotFound', { selector: a.selector }));
        if (a.aiId) el.setAttribute(ATTR.id, a.aiId);
        if (a.role) el.setAttribute(ATTR.role, a.role);
        if (a.intent) el.setAttribute(ATTR.intent, a.intent);
        return { marked: a.aiId || a.selector };
      },
    },
    setStyle: {
      description: '要素にインラインCSSを適用する。',
      args: { aiId: 'aiId(任意)', selector: 'セレクタ(任意)', styles: '{cssProp: value} の辞書' },
      exposeToAI: false,
      recipeSafe: false,
      run: async (a) => {
        const el = requireEl(a);
        for (const [k, v] of Object.entries(a.styles || {})) {
          el.style.setProperty(camelToKebab(k), v);
        }
        return { styled: true };
      },
    },
    removeElement: {
      description: '要素を削除する。',
      args: { aiId: 'aiId(任意)', selector: 'セレクタ(任意)', id: '注入要素のid(任意)' },
      exposeToAI: false,
      recipeSafe: false,
      run: async (a) => {
        const el = requireEl(a);
        el.remove();
        return { removed: true };
      },
    },
    waitForElement: {
      description: '要素が出現するまで待つ。',
      args: { selector: 'CSSセレクタ', timeoutMs: 'タイムアウトms(既定5000)' },
      run: async (a) => {
        const el = await waitFor(a.selector, a.timeoutMs || 5000);
        return { found: Boolean(el) };
      },
    },
    navigateTo: {
      description: '指定URLへ遷移する。',
      args: { url: '遷移先URL' },
      run: async (a) => {
        location.assign(a.url);
        return { navigating: a.url };
      },
    },
    goBack: {
      description: '履歴を1つ戻る。',
      args: {},
      run: async () => {
        history.back();
        return { back: true };
      },
    },
    notify: {
      description: 'ページ内にトースト通知を表示する。',
      args: { message: 'メッセージ', level: 'info|success|warn|error(任意)' },
      run: async (a) => {
        toast(a.message, a.level || 'info');
        return { notified: true };
      },
    },
    // ---- ユーザー注釈(永続化される補足・目印・合図ボタン) ----
    addNote: {
      description:
        '対象要素に補足コメントを付けて永続保存する。再訪時も復元され、AIへの文脈にも反映される。',
      args: {
        aiId: '対象のaiId(任意)',
        selector: 'CSSセレクタ(任意)',
        note: 'コメント本文(人/AI向けの補足)',
        intent: 'この箇所の目的(AI向け,任意)',
      },
      run: async (a) => {
        const el = getEl(a);
        if (!el) throw new Error(t('cs.err.targetNotFound'));
        return await upsertAnnotation({ kind: 'note', anchor: buildAnchor(el), note: a.note || '', intent: a.intent || '' });
      },
    },
    markElement: {
      description:
        '対象要素に決定的な「名前(目印)」と目的を付けて永続保存する。以後その名前で一貫・安定して参照できる(連番IDのズレを回避)。',
      args: {
        aiId: '対象のaiId(任意)',
        selector: 'CSSセレクタ(任意)',
        name: '付ける名前(例: 送信ボタン)',
        intent: 'この要素の目的(任意)',
      },
      run: async (a) => {
        const el = getEl(a);
        if (!el) throw new Error(t('cs.err.targetNotFound'));
        return await upsertAnnotation({
          kind: 'marker',
          anchor: buildAnchor(el),
          name: a.name || labelOf(el) || 'marker',
          intent: a.intent || '',
          outline: true,
        });
      },
    },
    addCueButton: {
      description:
        '永続する「合図ボタン」を要素の近く(または画面隅)に置く。人がクリックすると意図がシグナルとして記録され、AIが続きを理解できる。',
      args: {
        aiId: '対象のaiId(任意。placement=floating なら不要)',
        selector: 'CSSセレクタ(任意)',
        label: 'ボタン表示名',
        intent: 'このボタンの目的(AI向けの手がかり)',
        placement: 'floating で画面右下に固定(任意)',
      },
      run: async (a) => {
        const el = a.placement === 'floating' ? null : getEl(a);
        const anchor = el ? buildAnchor(el) : null;
        return await upsertAnnotation({
          kind: 'button',
          anchor,
          label: a.label || t('cs.button.cueDefault'),
          intent: a.intent || '',
          placement: a.placement || (anchor ? 'after' : 'floating'),
        });
      },
    },
    listAnnotations: {
      description: 'このページに保存済みの補足/目印/合図ボタンを一覧する。',
      args: {},
      run: async () => ({ annotations: annotations.map(annoSummary) }),
    },
    removeAnnotation: {
      description: '保存済みの補足をidで削除する。',
      args: { id: '注釈id' },
      run: async (a) => await deleteAnnotation(a.id),
    },
    exportContext: {
      description:
        '外部のブラウザ操作AI(別のChatUI)へ貼り付けるための、決定的なページ文脈テキストを生成して返す。',
      args: {},
      run: async () => ({ text: buildContextText() }),
    },
    startAnnotating: {
      description: 'ページ上で要素をクリックして補足を付ける「注釈モード」を開始する。',
      args: {},
      run: async () => startPicker(),
    },
    startDrawing: {
      description:
        'ページ上に円/四角/矢印/フリーハンドで印を描く「お描きモード」を開始する。描き終えて「完了」を押すと、図形のすぐ隣に編集可能な「AIメモ」がすぐに生成され、そのまま指示を書き込める。図形とメモは対象要素にアンカーされ永続保存され、再訪時に復元される。「AIに渡す」がONのメモだけがAIへの文脈に同梱される。',
      args: {},
      run: async () => startDrawing(),
    },
    explainWorkflow: {
      description:
        'ページ上の番号付きお描き(🖍)を通し番号の順に読み出し、操作手順(ワークフロー)として返す。各手順は 番号 / 対象要素 / 図形の説明 / メモ(指示) を含む。お描きで手順が示されたページで「手順を説明して」等と言われたら使う。',
      args: {},
      run: async () => buildWorkflowContext(),
    },
    addWorkflowStep: {
      description:
        '指定した要素を囲む番号付きお描き(手順)を1つ追加する。番号は既存の通し番号の続きで自動採番される。ユーザーが「手順を作って/番号を振って/ここを手順に追加して」と明示した時だけ使う。kind は ellipse(円)/rect(四角)/arrow(矢印)。',
      args: {
        aiId: '対象のaiId(推奨)',
        selector: 'CSSセレクタ(任意)',
        kind: '囲み方: ellipse / rect / arrow(既定 rect)',
        note: 'この手順の説明・指示(任意)',
        color: '色 hex(任意, 既定 青)',
      },
      run: async (a) => await addWorkflowStep(a),
    },
    noop: {
      description: '何もしない(操作不要時の明示)。',
      args: {},
      run: async () => ({ noop: true }),
    },
  };
  // @endterm: verb-registry

  // ---- 動詞実装の補助 ----
  function fillValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(el, value) : (el.value = value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true };
  }

  function injectHtml(a) {
    const id = a.id || autoId('html');
    removeInjected(id);
    const anchor = a.anchorSelector ? document.querySelector(a.anchorSelector) : document.body;
    if (!anchor) throw new Error(t('cs.err.anchorNotFound', { selector: a.anchorSelector }));
    const wrapper = document.createElement('div');
    wrapper.setAttribute(ATTR.injected, id);
    wrapper.appendChild(sanitizeHtmlFragment(assertInjectedText(a.html || '', 'HTML')));
    anchor.insertAdjacentElement(a.position && a.position !== 'beforeend' ? a.position : 'beforeend', wrapper)
      || anchor.appendChild(wrapper);
    return { injectedId: id };
  }

  function injectCss(a) {
    const id = a.id || autoId('css');
    const css = assertInjectedText(a.css || '', 'CSS');
    removeInjected(id);
    const style = document.createElement('style');
    style.type = 'text/css';
    style.setAttribute(ATTR.injected, id);
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    return { injectedId: id, bytes: css.length };
  }

  async function injectScript(a) {
    const id = a.id || autoId('js');
    const code = assertInjectedText(a.code || '', 'JavaScript');
    removeInjected(id);
    const result = await executeUserScript({ id, code });
    return { injectedId: id, bytes: code.length, executed: true, ...result };
  }

  function executeUserScript({ id, code }) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        reject(new Error(t('cs.err.scriptBgUnavailable')));
        return;
      }
      chrome.runtime.sendMessage({ type: 'EXECUTE_USER_SCRIPT', id, code }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || String(runtimeError)));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || t('cs.err.scriptFailed')));
          return;
        }
        resolve(response.result || {});
      });
    });
  }

  function outlineElement(a) {
    const el = requireEl(a);
    const width = safeCssPx(a.width, '3px', 1, 12);
    const offset = safeCssPx(a.offset, '4px', 0, 24);
    const style = safeOutlineStyle(a.style || 'solid');
    const color = safeCssColor(a.color || 'red', 'red');
    el.style.outlineWidth = width;
    el.style.outlineStyle = style;
    el.style.outlineColor = color;
    el.style.outlineOffset = offset;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { outlined: true, outline: `${width} ${style} ${color}`, offset };
  }

  function safeOutlineStyle(value) {
    const style = String(value || '').trim().toLowerCase();
    return ['solid', 'dashed', 'dotted', 'double'].includes(style) ? style : 'solid';
  }

  function safeCssPx(value, fallback, min, max) {
    const raw = String(value ?? '').trim();
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(px)?$/i);
    if (!match) return fallback;
    const n = Number(match[1]);
    if (!Number.isFinite(n)) return fallback;
    return `${Math.min(max, Math.max(min, n))}px`;
  }

  function safeCssColor(value, fallback) {
    const color = String(value || '').trim();
    if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
    if (/^[a-z]+$/i.test(color)) return color;
    if (/^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(color)) {
      return color;
    }
    if (/^hsla?\(\s*[\d.]+(?:deg)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(color)) {
      return color;
    }
    return fallback;
  }

  function assertInjectedText(value, label) {
    const text = String(value || '');
    if (!text.trim()) throw new Error(t('cs.err.injectedEmpty', { label }));
    if (text.length > MAX_INJECTED_TEXT_CHARS) {
      throw new Error(t('cs.err.injectedTooLong', { label, len: text.length, max: MAX_INJECTED_TEXT_CHARS }));
    }
    return text;
  }

  function injectButton(a) {
    const id = a.id || autoId('btn');
    removeInjected(id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bag-injected-btn';
    btn.textContent = a.label || t('cs.button.cueDefault');
    btn.setAttribute(ATTR.injected, id);
    btn.setAttribute(ATTR.id, `injected:${id}`);
    btn.setAttribute(ATTR.role, 'cue-button');
    btn.setAttribute(ATTR.intent, a.intent || '');
    btn.addEventListener('click', () => {
      signalLog.push({
        aiId: `injected:${id}`,
        intent: a.intent || a.label || id,
        at: new Date().toISOString(),
      });
      toast(t('cs.toast.signalRecorded', { label: a.label || id }), 'success');
    });
    if (a.anchorSelector) {
      const anchor = document.querySelector(a.anchorSelector);
      if (!anchor) throw new Error(t('cs.err.anchorNotFound', { selector: a.anchorSelector }));
      anchor.insertAdjacentElement(a.position || 'afterend', btn);
    } else {
      btn.classList.add('bag-floating');
      floatingHost().appendChild(btn);
    }
    return { injectedId: id, aiId: `injected:${id}` };
  }

  function injectPanel(a) {
    const id = a.id || autoId('panel');
    removeInjected(id);
    const panel = document.createElement('div');
    panel.className = 'bag-injected-panel';
    panel.setAttribute(ATTR.injected, id);
    const head = document.createElement('div');
    head.className = 'bag-panel-head';
    const title = document.createElement('span');
    title.textContent = a.title || t('cs.panel.defaultTitle');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'bag-panel-close';
    close.setAttribute('aria-label', t('cs.panel.closeAria'));
    close.textContent = '×';
    close.addEventListener('click', () => panel.remove());
    head.append(title, close);
    const body = document.createElement('div');
    body.className = 'bag-panel-body';
    body.appendChild(sanitizeHtmlFragment(a.html || ''));
    panel.append(head, body);
    floatingHost().appendChild(panel);
    return { injectedId: id };
  }

  function floatingHost() {
    let host = document.getElementById('bag-floating-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'bag-floating-host';
      host.className = 'bag-floating-host';
      document.documentElement.appendChild(host);
    }
    return host;
  }

  function removeInjected(id) {
    document.querySelectorAll(`[${ATTR.injected}="${cssEscape(id)}"]`).forEach((el) => el.remove());
  }

  let idCounter = 0;
  function autoId(prefix) {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
  }

  function camelToKebab(s) {
    return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const SAFE_HTML_TAGS = new Set([
    'A',
    'B',
    'BLOCKQUOTE',
    'BR',
    'CODE',
    'DIV',
    'EM',
    'I',
    'LI',
    'OL',
    'P',
    'PRE',
    'SMALL',
    'SPAN',
    'STRONG',
    'UL',
  ]);
  const DROP_HTML_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM']);

  function sanitizeHtmlFragment(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    sanitizeHtmlChildren(tpl.content);
    return tpl.content;
  }

  function sanitizeHtmlChildren(parent) {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node.remove();
        continue;
      }
      const tag = node.tagName;
      if (DROP_HTML_TAGS.has(tag)) {
        node.remove();
        continue;
      }
      sanitizeHtmlChildren(node);
      if (!SAFE_HTML_TAGS.has(tag)) {
        node.replaceWith(document.createTextNode(node.textContent || ''));
        continue;
      }
      sanitizeAttributes(node);
    }
  }

  function sanitizeAttributes(el) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      const allowed =
        name === 'title' ||
        name === 'aria-label' ||
        (el.tagName === 'A' && (name === 'href' || name === 'target' || name === 'rel'));
      if (!allowed || name.startsWith('on') || name === 'style' || name === 'class' || name === 'id' || name.startsWith('data-')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' && !isSafeHref(value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A' && el.getAttribute('target') === '_blank') {
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function isSafeHref(value) {
    const href = String(value || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('/')) return true;
    try {
      const url = new URL(href, location.href);
      return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
    } catch {
      return false;
    }
  }

  function waitFor(selector, timeoutMs) {
    // 不正なCSSセレクタでも throw せず「存在しない」として扱う(evalWhen と挙動を揃える)。
    // ここで reject すると runActions の try の外で await している呼び出しが
    // バッチ全体を巻き込んで失敗させてしまうため、必ず null/要素を resolve する。
    const query = () => {
      try {
        return document.querySelector(selector);
      } catch {
        return null;
      }
    };
    return new Promise((resolve) => {
      const existing = query();
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = query();
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(query());
      }, timeoutMs);
    });
  }

  // ===========================================================================
  // ユーザー注釈システム
  // 非エンジニアがページに「補足・目印・合図ボタン」を付け、ブラウザ操作AIへ
  // 決定的な文脈として渡すための仕組み。
  //   - サイト(オリジン+パス)単位で chrome.storage.local に永続化 → 再訪で必ず復元(再現性)
  //   - 要素は複数シグナルの堅牢アンカーで毎回再解決 → 軽微なDOM変化に強い(決定的)
  // ===========================================================================
  const ANNO_KEY = 'aiAdvisorAnnotations';
  // ページ跨ぎ「ワークフロー」記録用キー(lib/workflow.js と共有)。記録ON中に残したメモを
  // URLごと時系列(=URL順)で steps に積み、チャットで AI に一括で渡す。形は lib/workflow.js に合わせる。
  const WF_KEY = 'aiAdvisorWorkflow';
  let annotations = []; // 現在ページに適用中の注釈
  let lastUnresolved = 0; // 直近描画で未解決だった注釈数(再描画要否の判定に使用)

  function legacyScopeKey() {
    return location.origin + location.pathname;
  }

  function scopeKey() {
    return annotationScopeKey(location.href);
  }

  function scopeKeysForCurrentPage(map) {
    const key = scopeKey();
    const legacy = legacyScopeKey();
    const keys = [key];
    if (legacy !== key) keys.push(legacy);
    if (map && isAmazonHost(location.hostname)) {
      for (const storedKey of Object.keys(map).sort()) {
        if (storedKey === key || storedKey === legacy) continue;
        if (annotationScopeKey(storedKey) === key) keys.push(storedKey);
      }
    }
    return keys;
  }

  function annotationScopeKey(href) {
    try {
      const url = new URL(href);
      return amazonScopeKey(url) || `${url.origin}${url.pathname}`;
    } catch {
      return legacyScopeKey();
    }
  }

  function isAmazonHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return h === 'amazon.com' || h.includes('.amazon.');
  }

  function amazonScopeKey(url) {
    if (!isAmazonHost(url.hostname)) return '';
    const asin = amazonAsinFromPath(url.pathname);
    if (asin) return `${url.origin}/dp/${asin}`;
    if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
      const keep = new URLSearchParams();
      for (const key of ['i', 'k', 'rh', 'node', 'bbn', 'field-keywords']) {
        const val = url.searchParams.get(key);
        if (val) keep.set(key, val);
      }
      const qs = keep.toString();
      return `${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`;
    }
    return `${url.origin}${url.pathname}`;
  }

  function amazonAsinFromPath(pathname) {
    const m = String(pathname || '').match(/(?:^|\/)(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:\/|$)/i);
    return m ? m[1].toUpperCase() : '';
  }

  async function loadAnnotations() {
    try {
      const all = await chrome.storage.local.get(ANNO_KEY);
      const map = all[ANNO_KEY] || {};
      const key = scopeKey();
      const keys = scopeKeysForCurrentPage(map);
      const seen = new Set();
      annotations = [];
      for (const candidateKey of keys) {
        const list = Array.isArray(map[candidateKey]) ? map[candidateKey] : [];
        for (const a of list) {
          const id = a?.id || JSON.stringify(a);
          if (seen.has(id)) continue;
          seen.add(id);
          annotations.push(a);
        }
      }
      if (keys.some((candidateKey) => candidateKey !== key)) {
        if (annotations.length) map[key] = annotations;
        else delete map[key];
        for (const oldKey of keys) {
          if (oldKey !== key) delete map[oldKey];
        }
        await chrome.storage.local.set({ [ANNO_KEY]: map });
      }
    } catch {
      annotations = [];
    }
    return annotations;
  }

  async function persistAnnotations() {
    const all = await chrome.storage.local.get(ANNO_KEY);
    const map = all[ANNO_KEY] || {};
    const key = scopeKey();
    if (annotations.length) map[key] = annotations;
    else delete map[key];
    for (const oldKey of scopeKeysForCurrentPage(map)) {
      if (oldKey !== key) delete map[oldKey]; // 正規化キーへ自然移行する
    }
    await chrome.storage.local.set({ [ANNO_KEY]: map });
  }

  async function upsertAnnotation(anno) {
    if (!anno.id) anno.id = autoId('anno');
    anno.createdAt = anno.createdAt || new Date().toISOString();
    const i = annotations.findIndex((a) => a.id === anno.id);
    const saved = i >= 0 ? { ...annotations[i], ...anno } : anno;
    if (i >= 0) annotations[i] = saved;
    else annotations.push(saved);
    await persistAnnotations();
    notifyPageRemembered('annotation');
    await recordWorkflowStep(saved);
    renderAnnotations();
    if (saved.kind === 'drawing' || saved.kind === 'note') notifyVisualFeedbackChanged('upsert');
    return annoSummary(saved);
  }

  // ワークフロー記録ON中にメモ(note/お描き)を残したら、現在URLとともに1ステップを記録する。
  // 同じメモ(annoId)の再編集は同じステップを更新し、二重に積まない(冪等)。
  async function recordWorkflowStep(saved) {
    if (!saved || (saved.kind !== 'note' && saved.kind !== 'drawing')) return;
    let wf;
    try {
      const all = await chrome.storage.local.get(WF_KEY);
      wf = all[WF_KEY] || {};
    } catch {
      return;
    }
    if (wf.recording !== true) return;
    const steps = Array.isArray(wf.steps) ? wf.steps : [];
    const summary = annoSummary(saved);
    const step = {
      id: saved.id ? `wfs-${saved.id}` : autoId('wfs'),
      annoId: saved.id || '',
      url: location.href,
      matchType: 'page',
      pattern: annotationScopeKey(location.href),
      kind: saved.kind,
      text: saved.note || '',
      target: summary.target || '',
      createdAt: new Date().toISOString(),
    };
    const at = step.annoId ? steps.findIndex((s) => s && s.annoId === step.annoId) : -1;
    if (at >= 0) steps[at] = { ...steps[at], ...step };
    else steps.push(step);
    wf.steps = steps;
    try {
      await chrome.storage.local.set({ [WF_KEY]: wf });
    } catch {
      /* 記録の保存に失敗してもメモ自体は保存済みなので握りつぶす */
    }
  }

  // メモ削除時、それに紐づく記録ステップも取り除く(記録ON/OFFに関わらず掃除する)。
  async function unrecordWorkflowStep(annoId) {
    if (!annoId) return;
    try {
      const all = await chrome.storage.local.get(WF_KEY);
      const wf = all[WF_KEY] || {};
      const steps = Array.isArray(wf.steps) ? wf.steps : [];
      const next = steps.filter((s) => s && s.annoId !== annoId);
      if (next.length !== steps.length) {
        wf.steps = next;
        await chrome.storage.local.set({ [WF_KEY]: wf });
      }
    } catch {
      /* 掃除に失敗しても致命的でないので握りつぶす */
    }
  }

  function notifyPageRemembered(source) {
    try {
      chrome.runtime.sendMessage(
        { type: 'REMEMBER_PAGE', url: location.href, title: document.title, source },
        () => void chrome.runtime.lastError
      );
    } catch {
      /* 記憶通知に失敗しても補足保存自体は成功扱いにする */
    }
  }

  async function deleteAnnotation(id) {
    const removed = annotations.find((a) => a.id === id);
    annotations = annotations.filter((a) => a.id !== id);
    await persistAnnotations();
    await unrecordWorkflowStep(id);
    renderAnnotations();
    if (removed?.kind === 'drawing' || removed?.kind === 'note') notifyVisualFeedbackChanged('delete');
    return { removed: id };
  }

  function notifyVisualFeedbackChanged(reason) {
    // 送信対象 = お描き＋本文ありメモ（collectVisualFeedbackData の収集条件と一致させる）。
    const sendCount = annotations.filter(
      (a) => (a.kind === 'drawing' || (a.kind === 'note' && String(a.note || '').trim())) && memoForAI(a)
    ).length;
    try {
      chrome.runtime.sendMessage(
        { type: 'VISUAL_FEEDBACK_CHANGED', url: location.href, title: document.title, reason, sendCount },
        () => void chrome.runtime.lastError
      );
    } catch {
      /* 自動同期通知に失敗しても注釈保存自体は成功扱いにする */
    }
  }

  function annoSummary(a) {
    const t = a.anchor ? resolveAnchor(a.anchor) : null;
    const drawing = a.kind === 'drawing';
    return {
      id: a.id,
      kind: a.kind,
      name: a.name || '',
      label: a.label || '',
      note: a.note || '',
      intent: a.intent || '',
      shapeText: drawing ? describeShapes(a.shapes) : '',
      // 補足/お描きは番号付きの手順。AI・人間にステップ順を伝えるための通し番号。
      step: a.kind === 'note' ? annoNoteNumber(a) : drawing ? annoDrawingNumber(a) : undefined,
      // お描きメモは forAI 未設定の旧レコードを ON 扱いにして後方互換にする。
      forAI: drawing ? memoForAI(a) : undefined,
      shapePreview: drawing ? buildShapePreview(a.shapes) : undefined,
      target: t ? truncate(labelOf(t), 50) : '',
      resolved: Boolean(t) || a.placement === 'floating',
    };
  }

  // サイドパネルの「AI送信トレイ」用に、保存済み図形を小さなSVGへ描ける
  // 正規化データへ変換する。実ページ座標や大きな手書き点列は渡さない。
  function buildShapePreview(shapes) {
    const list = Array.isArray(shapes) ? shapes.filter(Boolean).slice(0, 4) : [];
    if (!list.length) return { color: DRAW_COLORS[0].hex, shapes: [] };
    const bbox = shapesBBoxFrac(list);
    const w = Math.max(0.001, bbox.maxX - bbox.minX);
    const h = Math.max(0.001, bbox.maxY - bbox.minY);
    const pad = 0.12;
    const scale = 1 - pad * 2;
    const normX = (x) => pad + ((Number(x) - bbox.minX) / w) * scale;
    const normY = (y) => pad + ((Number(y) - bbox.minY) / h) * scale;
    const color = list.find((s) => s.color)?.color || DRAW_COLORS[0].hex;
    const normalized = list.map((s) => {
      const base = { type: s.type, color: s.color || color };
      if (s.type === 'rect') {
        const x1 = normX(s.x);
        const y1 = normY(s.y);
        const x2 = normX((s.x || 0) + (s.w || 0));
        const y2 = normY((s.y || 0) + (s.h || 0));
        return { ...base, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      }
      if (s.type === 'ellipse') {
        const x1 = normX((s.cx || 0) - (s.rx || 0));
        const y1 = normY((s.cy || 0) - (s.ry || 0));
        const x2 = normX((s.cx || 0) + (s.rx || 0));
        const y2 = normY((s.cy || 0) + (s.ry || 0));
        return { ...base, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, rx: Math.abs(x2 - x1) / 2, ry: Math.abs(y2 - y1) / 2 };
      }
      if (s.type === 'arrow') {
        return { ...base, x1: normX(s.x1), y1: normY(s.y1), x2: normX(s.x2), y2: normY(s.y2) };
      }
      return {
        ...base,
        pts: decimatePoints(s.pts || [], 36).map(([x, y]) => [normX(x), normY(y)]),
      };
    });
    return { color, shapes: normalized };
  }

  // お描きメモが AI に渡される対象か。forAI 未設定(旧レコード)は既定でON。
  function memoForAI(a) {
    return a.forAI !== false;
  }

  // ---- 堅牢なアンカー(要素を毎回同じように再解決するための複数シグナル) ----
  function isStableId(id) {
    if (!id) return false;
    if (id.length > 40) return false;
    if (/\s/.test(id)) return false;
    if (/[:.]/.test(id)) return false; // フレームワークの動的ID風
    if (/\d{4,}/.test(id)) return false; // 連番/自動生成風
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false; // UUID風
    return true;
  }

  function cssIdent(s) {
    return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function stableAttrSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    for (const name of ['data-agent-id', 'data-testid', 'data-test', 'data-cy', 'data-asin']) {
      const val = (el.getAttribute(name) || '').trim();
      if (!val) continue;
      if (name === 'data-asin' && !/^[A-Z0-9]{10}$/i.test(val)) continue;
      return `[${name}="${cssAttr(val)}"]`;
    }
    return '';
  }

  function normalizedLinkHref(el) {
    const link = el?.matches?.('a[href]') ? el : el?.closest?.('a[href]');
    const href = link?.getAttribute?.('href') || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return '';
    try {
      const url = new URL(href, location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '';
    }
  }

  function normalizedHrefFromLink(link) {
    const href = link?.getAttribute?.('href') || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return '';
    try {
      const url = new URL(href, location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '';
    }
  }

  function nearestLink(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.matches?.('a[href]')) return el;
    const closest = el.closest?.('a[href]');
    if (closest) return closest;
    return el.querySelector?.('a[href]') || null;
  }

  function asinFromHref(href) {
    const m = String(href || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
    return m ? m[1].toUpperCase() : '';
  }

  function nearestDataAsin(el) {
    if (!el || el.nodeType !== 1) return '';
    const own = el.getAttribute?.('data-asin') || '';
    if (/^[A-Z0-9]{10}$/i.test(own)) return own.toUpperCase();
    const closest = el.closest?.('[data-asin]');
    const val = closest?.getAttribute?.('data-asin') || '';
    if (/^[A-Z0-9]{10}$/i.test(val)) return val.toUpperCase();
    const nested = el.querySelector?.('[data-asin]');
    const nestedVal = nested?.getAttribute?.('data-asin') || '';
    return /^[A-Z0-9]{10}$/i.test(nestedVal) ? nestedVal.toUpperCase() : '';
  }

  function nearestTestId(el) {
    if (!el || el.nodeType !== 1) return '';
    const direct = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '';
    if (direct) return direct;
    const marked = el.closest?.('[data-testid],[data-test],[data-cy]');
    return marked?.getAttribute?.('data-testid') || marked?.getAttribute?.('data-test') || marked?.getAttribute?.('data-cy') || '';
  }

  function stableAncestor(el) {
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < 8) {
      if (stableAttrSelector(cur) || (cur.id && isStableId(cur.id))) return cur;
      cur = cur.parentElement;
      depth += 1;
    }
    return null;
  }

  function itemContainerAncestor(el) {
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < 8) {
      const role = cur.getAttribute?.('role') || '';
      const cls = cur.className && typeof cur.className === 'string' ? cur.className : '';
      const looksLikeItem =
        cur.matches?.('[data-asin],li,article,[role="listitem"],[data-testid],[data-test],[data-cy],[data-csa-c-item-id]') ||
        /\b(card|item|product|result|tile)\b/i.test(cls);
      const rect = cur.getBoundingClientRect?.();
      if (looksLikeItem && rect && rect.width > 20 && rect.height > 20 && !isPageSizedRect(rect) && role !== 'presentation') return cur;
      cur = cur.parentElement;
      depth += 1;
    }
    return null;
  }

  function headingContextCandidate(el) {
    if (!el || el.nodeType !== 1) return null;
    const targetTop = el.getBoundingClientRect?.().top ?? Infinity;
    let best = null;
    let bestDist = Infinity;
    let cur = el.parentElement;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < 6) {
      const headings = cur.querySelectorAll?.('h1,h2,h3,h4,h5,h6,[role="heading"]') || [];
      for (const h of headings) {
        if (!isVisible(h) || isOwnUi(h) || h.contains(el)) continue;
        const r = h.getBoundingClientRect();
        if (r.top > targetTop + 12) continue;
        const label = labelOf(h);
        if (!label) continue;
        const dist = Math.abs(targetTop - r.top);
        if (dist < bestDist) {
          best = h;
          bestDist = dist;
        }
      }
      cur = cur.parentElement;
      depth += 1;
    }
    return best;
  }

  function targetCandidate(el, source) {
    if (!el || el.nodeType !== 1) return null;
    const link = nearestLink(el);
    const href = normalizedHrefFromLink(link);
    const dataAsin = nearestDataAsin(el) || asinFromHref(href);
    const label = truncate(labelOf(el) || labelOf(link) || '', 160);
    const selector = cssPath(el);
    if (!selector && !href && !dataAsin && !label) return null;
    return {
      source,
      selector,
      label,
      dataAgentId: el.getAttribute('data-agent-id') || '',
      testid: nearestTestId(el),
      dataAsin,
      href,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
    };
  }

  function dedupeTargetCandidates(candidates) {
    const seen = new Set();
    const out = [];
    for (const c of candidates) {
      if (!c) continue;
      const key = [c.selector, c.href, c.dataAsin, c.label, c.source].join('\n');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out.slice(0, 6);
  }

  function buildTargetCandidates(el) {
    if (!el || el.nodeType !== 1) return [];
    return dedupeTargetCandidates([
      targetCandidate(el, 'target'),
      targetCandidate(nearestLink(el), 'nearest-link'),
      targetCandidate(stableAncestor(el), 'stable-ancestor'),
      targetCandidate(itemContainerAncestor(el), 'item-container'),
      targetCandidate(headingContextCandidate(el), 'section-heading'),
    ]);
  }

  function bestTargetCandidate(candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    return (
      list.find((c) => c.dataAgentId || c.testid) ||
      list.find((c) => c.dataAsin || c.href) ||
      list.find((c) => c.label) ||
      list[0] ||
      null
    );
  }

  function hasDurableAnchorSignal(el) {
    if (!el || el.nodeType !== 1) return false;
    if (stableAttrSelector(el)) return true;
    if (el.id && isStableId(el.id)) return true;
    if (el.matches?.('a[href]') && normalizedLinkHref(el)) return true;
    return false;
  }

  // 安定IDを持つ祖先を起点に、tag + :nth-of-type で短い決定的パスを作る。
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const stableAttr = stableAttrSelector(el);
    if (stableAttr) return stableAttr;
    if (el.id && isStableId(el.id)) return `#${cssIdent(el.id)}`;
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      const attr = stableAttrSelector(cur);
      if (attr) {
        parts.unshift(attr);
        break;
      }
      if (cur.id && isStableId(cur.id)) {
        parts.unshift(`#${cssIdent(cur.id)}`);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (!parent || parent === document.body || parent === document.documentElement) break;
      cur = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function buildAnchor(el) {
    const candidates = buildTargetCandidates(el);
    const best = bestTargetCandidate(candidates) || {};
    const href = normalizedLinkHref(el) || best.href || '';
    const dataAsin = nearestDataAsin(el) || asinFromHref(href) || best.dataAsin || '';
    const selector = cssPath(el);
    const selPos = selectorPosition(selector, el);
    return {
      selector,
      // セレクタが非一意(共有testid/id起点で複数一致)な場合の“捕捉時の位置”と一致総数。解決時に
      // 同位置の要素を優先することで、兄弟がテキストを変えても/重複しても選んだ要素へ戻る。一致総数が
      // 変わっていたら(手前に挿入/削除でズレた)位置を信用し過ぎないための判定材料にする。
      selectorIndex: selPos.index,
      selectorCount: selPos.count,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      dataAgentId: el.getAttribute('data-agent-id') || '',
      dataAsin,
      href,
      name: el.getAttribute('name') || '',
      testid: nearestTestId(el),
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      targetCandidates: candidates,
    };
  }

  // セレクタが指す要素群の中で el が何番目か(捕捉位置)と一致総数。一意/解決不能なら index=0。
  function selectorPosition(selector, el) {
    if (!selector) return { index: 0, count: 0 };
    try {
      const matches = document.querySelectorAll(selector);
      if (matches.length <= 1) return { index: 0, count: matches.length };
      const idx = Array.prototype.indexOf.call(matches, el);
      return { index: idx >= 0 ? idx : 0, count: matches.length };
    } catch {
      return { index: 0, count: 0 };
    }
  }

  // ---- anchor の解決(再バインド) ----
  // 重要: 注釈(赤枠/お描き)は「クリックした“その”要素」へ戻さなければならない。
  // 単純に「最初に一致したシグナルを返す」と、buildAnchor が近傍由来で拾う非一意シグナル
  //   - href: 同一URLを指す繰り返しリンク(サムネ用<a>＋見出し<a>等)の“先頭”
  //   - testid: 祖先ラッパー(カード等)の共有 data-testid
  //   - aria-label/name/placeholder: ページ内で重複しがちなラベル
  // のどれかが別要素を掴み、赤枠が無関係な要素へ暴発する(nichenext.com/ko で報告)。
  // 方式: セレクタの“捕捉位置(selectorIndex)”=構造上の同一性を最重視し、揮発しうる
  // テキストは補助点に留める。これにより、共有testidの兄弟が同じ/古いテキストを持っても
  // (例: 「토론 밀도 0%」が複数行)選んだ位置の要素へ戻る。
  // 性能: セレクタの querySelectorAll は anchor ごとに1回だけ実行し、候補プールは捕捉位置と
  // 先頭の2件に絞る(兄弟全件は入れない)。確信が持てない時だけ近傍シグナル/テキストへ広げる。
  function resolveAnchor(anchor) {
    if (!anchor) return null;
    // 一意な自己同一シグナルは即決(従来の最優先を踏襲し、決定性も保つ)。
    if (anchor.dataAgentId) {
      const el = safeQuery(`[data-agent-id="${cssAttr(anchor.dataAgentId)}"]`);
      if (el) return el;
    }
    // セレクタ一致を1回だけ取り、捕捉位置を割り出す(以後 score へ使い回す=再クエリしない)。
    const selMatches = anchor.selector ? safeQueryAll(anchor.selector) : [];
    const selCount = selMatches.length;
    // 一致総数が捕捉時と変わっていたら、手前に要素が挿入/削除されて位置がズレた可能性が高い。
    // この時は捕捉位置(positional)を信用し過ぎず、テキスト等で本来の要素を拾い直す。
    const stale = anchor.selectorCount > 0 && selCount > 1 && selCount !== anchor.selectorCount;
    const sel = {
      unique: selCount === 1 ? selMatches[0] : null,
      positional: selCount > 1 ? selMatches[clampSelectorIndex(anchor, selCount)] : null,
      stale,
    };
    // 1段目: セレクタ/data-asin 由来の少数候補だけで採点(共有testidの兄弟全件は入れない)。
    const pool = collectSignalCandidates(anchor, selMatches);
    let best = pickBestAnchorMatch(pool, anchor, sel);
    // 2段目: 確信が持てない(セレクタが壊れて el を指さない/位置がズレた)時は、近傍シグナルと
    // tag を絞った text 一致へ広げて再採点する(構造変化後の再解決用フォールバック)。
    if (stale || !best.el || best.score < ANCHOR_CONFIDENT) {
      addBroadSignalCandidates(pool, anchor);
      addTextCandidates(pool, anchor);
      best = pickBestAnchorMatch(pool, anchor, sel);
    }
    return best.el && best.score > 0 ? best.el : null;
  }

  // anchor 一致が「確信できる」とみなす点数。これ未満なら近傍/text 走査での上書きを許す。
  // (捕捉位置 450 や own testid 120 + tag 120 = 240 などが確信ライン)
  const ANCHOR_CONFIDENT = 220;
  const SIGNAL_CANDIDATE_CAP = 50; // 共有testid等で兄弟が大量にある場合の採点件数上限(O(N^2)回避)

  function safeQueryAll(sel) {
    try {
      return Array.from(document.querySelectorAll(sel));
    } catch {
      return [];
    }
  }

  function clampSelectorIndex(anchor, len) {
    const i = anchor.selectorIndex | 0; // 旧レコード(未保存)は 0
    return i >= 0 && i < len ? i : 0;
  }

  function anchorTextOf(el) {
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  // 文書順で安定に並べるための比較関数(同点時の決定的タイブレーク=文書順で先の要素)。
  function domOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  // 1段目候補: セレクタの“捕捉位置”と先頭、+ data-asin。兄弟全件は入れない(有界)。
  function collectSignalCandidates(anchor, selMatches) {
    const set = new Set();
    const add = (el) => {
      if (el && el.nodeType === 1 && !isOwnUi(el)) set.add(el);
    };
    if (selMatches.length === 1) {
      add(selMatches[0]);
    } else if (selMatches.length > 1) {
      add(selMatches[clampSelectorIndex(anchor, selMatches.length)]); // 捕捉した位置の要素(本命)
      add(selMatches[0]); // 位置情報が古い場合の保険
    }
    if (anchor.dataAsin && /^[A-Z0-9]{10}$/i.test(anchor.dataAsin)) {
      addCapped(set, `[data-asin="${cssAttr(anchor.dataAsin)}"]`, 8);
    }
    return set;
  }

  // 2段目候補(フォールバック): 近傍由来シグナルの一致を上限付きで追記。
  function addBroadSignalCandidates(set, anchor) {
    if (anchor.testid) {
      addCapped(
        set,
        `[data-testid="${cssEscape(anchor.testid)}"],[data-test="${cssEscape(anchor.testid)}"],[data-cy="${cssEscape(anchor.testid)}"]`,
        SIGNAL_CANDIDATE_CAP
      );
    }
    if (anchor.name) addCapped(set, `[name="${cssEscape(anchor.name)}"]`, SIGNAL_CANDIDATE_CAP);
    if (anchor.ariaLabel) addCapped(set, `[aria-label="${cssEscape(anchor.ariaLabel)}"]`, SIGNAL_CANDIDATE_CAP);
    if (anchor.placeholder) addCapped(set, `[placeholder="${cssEscape(anchor.placeholder)}"]`, SIGNAL_CANDIDATE_CAP);
    if (anchor.href) {
      let n = 0;
      for (const link of document.querySelectorAll('a[href]')) {
        if (normalizedLinkHref(link) !== anchor.href) continue;
        if (!isOwnUi(link)) set.add(link);
        if (++n >= SIGNAL_CANDIDATE_CAP) break;
      }
    }
  }

  function addCapped(set, sel, cap) {
    try {
      const matches = document.querySelectorAll(sel);
      for (let i = 0; i < matches.length && i < cap; i += 1) {
        const el = matches[i];
        if (el && el.nodeType === 1 && !isOwnUi(el)) set.add(el);
      }
    } catch {
      /* 不正セレクタは無視 */
    }
  }

  // tag を絞った text 一致の候補を追記(走査が重いので確信が無い時だけ呼ぶ)。
  function addTextCandidates(set, anchor) {
    if (!anchor.text) return;
    const scope = anchor.tag && /^[a-z][a-z0-9-]*$/i.test(anchor.tag) ? anchor.tag : '*';
    let n = 0;
    for (const el of document.querySelectorAll(scope)) {
      if (isOwnUi(el)) continue;
      if (anchorTextOf(el) === anchor.text) {
        set.add(el);
        if (++n >= 30) break; // 同一テキストが大量にある場合の暴走防止
      }
    }
  }

  // selector が“安定セレクタ”か(#安定ID や [data-*] 始まりで nth-of-type を含まない)。
  // 安定なら一意に解決できる強い証拠、nth-of-type 依存なら構造変化で揺れる弱い証拠として扱う。
  function isStableSelector(sel) {
    return !!sel && !sel.includes(':nth-') && (sel.startsWith('#') || sel.startsWith('['));
  }

  // 候補プールから anchor に最も一致する要素を選ぶ(同点は文書順で先を採り決定的にする)。
  function pickBestAnchorMatch(set, anchor, sel) {
    const list = Array.from(set).sort(domOrder);
    let bestEl = null;
    let bestScore = -Infinity;
    for (const el of list) {
      const s = scoreAnchorMatch(el, anchor, sel);
      if (s > bestScore) {
        bestScore = s;
        bestEl = el;
      }
    }
    return { el: bestEl, score: bestScore };
  }

  // 要素が anchor をどれだけ忠実に表すかを採点する。構造上の同一性(セレクタの一意一致/捕捉位置)を
  // 最重視し、揮発しうる text や近傍由来の testid/href/aria は補助点に留める。tag 不一致は強い反証。
  // sel = { unique, positional } は resolveAnchor が1回だけ算出した値(ここで再クエリしない)。
  function scoreAnchorMatch(el, anchor, sel) {
    let score = 0;
    if (anchor.dataAgentId && el.getAttribute('data-agent-id') === anchor.dataAgentId) score += 1000;
    if (sel) {
      // セレクタが一意に el へ解決する、または“捕捉した位置”の要素 = 構造上の同一要素(最強)。
      // テキストが変わった/兄弟と重複しても、ここで選んだ位置の要素が勝つ。
      // ただし一致総数が変わって位置がズレた(stale)時は位置の信頼を下げ、text-exact(250)に
      // 主導権を譲る(手前に新カードが挿入されても捕捉要素のユニークテキストで拾い直せるように)。
      if (sel.unique && sel.unique === el) score += isStableSelector(anchor.selector) ? 500 : 450;
      else if (sel.positional && sel.positional === el) score += sel.stale ? 120 : 450;
    }
    if (anchor.dataAsin && /^[A-Z0-9]{10}$/i.test(anchor.dataAsin)) {
      const own = (el.getAttribute('data-asin') || '').toUpperCase();
      if (own === anchor.dataAsin.toUpperCase()) score += 250;
    }
    if (anchor.tag) {
      if (el.tagName.toLowerCase() === anchor.tag) score += 120;
      else score -= 120; // タグ違いは「別要素」の強い証拠
    }
    if (anchor.text) {
      const txt = anchorTextOf(el);
      // text は“補助”。構造上の同一性(450〜500)を覆せない重みにし、古い/重複テキストの兄弟へ
      // 赤枠が逃げるのを防ぐ。一方でセレクタが曖昧な時は依然として有効な識別子になる。
      if (txt === anchor.text) score += 250;
      else if (txt && (txt.includes(anchor.text) || anchor.text.includes(txt))) score += 60;
      else score -= 60; // テキストがまるで違うのも反証
    }
    if (anchor.testid) {
      const ownTestid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '';
      if (ownTestid === anchor.testid) score += 120; // 自身が保持(強い)
      else if (nearestTestId(el) === anchor.testid) score += 30; // 祖先/子孫由来の文脈一致(弱い)
    }
    if (anchor.name && el.getAttribute('name') === anchor.name) score += 120;
    if (anchor.ariaLabel && el.getAttribute('aria-label') === anchor.ariaLabel) score += 60;
    if (anchor.placeholder && el.getAttribute('placeholder') === anchor.placeholder) score += 60;
    if (anchor.href && normalizedLinkHref(el) === anchor.href) score += 30; // リンク文脈の一致(弱い)
    if (anchor.role && roleOf(el) === anchor.role) score += 20;
    return score;
  }

  function safeQuery(sel) {
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  }

  // ---- 注釈の描画 ----
  let annoObserver = null;

  // AIメモ(お描きの隣の編集欄)を編集中は「スプリアスな再描画」を保留する。
  // renderAnnotations は [data-bag-anno] を全て作り直すので、入力中のテキストエリアまで
  // 作り直すとフォーカスとIME変換が飛ぶ(日本語入力で特に顕著)。
  // ただし保留してよいのは内容が変わらない「リフレッシュ目的」の再描画(サイドパネルの一覧更新=
  // LIST_ANNOTATIONS や MutationObserver の再試行)だけ。追加/削除など構造が変わる再描画は
  // deferrable=false で必ず実行する(編集中でもフォーカスより整合性を優先)。
  let memoComposing = false; // IME変換中(compositionstart〜end)
  let pendingMemoRender = false; // 編集中に保留した再描画があるか
  let lastRenderResult = { resolved: 0, total: 0 };

  // 「いまページ上のAIメモを実際に編集中か」。ページが実フォーカスを持ち、テキストエリアが
  // 操作対象、またはIME変換中の時だけ true。サイドパネル側にフォーカスがある時は false。
  function isMemoEditing() {
    if (memoComposing) return true;
    const hasFocus = typeof document.hasFocus !== 'function' || document.hasFocus();
    if (!hasFocus) return false;
    const ae = document.activeElement;
    return !!(ae && ae.classList && ae.classList.contains('bag-memo-text'));
  }

  // 編集が終わった(blur / IME確定)時に、保留していた再描画を一度だけ反映する。
  function flushPendingMemoRender() {
    if (!pendingMemoRender || isMemoEditing()) return;
    pendingMemoRender = false;
    renderAnnotations();
  }

  // deferrable=true: 内容不変のリフレッシュ目的。メモ編集中はDOMを作り直さず保留する
  // (入力中のフォーカス/IME変換が飛ぶのを防ぐ)。編集終了時に flushPendingMemoRender で反映する。
  function renderAnnotations(deferrable = false) {
    if (deferrable && isMemoEditing()) {
      pendingMemoRender = true;
      return lastRenderResult;
    }
    annoObserver?.disconnect();
    try {
      // 既存の注釈DOMと目印属性を一旦クリア
      document.querySelectorAll(`[${ATTR.anno}]`).forEach((el) => el.remove());
      document.querySelectorAll(`[${ATTR.annoMarked}]`).forEach((el) => {
        el.removeAttribute(ATTR.annoMarked);
        // 目印が付与していた intent はクリア(再付与する)
        if (el.getAttribute(ATTR.intentSrc) === 'marker') {
          el.removeAttribute(ATTR.intent);
          el.removeAttribute(ATTR.intentSrc);
        }
      });
      // 目印(marker)の枠線(CSS outline 属性)を一括で外す。
      document.querySelectorAll(`[${ATTR.annoOutline}]`).forEach((el) => el.removeAttribute(ATTR.annoOutline));
      // 補足(note)の赤枠はオーバーレイ方式。毎回作り直すので保存済み分の枠だけ撤去する
      // (選択中の一時枠 'pick' は openAuthoring/closeAuthoring 管理なので残す)。
      clearOutlineBoxes('note');

      // お描きの永続レイヤとピンを一旦破棄して再構築する。
      // 古い content-script インスタンス由来の点線コネクタは data-bag-anno を持たないため、
      // 参照中の drawLayer だけを空にするのではなく、DOM 上のレイヤごと掃除する。
      resetDrawingDom();

      let unresolved = 0;
      for (const a of annotations) {
        const target = a.anchor ? resolveAnchor(a.anchor) : null;
        if (!target && a.placement !== 'floating' && a.kind !== 'button') unresolved += 1;
        if (a.kind === 'marker') applyMarker(a, target);
        else if (a.kind === 'button') renderAnnoButton(a, target);
        else if (a.kind === 'note') renderAnnoNote(a, target);
        else if (a.kind === 'drawing') {
          // 旧仕様で対象より大幅に小さい子要素へ誤アンカーされた古い注釈は、保存比率(shapesFrac)が
          // 0..1 を大きく外れている。これを(構造変化で別要素へ解決された)target にそのまま掛けると、
          // 無関係な位置へ巨大な点線が暴発する。安定シグナルの無い要素ではスキップして描き直しを促す。
          if (target && !hasDurableAnchorSignal(target) && isDrawingFractionBroken(a.shapes)) {
            warnBrokenDrawingOnce(a);
          } else {
            renderAnnoDrawing(a, target);
          }
        }
      }
      syncWorkflowUi(); // お描きが揃った後で手順パネル/順序コネクタを更新
      lastUnresolved = unresolved;
      if (unresolved === 0) resolveAttempts = 0; // 全解決でリトライ枠を回復
      lastRenderResult = { resolved: annotations.length - unresolved, total: annotations.length };
      return lastRenderResult;
    } finally {
      observeAnno();
    }
  }

  function applyMarker(a, target) {
    if (!target) return;
    if (a.name) target.setAttribute(ATTR.id, a.name);
    target.setAttribute(ATTR.role, a.role || roleOf(target));
    if (a.intent) {
      target.setAttribute(ATTR.intent, a.intent);
      target.setAttribute(ATTR.intentSrc, 'marker');
    }
    target.setAttribute(ATTR.annoMarked, a.id);
    if (a.outline) target.setAttribute(ATTR.annoOutline, '1');
  }

  function renderAnnoButton(a, target) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bag-injected-btn bag-anno-btn';
    btn.textContent = a.label || t('cs.button.cueDefault');
    btn.setAttribute(ATTR.anno, a.id);
    btn.setAttribute(ATTR.ui, '1');
    btn.setAttribute(ATTR.id, `cue:${a.id}`);
    btn.setAttribute(ATTR.role, 'cue-button');
    btn.setAttribute(ATTR.intent, a.intent || a.label || '');
    btn.title = a.intent || '';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      signalLog.push({
        aiId: `cue:${a.id}`,
        intent: a.intent || a.label || a.id,
        label: a.label || '',
        at: new Date().toISOString(),
      });
      toast(t('cs.toast.signalRecorded', { label: a.label || a.id }), 'success');
    });
    if (target && a.placement !== 'floating') {
      target.insertAdjacentElement(a.position || 'afterend', btn);
    } else {
      btn.classList.add('bag-floating');
      floatingHost().appendChild(btn);
    }
  }

  function renderAnnoNote(a, target) {
    const number = annoNoteNumber(a);
    if (target && a.placement !== 'floating') {
      // 対象を赤枠で囲み、その上に「番号＋本文」を常時表示の手順キャプションとして出す。
      // ページ内ピン/CSS outline ではなく独立した最上位レイヤに描くので、祖先の overflow や
      // 兄弟の z-index に隠されず、メモ本文が hover 不要で常に読める。
      addOutlineBox(target, 'note', { caption: { number, text: a.note || '' } });
    } else {
      // 対象未解決/floating は浮遊キャプションで常時表示する(画面右下に番号順で積む)。
      renderFloatingNote(a, number);
    }
  }

  // 補足の手順番号(補足だけの通し番号、作成順)。お描き手順(annoDrawingNumber)とは別系列。
  function annoNoteNumber(a) {
    return annotations.filter((x) => x.kind === 'note').findIndex((x) => x.id === a?.id) + 1;
  }

  function renderFloatingNote(a, number) {
    const cap = buildStepCaption(number, a.note || '');
    cap.classList.add('bag-floating');
    cap.setAttribute(ATTR.anno, a.id); // renderAnnotations の [data-bag-anno] 一括クリアで作り直す
    floatingHost().appendChild(cap);
  }

  function observeAnno() {
    if (!annoObserver) {
      annoObserver = new MutationObserver(onDomMutated);
    }
    try {
      annoObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* document未準備は無視 */
    }
  }

  function resetDrawingDom() {
    drawRegistry = [];
    wfConnectors = [];
    document.querySelectorAll('.bag-draw-layer, .bag-draw-pin-host').forEach((el) => el.remove());
    drawLayer = null;
    drawPinHost = null;
    memoFocusId = null;
  }

  let lastUrl = location.href;
  let renderTimer = null;
  let resolveAttempts = 0;
  const MAX_RESOLVE_ATTEMPTS = 15; // 解決不能な注釈で無限リトライしないための上限

  // SPA(pushState/popstate/hashchange)でURLが変わったときの共通処理。
  //   - 注釈: スコープ(origin+pathname)を切り替えて読み直す
  //   - レシピ: 別画面では再適用できるよう適用済みシグネチャを捨て、background へ通知する
  //     (background が新URLにマッチするレシピを集約して ACTIVATE を再送する)
  function handleUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    resolveAttempts = 0;
    appliedRecipeSig = null; // 別画面なら同一レシピでも再適用を許可する
    // 編集中だった補足フォームと選択中の一時赤枠(pick)は前画面のものなので畳む
    // (startPicker/startDrawing と同様。残すと新画面に旧要素を指す赤枠が居座る)。
    closeAuthoring();
    try {
      // SWが眠っていても次のDOM変化/イベントで再送されるため、失敗は握りつぶす。
      chrome.runtime.sendMessage({ type: 'SPA_NAVIGATED', url: location.href }, () => void chrome.runtime.lastError);
    } catch {
      /* 拡張コンテキスト無効化などは無視 */
    }
    loadAnnotations().then(renderAnnotations);
  }

  function onDomMutated() {
    // SPA遷移(URL変化)を検知したらスコープを切り替えて読み直す。
    if (location.href !== lastUrl) {
      handleUrlChange();
      return;
    }
    const staleResolvedTarget = hasDisconnectedDrawingTargets();
    // 全注釈が解決済みで対象ノードも生きている場合、Amazon の lazy layout などに追従するため
    // 座標だけ軽く更新し、DOMの作り直しは避ける。
    if (!staleResolvedTarget && lastUnresolved === 0) {
      // お描きが無くても補足の赤枠オーバーレイはレイアウト変化に追従させる。
      if (drawRegistry.length || outlineBoxes.length) scheduleDrawingReposition();
      return;
    }
    // 未解決注釈での無限リトライは抑える。ただし、解決済みだった対象が差し替わった場合は
    // 一度は再解決を試す(Amazon の商品カード hydration/差し替え対策)。
    if (!staleResolvedTarget && resolveAttempts >= MAX_RESOLVE_ATTEMPTS) return;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      resolveAttempts += 1;
      renderAnnotations(/* deferrable */ true); // メモ編集中の入力フォーカスを奪わない
    }, 600);
  }

  function hasDisconnectedDrawingTargets() {
    return drawRegistry.some((entry) => entry.anno?.kind === 'drawing' && !entry.el?.isConnected);
  }

  function scheduleDrawingReposition() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      repositionDrawings();
    });
  }

  // 戻る/進む・ハッシュ遷移はDOM変化を伴わないことがあるため明示的に拾う(SPA対応)。
  window.addEventListener('popstate', handleUrlChange);
  window.addEventListener('hashchange', handleUrlChange);

  // ---- 注釈モード(要素ピッカー + 簡易フォーム) ----
  let picking = false;
  let pickOverlay = null;
  let pickHintEl = null;
  let authoringEl = null;
  // overlay(赤枠)が最後に描いた“その”要素を記憶し、クリック時にそれを選択対象にする。
  // ユーザーが見ていた枠と選択要素を必ず一致させるための単一の真実源。マウスは
  // mousemove(hover)が継続更新し、タッチ/ペンは pointerdown が設定する。
  let lastHighlightedEl = null;

  function startPicker() {
    if (picking) return { picking: true };
    if (drawing.active) stopDrawing(); // お描きモードと排他にする
    picking = true;
    document.documentElement.classList.add('bag-picking');
    pickOverlay = document.createElement('div');
    pickOverlay.className = 'bag-pick-overlay';
    pickOverlay.setAttribute(ATTR.ui, '1');
    document.documentElement.appendChild(pickOverlay);
    pickHintEl = document.createElement('div');
    pickHintEl.className = 'bag-pick-hint';
    pickHintEl.setAttribute(ATTR.ui, '1');
    pickHintEl.textContent = t('cs.picker.hint');
    document.documentElement.appendChild(pickHintEl);
    document.addEventListener('pointerdown', onPickPointerDown, true);
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
    return { picking: true };
  }

  function stopPicker() {
    picking = false;
    document.documentElement.classList.remove('bag-picking');
    pickOverlay?.remove();
    pickOverlay = null;
    pickHintEl?.remove();
    pickHintEl = null;
    lastHighlightedEl = null;
    document.removeEventListener('pointerdown', onPickPointerDown, true);
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    return { picking: false };
  }

  function pickTargetFrom(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const n of path) {
      if (n && n.nodeType === 1 && n.closest && !n.closest(`[${ATTR.ui}]`)) return n;
    }
    return e.target;
  }

  // 候補のうち、まだDOMに繋がっていて自前UIでない最初の要素を返す。
  // detached(hover/pointer の後にサイトが除去)や stale な参照を弾く。
  function firstConnectedPick(...els) {
    for (const el of els) {
      if (el && el.nodeType === 1 && el.isConnected && el.closest && !el.closest(`[${ATTR.ui}]`)) return el;
    }
    return null;
  }

  // 選択中の赤枠オーバーレイを対象要素の矩形へ合わせ、その要素を「最後に見せた枠」として記憶する。
  // hover と pointerdown で共用し、onPickClick はこの記憶を使う(見えた枠=選択要素)。
  function highlightPick(el) {
    lastHighlightedEl = el;
    if (!pickOverlay || !el) return;
    const r = el.getBoundingClientRect();
    Object.assign(pickOverlay.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function onPickPointerDown(e) {
    // マウスは mousemove(hover)が「見えている枠」を継続更新するのでそれを唯一の真実源にする。
    // pointerdown はサイトが hover で差し込んだ overlay/巨大wrapper を掴みやすく(Amazon)、
    // ここで上書きすると見えていたカードではなく巨大要素を選んでしまう。タッチ/ペンは
    // mousemove が来ないため、その時だけ pointerdown で対象を確定し赤枠も即出す。
    if (e.pointerType === 'mouse') return;
    if (e.target.closest && e.target.closest(`[${ATTR.ui}]`)) return; // 自前UIは無視
    const el = pickTargetFrom(e);
    if (!el || el.nodeType !== 1 || (el.closest && el.closest(`[${ATTR.ui}]`))) return;
    highlightPick(el);
  }

  function onPickMove(e) {
    if (!pickOverlay) return;
    const el = pickTargetFrom(e);
    if (!el || (el.closest && el.closest(`[${ATTR.ui}]`))) {
      pickOverlay.style.display = 'none';
      lastHighlightedEl = null;
      return;
    }
    highlightPick(el); // 見せた枠の要素を lastHighlightedEl に記録
  }

  function onPickClick(e) {
    if (e.target.closest && e.target.closest(`[${ATTR.ui}]`)) return; // 自前UIは無視
    e.preventDefault();
    e.stopPropagation();
    // overlay が最後に描いた要素(=ユーザーが見ていた枠)を選択対象にする。detached は弾き、
    // 無ければ click の composedPath から解決する。
    const el = firstConnectedPick(lastHighlightedEl) || pickTargetFrom(e);
    stopPicker();
    openAuthoring(el);
  }

  function onPickKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      stopPicker();
    }
  }

  // 要素クリック後に出る、非エンジニア向けの簡易フォーム。
  function openAuthoring(el, existing) {
    closeAuthoring();
    // 選択した対象を赤枠で囲んだまま残し、メモ入力中も「どこを直すのか」を見失わないようにする。
    // 保存すれば renderAnnoNote が同じ位置に 'note' 枠を引き継ぎ、キャンセル時は
    // closeAuthoring がこの一時枠(pick)を外す。CSS outline ではなく独立オーバーレイで囲む。
    clearOutlineBoxes('pick');
    addOutlineBox(el, 'pick');
    // 編集時は保存済みanchorを維持する。floating合図ボタンはanchor=nullなので、
    // ここでbuildAnchor(null)に落ちると el.tagName で TypeError になる。新規メモのみ要素から生成。
    const anchor = existing ? existing.anchor : buildAnchor(el);
    const head = anchor || {};
    const heading = head.text || head.ariaLabel || head.placeholder || head.tag || t('cs.author.targetFallback');
    // どの要素を選んだかを CSS セレクタ(クエリ)で具体的に示す。tag だけだと「div」のように
    // 判別できないため。anchor の無い floating メモでは行を出さない。
    const selectorRow = head.selector
      ? `<div class="bag-author-target-q">${escapeHtml(t('cs.author.selector'))} <code title="${escapeHtml(head.selector)}">${escapeHtml(truncate(head.selector, 120))}</code></div>`
      : '';
    const wrap = document.createElement('div');
    wrap.className = 'bag-author';
    wrap.setAttribute(ATTR.ui, '1');
    // 補足はAI向けの指示1つに絞る。種類(コメント/目印/合図ボタン)や名前欄は出さない。
    wrap.innerHTML = `
      <div class="bag-author-head">${escapeHtml(t('cs.author.addNote'))}</div>
      <div class="bag-author-target">${escapeHtml(t('cs.author.target'))} <b>${escapeHtml(truncate(heading, 40))}</b> <span class="muted">&lt;${escapeHtml(head.role || head.tag || '')}&gt;</span></div>
      ${selectorRow}
      <label class="bag-author-row">
        <span>${escapeHtml(t('cs.author.aiContent'))}</span>
        <textarea data-f="note" rows="3" placeholder="${escapeHtml(t('cs.author.aiContentPlaceholder'))}"></textarea>
      </label>
      <div class="bag-author-actions">
        <button data-f="cancel" type="button">${escapeHtml(t('cs.author.cancel'))}</button>
        <button data-f="save" type="button" class="primary">${escapeHtml(t('cs.author.save'))}</button>
      </div>`;
    document.documentElement.appendChild(wrap);
    positionAuthoring(wrap, el);
    setupAuthoringDrag(wrap);
    authoringEl = wrap;

    // 既存編集時はAI向けの内容を初期表示する。noteは本文、marker/buttonは目的(intent)が
    // AI向けの中身なので、種類に応じて1欄に出し入れする(名前/ラベルは識別子なので保持して触らない)。
    if (existing) {
      const seed = existing.kind === 'note' ? existing.note : existing.intent || existing.note;
      wrap.querySelector('[data-f="note"]').value = seed || '';
    }
    requestAnimationFrame(() => clampAuthoringIntoViewport(wrap));
    wrap.querySelector('[data-f="cancel"]').addEventListener('click', closeAuthoring);
    wrap.querySelector('[data-f="save"]').addEventListener('click', async () => {
      const value = wrap.querySelector('[data-f="note"]').value.trim();
      // 新規・noteは赤枠付きの補足。既存のmarker/button編集時は体裁を保ち、AI向けの内容(intent)だけ更新する。
      const kind = existing?.kind || 'note';
      const isNote = kind === 'note';
      await upsertAnnotation({
        id: existing?.id,
        kind,
        anchor,
        label: isNote ? '' : existing?.label || '',
        name: isNote ? '' : existing?.name || '',
        note: isNote ? value : existing?.note || '',
        intent: isNote ? '' : value,
        outline: isNote ? true : Boolean(existing?.outline),
        placement: isNote ? undefined : existing?.placement,
      });
      closeAuthoring();
      toast(t('cs.toast.noteSaved'), 'success');
    });
  }

  function positionAuthoring(wrap, el) {
    const r = el?.getBoundingClientRect?.();
    const w = wrap.offsetWidth || 320;
    let left = r ? Math.min(r.left, window.innerWidth - w - 16) : window.innerWidth - w - 16;
    let top = r ? r.bottom + 8 : 80;
    wrap.style.left = `${Math.max(8, left)}px`;
    wrap.style.top = `${Math.max(8, top)}px`;
    clampAuthoringIntoViewport(wrap);
  }

  function clampAuthoringIntoViewport(wrap) {
    if (!wrap?.isConnected) return;
    const pad = 8;
    const w = wrap.offsetWidth || 320;
    const h = Math.min(wrap.offsetHeight || 280, Math.max(1, window.innerHeight - pad * 2));
    const maxLeft = Math.max(pad, window.innerWidth - w - pad);
    const maxTop = Math.max(pad, window.innerHeight - h - pad);
    const left = parseFloat(wrap.style.left) || pad;
    const top = parseFloat(wrap.style.top) || pad;
    wrap.style.left = `${clamp(left, pad, maxLeft)}px`;
    wrap.style.top = `${clamp(top, pad, maxTop)}px`;
  }

  function setupAuthoringDrag(wrap) {
    const head = wrap.querySelector('.bag-author-head');
    if (!head) return;
    let drag = null;
    const move = (ev) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        wrap.classList.add('bag-author--dragging');
      }
      const w = wrap.offsetWidth || 320;
      const h = Math.min(wrap.offsetHeight || 280, Math.max(1, window.innerHeight - 8));
      const left = clamp(ev.clientX - drag.offX, 4, Math.max(4, window.innerWidth - w - 4));
      const top = clamp(ev.clientY - drag.offY, 4, Math.max(4, window.innerHeight - h - 4));
      wrap.style.left = `${left}px`;
      wrap.style.top = `${top}px`;
      ev.preventDefault();
      ev.stopPropagation();
    };
    const end = (ev) => {
      if (!drag) return;
      try {
        head.releasePointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      wrap.classList.remove('bag-author--dragging');
      drag = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      ev.preventDefault();
      ev.stopPropagation();
    };
    head.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      drag = {
        startX: ev.clientX,
        startY: ev.clientY,
        offX: ev.clientX - rect.left,
        offY: ev.clientY - rect.top,
        moved: false,
      };
      window.addEventListener('pointermove', move, { capture: true, passive: false });
      window.addEventListener('pointerup', end, { capture: true, passive: false });
      window.addEventListener('pointercancel', end, { capture: true, passive: false });
      try {
        head.setPointerCapture(ev.pointerId);
      } catch {
        /* 一部環境ではキャプチャ不可 */
      }
      ev.preventDefault();
      ev.stopPropagation();
    });
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  function closeAuthoring() {
    authoringEl?.remove();
    authoringEl = null;
    // 選択中の一時赤枠(pick)を解除する。保存済みの補足は renderAnnoNote が
    // 'note' 枠として別途維持するので、この解除後も赤枠は残る。
    clearOutlineBoxes('pick');
  }

  // ===========================================================================
  // お描き(drawing)注釈
  // ページ上に 円 / 四角 / 矢印 / フリーハンド で印を描き、対象要素にアンカーして
  // 永続化する。座標は対象要素の矩形に対する「比率(0..1)」で保存するため、要素が
  // 動いても追従し、再訪・スクロール・リフローでも同じ位置へ復元される(決定的な再利用)。
  // AIへは図形を言葉で説明(describeShapes)してテキスト文脈として渡す。
  // ===========================================================================
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DRAW_COLORS = [
    { hex: '#ef4444', name: '赤' },
    { hex: '#f97316', name: '橙' },
    { hex: '#eab308', name: '黄' },
    { hex: '#14b8a6', name: '緑' },
    { hex: '#3b82f6', name: '青' },
    { hex: '#111827', name: '黒' },
  ];
  const DRAW_TOOLS = [
    { id: 'ellipse', label: '円', glyph: '◯', verb: '円で囲んだ' },
    { id: 'rect', label: '四角', glyph: '▭', verb: '四角で囲んだ' },
    { id: 'arrow', label: '矢印', glyph: '↗', verb: '矢印で指した' },
    { id: 'pen', label: 'ペン', glyph: '✎', verb: '手書きで印を付けた' },
  ];
  const DRAW_DEFAULT_WIDTH = 3;
  const DRAW_MAX_POINTS = 160; // フリーハンドの点数上限(保存サイズ抑制)

  // 描画モード(オーサリング)の状態
  let drawing = {
    active: false,
    tool: 'ellipse',
    color: DRAW_COLORS[0].hex,
    shapes: [], // 確定済み図形(viewport px)。各要素に _node を持つ
    current: null, // 描画中の図形(viewport px)
    currentEl: null,
    pointerId: null,
  };
  let drawOverlay = null; // オーサリング用svg(pointer捕捉)
  let drawCommitG = null; // 確定図形の描画先
  let drawToolbar = null;
  // 永続レイヤ
  let drawLayer = null; // svg(pointer-events:none)。確定済みお描きとコネクタ線を描く
  let drawPinHost = null; // AIメモカード/番号バッジのホスト(DOMオーバーレイ)
  let drawRegistry = []; // {anno, el, elems:[{node,shape}], memo, connector, bbox} 再配置対象
  let drawRepositionSetup = false;
  let drawRaf = 0;

  // ---- お描きワークフロー(番号付きお描きを「操作手順」として説明する) ----
  // 既存の通し番号(annoDrawingNumber)をそのまま手順番号として流用し、番号付きの
  // お描きを 1→2→3 と結ぶことで手順(ワークフロー)を可視化・再生・AI連携する。
  let wfMode = false; // 順序コネクタ + 再生コントロールの表示
  let wfPlayIdx = -1; // 再生/フォーカス中の手順インデックス(0始まり)。-1=なし
  let wfPlayTimer = 0; // 順送り再生のタイマー
  let wfConnectors = []; // 手順 i→i+1 を結ぶ順序コネクタ(drawLayer内のSVG線)
  let wfPanel = null; // 操作パネル(左下フローティング)
  const WF_PLAY_MS = 1700; // 1手順あたりの再生間隔(ms)

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVGNS, name);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function colorName(hex) {
    const c = DRAW_COLORS.find((x) => x.hex.toLowerCase() === String(hex || '').toLowerCase());
    return c ? c.name : '';
  }

  function toolVerb(type) {
    if (type === 'path') return '手書きで印を付けた';
    const t = DRAW_TOOLS.find((x) => x.id === type);
    return t ? t.verb : '印を付けた';
  }

  // 図形群を「赤色の円で囲んだ、青色の矢印で指した」のように日本語で説明する(AI向け)。
  function describeShapes(shapes) {
    if (!Array.isArray(shapes) || !shapes.length) return 'お描きで印を付けた';
    const seen = new Map();
    for (const s of shapes) {
      const key = `${s.type}|${s.color}`;
      if (!seen.has(key)) seen.set(key, s);
    }
    const parts = Array.from(seen.values()).map((s) => {
      const cn = colorName(s.color);
      return `${cn ? cn + '色の' : ''}${toolVerb(s.type)}`;
    });
    return Array.from(new Set(parts)).join('、');
  }

  // ---- 描画モードの開始・終了 ----
  function startDrawing() {
    if (drawing.active) return { drawing: true };
    if (picking) stopPicker(); // 注釈ピッカーと排他にする
    closeAuthoring(); // 開きかけのオーサリングフォームがあれば閉じる
    drawing = {
      active: true,
      tool: 'ellipse',
      color: DRAW_COLORS[0].hex,
      shapes: [],
      current: null,
      currentEl: null,
      pointerId: null,
    };
    buildDrawOverlay();
    buildDrawToolbar();
    document.documentElement.classList.add('bag-drawing');
    document.addEventListener('keydown', onDrawKey, true);
    addDrawShield();
    return { drawing: true };
  }

  function stopDrawing() {
    drawing.active = false;
    drawing.current = null;
    drawing.currentEl = null;
    drawing.pointerId = null;
    document.documentElement.classList.remove('bag-drawing');
    document.removeEventListener('keydown', onDrawKey, true);
    removeDrawShield();
    drawOverlay?.remove();
    drawOverlay = null;
    drawCommitG = null;
    drawToolbar?.remove();
    drawToolbar = null;
    return { drawing: false };
  }

  function onDrawKey(e) {
    if (!drawing.active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stopDrawing();
    } else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      undoDrawShape();
    }
  }

  // ---- オーサリング用オーバーレイ(viewport px で描く) ----
  function buildDrawOverlay() {
    drawOverlay = svgEl('svg', { class: 'bag-draw-overlay' });
    drawOverlay.setAttribute(ATTR.ui, '1');
    drawCommitG = svgEl('g', { class: 'bag-draw-committed' });
    drawOverlay.appendChild(drawCommitG);
    document.documentElement.appendChild(drawOverlay);
    // ポインタ処理は window のキャプチャ段(addDrawShield)へ集約する。
    // overlay 自身に listener を張ると、サイトの document/window listener より後に
    // 走るため伝播を止めきれない(モーダルが閉じてしまう)。
  }

  // 描画中だけ、サイト側の「モーダル外をクリック/タップで閉じる」等の listener へ
  // ポインタ操作が漏れるのを防ぐ盾。window のキャプチャ段で最初に走り、自前ツールバー
  // 以外で起きた down/up/click をサイトへ伝播させない。描画ロジックもここから呼ぶ。
  const DRAW_SHIELD_EVENTS = [
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
    'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick',
    'contextmenu', 'touchstart', 'touchend',
  ];

  function addDrawShield() {
    for (const type of DRAW_SHIELD_EVENTS) {
      window.addEventListener(type, onDrawShield, { capture: true, passive: false });
    }
  }

  function removeDrawShield() {
    for (const type of DRAW_SHIELD_EVENTS) {
      window.removeEventListener(type, onDrawShield, { capture: true });
    }
  }

  // ツールバー/ピンなど「操作してほしい自前コントロール」か。描画キャンバス(overlayと
  // 確定済み図形)は対象外＝描画面として扱う。
  function isDrawControl(target) {
    return Boolean(target && target.closest && target.closest('.bag-draw-toolbar, .bag-draw-pin'));
  }

  function onDrawShield(e) {
    if (!drawing.active) return;
    const onControl = isDrawControl(e.target);
    switch (e.type) {
      case 'pointerdown': {
        e.stopImmediatePropagation();
        if (onControl) return; // ツールバー操作: サイトへは漏らさず、合成clickで処理させる
        e.preventDefault();
        onDrawPointerDown(e);
        return;
      }
      case 'pointermove': {
        if (drawing.current && e.pointerId === drawing.pointerId) {
          e.stopImmediatePropagation();
          e.preventDefault();
          onDrawPointerMove(e);
        }
        return;
      }
      case 'pointerup':
      case 'pointercancel': {
        e.stopImmediatePropagation();
        if (drawing.current) {
          e.preventDefault();
          onDrawPointerUp(e);
        }
        return;
      }
      case 'click':
      case 'dblclick':
      case 'auxclick':
      case 'contextmenu': {
        if (onControl) return; // 自前ツールバー/ピンの click は素通しして動作させる
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      default: {
        // mousedown / mouseup / touchstart / touchend:
        // ポインタイベントの裏で発火する重複。サイトの listener には一切渡さない。
        e.stopImmediatePropagation();
        if (!onControl) e.preventDefault();
        return;
      }
    }
  }

  function onDrawPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    try {
      drawOverlay.setPointerCapture?.(e.pointerId);
    } catch {
      /* 一部環境ではキャプチャ不可 */
    }
    drawing.pointerId = e.pointerId;
    const x = e.clientX;
    const y = e.clientY;
    const tool = drawing.tool;
    if (tool === 'pen') {
      drawing.current = { type: 'path', color: drawing.color, width: DRAW_DEFAULT_WIDTH, pts: [[x, y]] };
    } else if (tool === 'arrow') {
      drawing.current = { type: 'arrow', color: drawing.color, width: DRAW_DEFAULT_WIDTH, x1: x, y1: y, x2: x, y2: y };
    } else {
      drawing.current = { type: tool === 'rect' ? 'rect' : 'ellipse', color: drawing.color, width: DRAW_DEFAULT_WIDTH, x0: x, y0: y, x1: x, y1: y };
    }
    drawing.currentEl = renderLiveShape(drawing.current);
  }

  function onDrawPointerMove(e) {
    if (!drawing.current || e.pointerId !== drawing.pointerId) return;
    const x = e.clientX;
    const y = e.clientY;
    const s = drawing.current;
    if (s.type === 'path') {
      const last = s.pts[s.pts.length - 1];
      if (!last || Math.hypot(x - last[0], y - last[1]) >= 2) s.pts.push([x, y]);
    } else if (s.type === 'arrow') {
      s.x2 = x;
      s.y2 = y;
    } else {
      s.x1 = x;
      s.y1 = y;
    }
    updateLiveShape(drawing.currentEl, s);
  }

  function onDrawPointerUp(e) {
    if (!drawing.current) return;
    if (e && e.pointerId != null && drawing.pointerId != null && e.pointerId !== drawing.pointerId) return;
    if (isTrivialShape(drawing.current)) {
      drawing.currentEl?.remove();
    } else {
      drawing.current._node = drawing.currentEl;
      drawing.shapes.push(drawing.current);
    }
    drawing.current = null;
    drawing.currentEl = null;
    drawing.pointerId = null;
    updateDrawToolbarState();
  }

  function isTrivialShape(s) {
    if (s.type === 'path') return (s.pts?.length || 0) < 3;
    if (s.type === 'arrow') return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 8;
    return Math.abs(s.x1 - s.x0) < 6 && Math.abs(s.y1 - s.y0) < 6;
  }

  function undoDrawShape() {
    const s = drawing.shapes.pop();
    s?._node?.remove();
    updateDrawToolbarState();
  }

  // 図形ノード(rect/ellipse は専用要素、arrow/path は polyline)。座標は後で設定する。
  function newShapeNode(s) {
    const attrs = {
      fill: 'none',
      stroke: s.color || DRAW_COLORS[0].hex,
      'stroke-width': s.width || DRAW_DEFAULT_WIDTH,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    };
    if (s.type === 'rect') return svgEl('rect', attrs);
    if (s.type === 'ellipse') return svgEl('ellipse', attrs);
    return svgEl('polyline', { ...attrs, points: '' });
  }

  function renderLiveShape(s) {
    const node = newShapeNode(s);
    drawCommitG.appendChild(node);
    updateLiveShape(node, s);
    return node;
  }

  // オーサリング中(viewport px)の図形ノードを更新する。
  function updateLiveShape(node, s) {
    if (!node) return;
    if (s.type === 'rect') {
      node.setAttribute('x', Math.min(s.x0, s.x1));
      node.setAttribute('y', Math.min(s.y0, s.y1));
      node.setAttribute('width', Math.abs(s.x1 - s.x0));
      node.setAttribute('height', Math.abs(s.y1 - s.y0));
    } else if (s.type === 'ellipse') {
      node.setAttribute('cx', (s.x0 + s.x1) / 2);
      node.setAttribute('cy', (s.y0 + s.y1) / 2);
      node.setAttribute('rx', Math.abs(s.x1 - s.x0) / 2);
      node.setAttribute('ry', Math.abs(s.y1 - s.y0) / 2);
    } else if (s.type === 'arrow') {
      node.setAttribute('points', arrowPointsPx(s.x1, s.y1, s.x2, s.y2));
    } else {
      node.setAttribute('points', (s.pts || []).map(([x, y]) => `${x},${y}`).join(' '));
    }
  }

  // 矢印を1本のpolyline(線→先端→かえし)として表現する。
  function arrowPointsPx(x1, y1, x2, y2) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.min(16, Math.max(8, Math.hypot(x2 - x1, y2 - y1) * 0.25));
    const spread = 0.45;
    const hx1 = x2 - len * Math.cos(ang - spread);
    const hy1 = y2 - len * Math.sin(ang - spread);
    const hx2 = x2 - len * Math.cos(ang + spread);
    const hy2 = y2 - len * Math.sin(ang + spread);
    return `${x1},${y1} ${x2},${y2} ${hx1},${hy1} ${x2},${y2} ${hx2},${hy2}`;
  }

  // ---- 描画ツールバー ----
  function buildDrawToolbar() {
    drawToolbar = document.createElement('div');
    drawToolbar.className = 'bag-draw-toolbar';
    drawToolbar.setAttribute(ATTR.ui, '1');
    // ツールラベル/色名はUI表示なので i18n。図形のAI説明(describeShapes)用の verb/name は別途日本語のまま。
    const toolLabelKey = { ellipse: 'cs.draw.toolEllipse', rect: 'cs.draw.toolRect', arrow: 'cs.draw.toolArrow', pen: 'cs.draw.toolPen' };
    const colorNameKey = {
      '#ef4444': 'cs.draw.colorRed', '#f97316': 'cs.draw.colorOrange', '#eab308': 'cs.draw.colorYellow',
      '#14b8a6': 'cs.draw.colorGreen', '#3b82f6': 'cs.draw.colorBlue', '#111827': 'cs.draw.colorBlack',
    };
    const tools = DRAW_TOOLS.map((tool) => {
      const label = escapeHtml(t(toolLabelKey[tool.id] || ''));
      return `<button type="button" class="bag-draw-tool" data-tool="${tool.id}" title="${label}"><span class="bag-draw-glyph">${tool.glyph}</span><span>${label}</span></button>`;
    }).join('');
    const colors = DRAW_COLORS.map(
      (c) => `<button type="button" class="bag-draw-color" data-color="${c.hex}" title="${escapeHtml(t(colorNameKey[c.hex.toLowerCase()] || ''))}" style="--bag-sw:${c.hex}"></button>`
    ).join('');
    drawToolbar.innerHTML = `
      <div class="bag-draw-tools">${tools}</div>
      <div class="bag-draw-colors">${colors}</div>
      <div class="bag-draw-ops">
        <button type="button" class="bag-draw-op" data-op="undo" title="${escapeHtml(t('cs.draw.undoTitle'))}">${escapeHtml(t('cs.draw.undo'))}</button>
        <button type="button" class="bag-draw-op" data-op="cancel" title="${escapeHtml(t('cs.draw.cancelTitle'))}">${escapeHtml(t('cs.draw.cancel'))}</button>
        <button type="button" class="bag-draw-op primary" data-op="done" title="${escapeHtml(t('cs.draw.doneTitle'))}">${escapeHtml(t('cs.draw.done'))}</button>
      </div>
      <div class="bag-draw-hint">${escapeHtml(t('cs.draw.hint'))}</div>`;
    document.documentElement.appendChild(drawToolbar);
    drawToolbar.addEventListener('click', onDrawToolbarClick);
    updateDrawToolbarState();
  }

  function onDrawToolbarClick(e) {
    // ツールバー click はサイトの bubble 段 listener へ伝播させない(モーダル閉じ対策)。
    e.stopPropagation();
    const toolBtn = e.target.closest?.('[data-tool]');
    if (toolBtn) {
      drawing.tool = toolBtn.getAttribute('data-tool');
      updateDrawToolbarState();
      return;
    }
    const colorBtn = e.target.closest?.('[data-color]');
    if (colorBtn) {
      drawing.color = colorBtn.getAttribute('data-color');
      updateDrawToolbarState();
      return;
    }
    const opBtn = e.target.closest?.('[data-op]');
    if (!opBtn) return;
    const op = opBtn.getAttribute('data-op');
    if (op === 'undo') undoDrawShape();
    else if (op === 'cancel') stopDrawing();
    // finishDrawing は async（storage 書き込みを await する）。未ハンドルの reject を出さないよう
    // 失敗はトーストで可視化する。
    else if (op === 'done') finishDrawing().catch((err) => toast(String(err?.message || err), 'error'));
  }

  function updateDrawToolbarState() {
    if (!drawToolbar) return;
    drawToolbar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-tool') === drawing.tool));
    drawToolbar
      .querySelectorAll('[data-color]')
      .forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-color').toLowerCase() === String(drawing.color).toLowerCase()));
    const has = drawing.shapes.length > 0;
    const undo = drawToolbar.querySelector('[data-op="undo"]');
    const done = drawToolbar.querySelector('[data-op="done"]');
    if (undo) undo.disabled = !has;
    if (done) done.disabled = !has;
  }

  // ---- 確定: アンカー要素を特定し、比率座標へ変換して即AIメモ化する ----
  async function finishDrawing() {
    // 「完了」連打や（async 化に伴う）再入で空メモが二重生成されるのを防ぐ。
    // 成功経路では下の stopDrawing() が drawing.active=false にするので、await 中の2回目はここで弾く。
    if (!drawing.active) return;
    if (!drawing.shapes.length) {
      toast(t('cs.toast.noDrawing'), 'warn');
      return;
    }
    const live = drawing.shapes.slice();
    const bb = shapesBBoxPx(live);
    // 中心直下の要素を特定する(自前UIは一時的にクリック透過)。
    if (drawOverlay) drawOverlay.style.pointerEvents = 'none';
    const cx = Math.max(1, Math.min(window.innerWidth - 1, bb.cx));
    const cy = Math.max(1, Math.min(window.innerHeight - 1, bb.cy));
    const target = pickDurableAnchorElement(pickAnchorElement(cx, cy), bb);
    if (drawOverlay) drawOverlay.style.pointerEvents = '';
    if (!target) {
      toast(t('cs.toast.noTarget'), 'error');
      return;
    }
    const anchor = buildAnchor(target);
    const rect = target.getBoundingClientRect();
    const W = rect.width || 1;
    const H = rect.height || 1;
    const shapes = live.map((s) => toFractionalShape(s, rect.left, rect.top, W, H));
    stopDrawing();
    // お描き完了と同時に、図形のすぐ隣へ編集可能なAIメモを生成する。中間の確認モーダルは挟まず、
    // 生成直後に本文へフォーカスしてそのまま指示を書けるようにする（不要なら🗑で消せる）。
    const saved = await upsertAnnotation({ kind: 'drawing', anchor, shapes, note: '', intent: '', forAI: true });
    focusMemo(saved?.id);
  }

  // 指定idのメモ(ページ上カード)の入力欄へフォーカスする(生成直後の即編集用)。
  function focusMemo(id) {
    if (!id) return;
    requestAnimationFrame(() => {
      const card = drawPinHost?.querySelector(`.bag-memo[${ATTR.anno}="${cssEscape(id)}"]`);
      const ta = card?.querySelector('.bag-memo-text');
      if (ta) {
        ta.focus();
        ta.scrollIntoView?.({ block: 'nearest' });
      }
    });
  }

  // 中心直下にある「自前UI/HTML以外」の要素を返す。無ければ body。
  function pickAnchorElement(x, y) {
    const list = document.elementsFromPoint(x, y) || [];
    for (const el of list) {
      if (!el || el.nodeType !== 1) continue;
      if (el.closest && el.closest(`[${ATTR.ui}]`)) continue;
      if (el.tagName === 'HTML') continue;
      return el;
    }
    return document.body || document.documentElement;
  }

  function pickDurableAnchorElement(el, shapeBox) {
    if (!el || el.nodeType !== 1) return el;
    let cur = el;
    let smallestCovering = null;
    let smallestArea = Infinity;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 8) {
      if (cur.closest && cur.closest(`[${ATTR.ui}]`)) break;
      const rect = cur.getBoundingClientRect();
      const covers = rectCoversShape(rect, shapeBox);
      const area = Math.max(1, rect.width * rect.height);
      if (covers && !isPageSizedRect(rect)) {
        if (hasDurableAnchorSignal(cur)) return cur;
        if (area < smallestArea) {
          smallestCovering = cur;
          smallestArea = area;
        }
      }
      if (cur === document.body) break;
      cur = cur.parentElement;
      depth += 1;
    }
    return smallestCovering || el;
  }

  // 「この要素は描いた四角と同じ対象か」を判定する。完全被覆(rect ⊇ box)を要求すると、人が
  // 対象より少し大きめに囲んだだけで対象コンテナが外れ(box の上辺/左辺が rect の内側に入る)、
  // 中心直下の小さい子要素へ誤アンカーしてしまう(検証シグナルダッシュボード全体を囲んだのに
  // 中の1行「토론 밀도 0%」が選ばれた事例)。そこで「box中心を含み、かつ box の大部分を覆う」
  // 緩い一致に変える。これなら対象を多少大きめ/小さめに囲んでも同一対象として掴める。
  const COVERS_AREA_RATIO = 0.5; // rect が box のこの割合以上を覆えば同一対象とみなす
  function rectCoversShape(rect, box) {
    if (!rect || !box) return true;
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const bcx = (box.minX + box.maxX) / 2;
    const bcy = (box.minY + box.maxY) / 2;
    // box中心が rect の内側にあること(無関係な隣接要素を弾く軽い位置整合)。
    if (rect.left > bcx || rect.right < bcx || rect.top > bcy || rect.bottom < bcy) return false;
    // rect と box の交差面積が box の COVERS_AREA_RATIO 以上なら「同じ対象を囲んだ」とみなす。
    // 完全被覆を要求しないので、box が rect より外側にはみ出す非対称ケースでも成立する。
    const ix = Math.max(0, Math.min(rect.right, box.maxX) - Math.max(rect.left, box.minX));
    const iy = Math.max(0, Math.min(rect.bottom, box.maxY) - Math.max(rect.top, box.minY));
    const boxArea = Math.max(1, (box.maxX - box.minX) * (box.maxY - box.minY));
    return (ix * iy) / boxArea >= COVERS_AREA_RATIO;
  }

  function isPageSizedRect(rect) {
    return rect.width >= window.innerWidth * 0.94 && rect.height >= window.innerHeight * 0.86;
  }

  function shapesBBoxPx(shapes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const s of shapes) {
      if (s.type === 'path') s.pts.forEach(([x, y]) => add(x, y));
      else if (s.type === 'arrow') {
        add(s.x1, s.y1);
        add(s.x2, s.y2);
      } else {
        add(s.x0, s.y0);
        add(s.x1, s.y1);
      }
    }
    if (!Number.isFinite(minX)) {
      minX = minY = maxX = maxY = 0;
    }
    return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  // viewport px の図形を、対象矩形に対する比率(0..1)へ変換する。
  function toFractionalShape(s, L, T, W, H) {
    const fx = (x) => (x - L) / W;
    const fy = (y) => (y - T) / H;
    if (s.type === 'rect') {
      const x = Math.min(s.x0, s.x1);
      const y = Math.min(s.y0, s.y1);
      return { type: 'rect', x: fx(x), y: fy(y), w: Math.abs(s.x1 - s.x0) / W, h: Math.abs(s.y1 - s.y0) / H, color: s.color, width: s.width };
    }
    if (s.type === 'ellipse') {
      return {
        type: 'ellipse',
        cx: fx((s.x0 + s.x1) / 2),
        cy: fy((s.y0 + s.y1) / 2),
        rx: Math.abs(s.x1 - s.x0) / 2 / W,
        ry: Math.abs(s.y1 - s.y0) / 2 / H,
        color: s.color,
        width: s.width,
      };
    }
    if (s.type === 'arrow') {
      return { type: 'arrow', x1: fx(s.x1), y1: fy(s.y1), x2: fx(s.x2), y2: fy(s.y2), color: s.color, width: s.width };
    }
    const pts = (s.pts || []).map(([x, y]) => [fx(x), fy(y)]);
    return { type: 'path', pts: decimatePoints(pts, DRAW_MAX_POINTS), color: s.color, width: s.width };
  }

  function decimatePoints(pts, max) {
    if (pts.length <= max) return pts;
    const step = pts.length / (max - 1);
    const out = [];
    for (let i = 0; i < max - 1; i += 1) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]); // 末尾点を必ず含める(合計 max 点)
    return out;
  }

  // ---- 永続レイヤの確保 ----
  function ensureDrawLayer() {
    if (drawLayer && drawLayer.isConnected) return;
    drawLayer = svgEl('svg', { class: 'bag-draw-layer' });
    drawLayer.setAttribute(ATTR.ui, '1');
    document.documentElement.appendChild(drawLayer);
  }

  function ensureDrawPinHost() {
    if (drawPinHost && drawPinHost.isConnected) return;
    drawPinHost = document.createElement('div');
    drawPinHost.className = 'bag-draw-pin-host';
    drawPinHost.setAttribute(ATTR.ui, '1');
    document.documentElement.appendChild(drawPinHost);
  }

  // お描きのペア識別色(ユーザーが選んだ図形色)と通し番号。図形・引き出し線・番号バッジ・
  // メモ枠を同色+同番号で束ね、スクショからでも「どのAIメモがどの図形を指すか」を
  // 人にもAIビジョンにも対応づけやすくする。
  function annoColor(a) {
    const c = (a?.shapes || []).find((s) => s && s.color)?.color;
    return c || DRAW_COLORS[0].hex;
  }
  function annoDrawingNumber(a) {
    return annotations.filter((x) => x.kind === 'drawing').findIndex((x) => x.id === a?.id) + 1;
  }

  // 確定済みお描きを永続レイヤに描き、その図形の隣にAIメモ(編集可能カード)を生成する。
  // メモは図形＝指す対象、メモ＝その場の指示、を1対1で結ぶ。再配置レジストリへ登録し、
  // scroll/resize で図形に追従させる。
  function renderAnnoDrawing(a, target) {
    if (!target) return; // 未解決は呼び出し側で集計
    ensureDrawLayer();
    const color = annoColor(a);
    const num = annoDrawingNumber(a);
    const g = svgEl('g', { class: 'bag-draw-g' });
    g.setAttribute(ATTR.anno, a.id);
    g.setAttribute(ATTR.ui, '1');
    const elems = [];
    for (const s of a.shapes || []) {
      const node = newShapeNode(s);
      g.appendChild(node);
      elems.push({ node, shape: s });
    }
    drawLayer.appendChild(g);

    ensureDrawPinHost();
    // 図形→メモを結ぶ引き出し線(コネクタ)。ペア色で図形・メモと束ねる。
    const connector = svgEl('line', { class: 'bag-memo-connector' });
    connector.setAttribute(ATTR.ui, '1');
    connector.style.setProperty('--bag-pair', color);
    drawLayer.appendChild(connector);

    // 図形のとなりに置く通し番号バッジ(色=図形色)。メモと対象を対応づける。
    const numEl = document.createElement('div');
    numEl.className = 'bag-anno-num';
    numEl.setAttribute(ATTR.anno, a.id);
    numEl.setAttribute(ATTR.ui, '1');
    numEl.textContent = String(num);
    numEl.style.setProperty('--bag-pair', color);
    drawPinHost.appendChild(numEl);

    const memo = buildMemoCard(a);
    memo.style.setProperty('--bag-pair', color);

    const entry = {
      anno: a,
      el: target,
      elems,
      g,
      memo,
      connector,
      numEl,
      bbox: shapesBBoxFrac(a.shapes),
    };
    drawRegistry.push(entry);
    // forAI OFF の初期状態を図形・線・番号にも反映(淡色化)。
    if (!memoForAI(a)) {
      g.classList.add('bag-draw-g--off');
      connector.classList.add('bag-memo-connector--off');
      numEl.classList.add('bag-anno-num--off');
    }
    redrawEntry(entry);
    layoutMemos(); // 既存メモも含めて一括再配置(右ガター整列 + 重なり回避)
    setupDrawingReposition();
  }

  // お描きの隣に置く編集可能なAIメモカードを作る。
  // 構成: ヘッダ(番号＋ラベル)、編集テキスト、フッタ(forAIトグル＋削除)。
  function buildMemoCard(a) {
    const card = document.createElement('div');
    card.className = 'bag-memo';
    card.setAttribute(ATTR.anno, a.id);
    card.setAttribute(ATTR.ui, '1');
    card.style.setProperty('--bag-pair', annoColor(a));

    const head = document.createElement('div');
    head.className = 'bag-memo-head';
    // 図形と同じ通し番号チップ(色=図形色)。図形側の番号バッジと対応する。
    const numChip = document.createElement('span');
    numChip.className = 'bag-memo-num';
    numChip.textContent = String(annoDrawingNumber(a));
    const tag = document.createElement('span');
    tag.className = 'bag-memo-tag';
    tag.textContent = t('cs.memo.tag');
    head.append(numChip, tag);

    const ta = document.createElement('textarea');
    ta.className = 'bag-memo-text';
    ta.rows = 2;
    ta.placeholder = t('cs.memo.placeholder');
    ta.value = a.note || '';

    const foot = document.createElement('div');
    foot.className = 'bag-memo-foot';
    const toggle = document.createElement('label');
    toggle.className = 'bag-memo-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = memoForAI(a);
    const toggleText = document.createElement('span');
    toggleText.textContent = t('cs.memo.toAI');
    toggle.append(cb, toggleText);
    const actions = document.createElement('div');
    actions.className = 'bag-memo-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'bag-memo-save';
    saveBtn.textContent = t('cs.memo.save');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'bag-memo-del';
    del.title = t('cs.memo.deleteTitle');
    del.setAttribute('aria-label', t('cs.memo.deleteAria'));
    del.textContent = '🗑';
    actions.append(saveBtn, del);
    foot.append(toggle, actions);

    card.append(head, ta, foot);

    // 編集テキストは入力が止まったら保存する(過剰書き込みを抑える)。
    // 保存は storage 書き込み→(サイドパネル経由で)再描画要求につながるため、編集中の
    // フォーカス/IME変換を守る仕組み(isMemoEditing / pendingMemoRender)と必ず併用する。
    let saveTimer = null;
    const saveMemoNow = async () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      memoComposing = false;
      await updateMemoFields(a.id, { note: ta.value.trim() });
      toast(t('cs.toast.memoSaved'), 'success');
    };
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        if (memoComposing) return; // IME変換確定前は保存しない(compositionendで保存する)
        updateMemoFields(a.id, { note: ta.value.trim() });
      }, 500);
    };
    ta.addEventListener('input', scheduleSave);
    // IME変換中は保存も再描画も止め、変換が飛ぶのを防ぐ。確定(compositionend)で保存を再開する。
    ta.addEventListener('compositionstart', () => {
      memoComposing = true;
    });
    ta.addEventListener('compositionend', () => {
      memoComposing = false;
      scheduleSave();
    });
    ta.addEventListener('blur', () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      memoComposing = false;
      updateMemoFields(a.id, { note: ta.value.trim() });
      // 編集中に保留した再描画があれば、フォーカスが外れた後(activeElement確定後)に反映する。
      // 直接呼ぶと blur 中は activeElement が未確定で、隣のメモへフォーカス移動中に誤って作り直す恐れがある。
      requestAnimationFrame(flushPendingMemoRender);
    });
    cb.addEventListener('change', () => {
      const off = !cb.checked;
      card.classList.toggle('bag-memo--off', off);
      // AIに渡さないメモは、図形・引き出し線・番号バッジも淡色化して文脈から外れたと分かるようにする。
      const entry = drawRegistry.find((e) => e.anno?.id === a.id);
      entry?.g?.classList.toggle('bag-draw-g--off', off);
      entry?.connector?.classList.toggle('bag-memo-connector--off', off);
      entry?.numEl?.classList.toggle('bag-anno-num--off', off);
      updateMemoFields(a.id, { forAI: cb.checked });
    });
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      saveMemoNow();
    });
    // メモ⇄図形の相互ハイライト(マウスホバーで対象ペアを強調し、他ペアを減光)。
    // mouseenter ではなく mousemove で起動する: 描画直後に新規メモがカーソル下へ現れて
    // 境界イベント(mouseenter)が発火しても、実際にポインタを動かすまでは反応させない。
    // テキストエリアの focus は連動させない(生成直後の自動フォーカスで他メモが減光するのを防ぐ)。
    card.addEventListener('mousemove', () => setMemoFocus(a.id, true));
    card.addEventListener('mouseleave', () => setMemoFocus(a.id, false));
    del.addEventListener('click', (e) => {
      e.preventDefault();
      deleteAnnotation(a.id);
    });
    if (!cb.checked) card.classList.add('bag-memo--off');
    drawPinHost.append(card);
    setupMemoDrag(card, head, a); // ヘッダをハンドルにドラッグ移動できるようにする
    return card;
  }

  // メモヘッダをハンドルにしたドラッグ移動。位置は memoPos(図形ボックス相対オフセット)として
  // 永続化し、再訪時に復元する。スクロール追従は既存の reposition がそのまま面倒を見る。
  function setupMemoDrag(card, head, a) {
    let drag = null;
    head.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const entry = drawRegistry.find((x) => x.anno?.id === a.id);
      if (!entry) return;
      const rect = card.getBoundingClientRect();
      drag = {
        entry,
        startX: ev.clientX,
        startY: ev.clientY,
        offX: ev.clientX - rect.left,
        offY: ev.clientY - rect.top,
        moved: false,
      };
      try {
        head.setPointerCapture(ev.pointerId);
      } catch {
        /* 一部環境ではキャプチャ不可 */
      }
      ev.preventDefault();
    });
    head.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      // クリックとドラッグを分けるため、3px 動くまでは開始しない。
      if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.entry._dragging = true; // 自動レイアウトに位置を奪われないよう印を付ける
        card.classList.add('bag-memo--dragging');
      }
      const mw = card.offsetWidth || 240;
      const mh = card.offsetHeight || 92;
      const left = clamp(ev.clientX - drag.offX, 4, Math.max(4, window.innerWidth - mw - 4));
      const top = clamp(ev.clientY - drag.offY, 4, Math.max(4, window.innerHeight - mh - 4));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      updateMemoConnectorLive(drag.entry); // 引き出し線を追従させる
      ev.preventDefault();
    });
    const end = (ev) => {
      if (!drag) return;
      const { entry, moved } = drag;
      try {
        head.releasePointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      card.classList.remove('bag-memo--dragging');
      drag = null;
      if (!moved) return;
      entry._dragging = false;
      // 現在の図形ボックス左上からの px オフセットとして保存する(スクロールしても相対で追従)。
      const box = entry._box || { L: 0, T: 0 };
      const left = parseFloat(card.style.left) || 0;
      const top = parseFloat(card.style.top) || 0;
      updateMemoFields(a.id, { memoPos: { dx: Math.round(left - box.L), dy: Math.round(top - box.T) } });
      layoutMemos(); // 他の自動メモが手動メモを避け直すよう再パッキング
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
    // ヘッダのダブルクリックで「覚えた位置」を破棄し、自動配置へ戻す。
    head.addEventListener('dblclick', (ev) => {
      if (!a.memoPos) return;
      ev.preventDefault();
      const entry = drawRegistry.find((x) => x.anno?.id === a.id);
      if (entry) entry._dragging = false;
      updateMemoFields(a.id, { memoPos: null });
      layoutMemos();
    });
  }

  // メモ本文・forAI・手動配置(memoPos)を保存する(他フィールドは保持)。
  async function updateMemoFields(id, patch) {
    const a = annotations.find((x) => x.id === id);
    if (!a) return;
    let changed = false;
    if ('note' in patch && (a.note || '') !== patch.note) {
      a.note = patch.note;
      changed = true;
    }
    if ('forAI' in patch && memoForAI(a) !== patch.forAI) {
      a.forAI = patch.forAI;
      changed = true;
    }
    // ドラッグで覚えさせた手動位置(図形ボックス左上からの px オフセット)。null/未指定で自動配置へ戻す。
    if ('memoPos' in patch) {
      const next = patch.memoPos && Number.isFinite(patch.memoPos.dx) ? patch.memoPos : null;
      if (JSON.stringify(a.memoPos ?? null) !== JSON.stringify(next)) {
        if (next) a.memoPos = next;
        else delete a.memoPos;
        changed = true;
      }
    }
    if (!changed) return;
    await persistAnnotations();
    if (a.kind === 'drawing') notifyVisualFeedbackChanged('update');
  }

  // メモ⇄図形の相互ハイライト。on=true で対象ペアを強調し、他ペアを減光する。
  // 現在フォーカス中のペアIDを保持し、focusOn は同一IDなら無視、focusOff は自分が
  // 所有している時だけ解除する(A→B 移動時の取り違えを防ぐ)。
  let memoFocusId = null;
  function setMemoFocus(id, on) {
    if (on) {
      if (memoFocusId === id) return;
      memoFocusId = id;
    } else {
      if (memoFocusId !== id) return; // 既に別ペアにフォーカスが移っている場合は触らない
      memoFocusId = null;
    }
    for (const e of drawRegistry) {
      const active = memoFocusId != null && e.anno?.id === memoFocusId;
      const dim = memoFocusId != null && !active;
      e.memo?.classList.toggle('bag-memo--active', active);
      e.memo?.classList.toggle('bag-memo--dim', dim);
      e.g?.classList.toggle('bag-draw-g--active', active);
      e.g?.classList.toggle('bag-draw-g--dim', dim);
      e.connector?.classList.toggle('bag-memo-connector--active', active);
      e.connector?.classList.toggle('bag-memo-connector--dim', dim);
      e.numEl?.classList.toggle('bag-anno-num--active', active);
      e.numEl?.classList.toggle('bag-anno-num--dim', dim);
    }
  }

  function shapesBBoxFrac(shapes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const s of shapes || []) {
      if (s.type === 'path') (s.pts || []).forEach(([x, y]) => add(x, y));
      else if (s.type === 'arrow') {
        add(s.x1, s.y1);
        add(s.x2, s.y2);
      } else if (s.type === 'rect') {
        add(s.x, s.y);
        add(s.x + (s.w || 0), s.y + (s.h || 0));
      } else if (s.type === 'ellipse') {
        add(s.cx - s.rx, s.cy - s.ry);
        add(s.cx + s.rx, s.cy + s.ry);
      }
    }
    if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
    return { minX, minY, maxX, maxY };
  }

  // 誤アンカー(対象より大幅に小さい子要素)に起因する「壊れた保存比率」の検出。描画時アンカー選定の
  // 緩和(rectCoversShape)で新規注釈の比率はもう壊れないが、過去に保存された壊れ注釈が別要素へ解決され
  // 無関係な位置へ巨大な点線を出すのを最後の砦として止めるための判定。
  const DRAW_FRAC_MAX_OUT = 1.0; // 0..1 の外側にこれ以上はみ出す比率は誤アンカーの徴候
  const DRAW_FRAC_MAX_SPAN = 3; // 対象要素のこの倍率を超える図形は誤アンカーの徴候
  function isDrawingFractionBroken(shapes) {
    if (!shapes || !shapes.length) return false;
    const bb = shapesBBoxFrac(shapes);
    return (
      bb.minX < -DRAW_FRAC_MAX_OUT ||
      bb.minY < -DRAW_FRAC_MAX_OUT ||
      bb.maxX > 1 + DRAW_FRAC_MAX_OUT ||
      bb.maxY > 1 + DRAW_FRAC_MAX_OUT ||
      bb.maxX - bb.minX > DRAW_FRAC_MAX_SPAN ||
      bb.maxY - bb.minY > DRAW_FRAC_MAX_SPAN
    );
  }
  const warnedBrokenDrawings = new Set();
  function warnBrokenDrawingOnce(a) {
    if (!a || warnedBrokenDrawings.has(a.id)) return;
    warnedBrokenDrawings.add(a.id);
    try {
      console.warn(
        '[bag] お描き注釈のアンカー比率が壊れているため描画を抑止しました。描き直してください / ' +
          'Drawing annotation has a broken anchor ratio; skipped rendering. Please redraw it.',
        a.id
      );
    } catch {
      /* console 不在環境は無視 */
    }
  }

  // 対象要素の現在位置(viewport px)から、お描きの全図形・メモを再配置する。
  function redrawEntry(entry) {
    const el = entry.el;
    if (!el || !el.isConnected) return;
    const rect = el.getBoundingClientRect();
    const W = rect.width || 1;
    const H = rect.height || 1;
    const L = rect.left;
    const T = rect.top;
    const fx = (x) => L + x * W;
    const fy = (y) => T + y * H;
    for (const { node, shape } of entry.elems) {
      if (shape.type === 'rect') {
        const x1 = fx(shape.x);
        const y1 = fy(shape.y);
        const x2 = fx(shape.x + shape.w);
        const y2 = fy(shape.y + shape.h);
        node.setAttribute('x', Math.min(x1, x2));
        node.setAttribute('y', Math.min(y1, y2));
        node.setAttribute('width', Math.abs(x2 - x1));
        node.setAttribute('height', Math.abs(y2 - y1));
      } else if (shape.type === 'ellipse') {
        node.setAttribute('cx', fx(shape.cx));
        node.setAttribute('cy', fy(shape.cy));
        node.setAttribute('rx', Math.abs(shape.rx * W));
        node.setAttribute('ry', Math.abs(shape.ry * H));
      } else if (shape.type === 'arrow') {
        node.setAttribute('points', arrowPointsPx(fx(shape.x1), fy(shape.y1), fx(shape.x2), fy(shape.y2)));
      } else {
        node.setAttribute('points', (shape.pts || []).map(([x, y]) => `${fx(x)},${fy(y)}`).join(' '));
      }
    }
    // bbox(viewport px)を保持し、番号バッジを図形の左上に置く。メモ本体の配置は layoutMemos が一括で行う。
    entry._box = {
      L: fx(entry.bbox.minX),
      T: fy(entry.bbox.minY),
      R: fx(entry.bbox.maxX),
      B: fy(entry.bbox.maxY),
    };
    if (entry.numEl) {
      entry.numEl.style.display = '';
      entry.numEl.style.left = `${entry._box.L}px`;
      entry.numEl.style.top = `${entry._box.T}px`;
    }
  }

  const MEMO_GAP = 12; // 図形とメモの間隔(px)
  const MEMO_STACK_GAP = 10; // メモ同士の最小縦間隔(px)

  // 全メモを一括配置する。各メモは自分のお描き図形のすぐ隣(右→左→下)へ置き、
  // メモ同士が重なる時だけ縦方向にパッキングする。各 entry._box は redrawEntry が更新済みであること。
  function layoutMemos() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // ドラッグ操作中(_dragging)のメモは触らない: 手で動かしている最中に自動配置で位置を奪わない。
    const live = drawRegistry.filter((e) => e.memo && e.el?.isConnected && e._box && !e._dragging);

    const open = live;
    if (!open.length) return;
    // 視覚順(上→下)に並べると番号順に読み下せ、パッキングも安定する。
    open.sort((a, b) => (a._box.T + a._box.B) / 2 - (b._box.T + b._box.B) / 2);

    const placed = []; // 既配置メモの矩形(重なり回避用)

    // ドラッグで覚えさせた手動位置を持つメモを先に置き、placed に積む。
    // 残りの自動配置メモは、手動メモを既配置として避ける(重なり回避の対象に含める)。
    const manual = open.filter((e) => e.anno?.memoPos);
    const auto = open.filter((e) => !e.anno?.memoPos);
    for (const e of manual) placeManualMemo(e, placed, vw, vh);
    if (!auto.length) return;

    for (const e of auto) {
      const box = e._box;
      const memo = e.memo;
      const mw = memo.offsetWidth || 240;
      const mh = memo.offsetHeight || 92;
      const cy = (box.T + box.B) / 2;
      let side = 'right';
      let left;
      let top = cy - mh / 2;

      left = box.R + MEMO_GAP;
      if (left + mw > vw - 4) {
        // 右に収まらない → 左へ反転、それも無理なら下へ。
        const leftCandidate = box.L - MEMO_GAP - mw;
        if (leftCandidate >= 4) {
          side = 'left';
          left = leftCandidate;
        } else {
          side = 'bottom';
          left = clamp(box.L, 4, vw - mw - 4);
          top = box.B + MEMO_GAP;
        }
      }
      left = clamp(left, 4, vw - mw - 4);
      if (side === 'bottom' && top + mh > vh - 4) top = box.T - MEMO_GAP - mh;
      top = clamp(top, 4, Math.max(4, vh - mh - 4));
      // メモ同士の重なりを避けて下へずらす。
      top = avoidMemoOverlap(left, top, mw, mh, placed, vh);
      placed.push({ l: left, r: left + mw, t: top, b: top + mh });

      memo.style.left = `${left}px`;
      memo.style.top = `${top}px`;
      memo.dataset.side = side;
      drawMemoConnector(e, box, left, top, mw, mh, side, cy);
    }
  }

  // 既配置メモ(placed)と水平に重なる場合は、重ならない位置まで下へずらした top を返す。
  function avoidMemoOverlap(left, top, mw, mh, placed, vh) {
    let t = top;
    for (let guard = 0; guard < 60; guard += 1) {
      let moved = false;
      for (const r of placed) {
        const overlapX = left < r.r && left + mw > r.l;
        const overlapY = t < r.b + MEMO_STACK_GAP && t + mh > r.t - MEMO_STACK_GAP;
        if (overlapX && overlapY) {
          t = r.b + MEMO_STACK_GAP;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return clamp(t, 4, Math.max(4, vh - mh - 4));
  }

  // 図形の最寄り辺の点 → メモの最寄り辺の点を結ぶ引き出し線を描く。
  function drawMemoConnector(entry, box, left, top, mw, mh, side, cy) {
    if (!entry.connector) return;
    let sx;
    let sy = clamp(cy, box.T, box.B);
    let mx;
    let my = clamp(cy, top, top + mh);
    if (side === 'left') {
      sx = box.L;
      mx = left + mw;
    } else if (side === 'bottom') {
      sx = clamp(left + mw / 2, box.L, box.R);
      sy = box.B;
      mx = clamp(left + mw / 2, left, left + mw);
      my = top;
    } else {
      // right: 図形右辺 → メモ左辺。
      sx = box.R;
      mx = left;
    }
    entry.connector.style.display = '';
    entry.connector.setAttribute('x1', sx);
    entry.connector.setAttribute('y1', sy);
    entry.connector.setAttribute('x2', mx);
    entry.connector.setAttribute('y2', my);
  }

  // ドラッグで覚えさせた手動位置(図形ボックス左上からの px オフセット memoPos{dx,dy})にメモを置く。
  // スクロール/リサイズでも entry._box が再計算されるので、相対オフセットを保つだけで図形に追従する。
  function placeManualMemo(e, placed, vw, vh) {
    const box = e._box;
    const memo = e.memo;
    const mw = memo.offsetWidth || 240;
    const mh = memo.offsetHeight || 92;
    const pos = e.anno.memoPos || { dx: 0, dy: 0 };
    const left = clamp(box.L + pos.dx, 4, Math.max(4, vw - mw - 4));
    const top = clamp(box.T + pos.dy, 4, Math.max(4, vh - mh - 4));
    memo.style.left = `${left}px`;
    memo.style.top = `${top}px`;
    const side = manualSide(box, left, top, mw, mh);
    memo.dataset.side = side;
    drawMemoConnector(e, box, left, top, mw, mh, side, (box.T + box.B) / 2);
    placed.push({ l: left, r: left + mw, t: top, b: top + mh });
  }

  // 手動配置メモが図形のどちら側にあるかを推定し、引き出し線の接続辺を選ぶ。
  function manualSide(box, left, top, mw, mh) {
    if (top >= box.B) return 'bottom';
    if (left + mw <= box.L) return 'left';
    if (left >= box.R) return 'right';
    return left + mw / 2 < (box.L + box.R) / 2 ? 'left' : 'right';
  }

  // ドラッグ中に当該メモの引き出し線だけを更新する(全体レイアウトは走らせない)。
  function updateMemoConnectorLive(e) {
    const box = e._box;
    const memo = e.memo;
    if (!box || !memo) return;
    const mw = memo.offsetWidth || 240;
    const mh = memo.offsetHeight || 92;
    const left = parseFloat(memo.style.left) || 0;
    const top = parseFloat(memo.style.top) || 0;
    const side = manualSide(box, left, top, mw, mh);
    memo.dataset.side = side;
    drawMemoConnector(e, box, left, top, mw, mh, side, (box.T + box.B) / 2);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function setupDrawingReposition() {
    if (drawRepositionSetup) return;
    drawRepositionSetup = true;
    const onMove = () => {
      if (drawRaf) return;
      drawRaf = requestAnimationFrame(() => {
        drawRaf = 0;
        repositionDrawings();
      });
    };
    // capture:true で、入れ子のスクロールコンテナのスクロールも拾う。
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove, true);
  }

  function repositionDrawings() {
    for (const entry of drawRegistry) redrawEntry(entry);
    repositionOutlineBoxes(); // 補足/選択中の赤枠オーバーレイもスクロール/リサイズに追従させる
    layoutMemos();
    renderWorkflowConnectors(); // 順序コネクタもスクロール/リサイズに追従させる
  }

  // ===========================================================================
  // 補足(note)/選択中(pick)の対象を囲む赤枠オーバーレイ
  // CSS outline は対象要素自身に描かれるため、サイトの overflow:hidden(祖先クリップ)や
  // z-index(兄弟の上塗り)・transform で枠が欠けることがある(=要素によって囲めたり囲めなかったり)。
  // hover の .bag-pick-overlay と同じく、祖先から切り離した fixed の独立レイヤに枠を描けば、
  // どんなページCSSでも確実に対象を囲める。スクロール/リサイズ追従は repositionDrawings
  // (setupDrawingReposition の scroll/resize リスナ)へ相乗りする。
  // ===========================================================================
  let outlineHost = null;
  let outlineBoxes = []; // [{ target, box, kind }] kind: 'note'(保存済み) | 'pick'(選択中の一時枠)

  function ensureOutlineHost() {
    if (outlineHost && outlineHost.isConnected) return outlineHost;
    outlineHost = document.createElement('div');
    outlineHost.className = 'bag-anno-outline-host';
    outlineHost.setAttribute(ATTR.ui, '1');
    document.documentElement.appendChild(outlineHost);
    return outlineHost;
  }

  // 対象要素を囲む赤枠 div を1つ追加する。旧 CSS outline の outline-offset:2px と見た目を
  // 揃えるため、矩形を 2px 外側へ広げて囲む(box-sizing:border-box で枠線込み)。
  // opts.caption={number,text} を渡すと、枠の上に「番号＋本文」を常時表示する手順キャプションも作る。
  function addOutlineBox(target, kind, opts) {
    if (!target || target.nodeType !== 1) return null;
    const box = document.createElement('div');
    box.className = 'bag-anno-outline-box';
    box.setAttribute(ATTR.ui, '1');
    ensureOutlineHost().appendChild(box);
    let caption = null;
    if (opts && opts.caption) {
      caption = buildStepCaption(opts.caption.number, opts.caption.text);
      ensureOutlineHost().appendChild(caption);
    }
    const entry = { target, box, kind, caption };
    outlineBoxes.push(entry);
    positionOutlineBox(entry);
    setupDrawingReposition(); // お描きが無くてもスクロール/リサイズ追従を有効化
    return entry;
  }

  // 「① 本文」の常時表示キャプション要素を作る(最上位レイヤ用、pointer-events:none)。
  // 番号で人間に手順を示し、本文(メモ)は hover 不要で常に読める。
  function buildStepCaption(number, text) {
    const cap = document.createElement('div');
    cap.className = 'bag-step-caption';
    cap.setAttribute(ATTR.ui, '1');
    const num = document.createElement('span');
    num.className = 'bag-step-caption-num';
    num.textContent = String(number);
    const body = document.createElement('span');
    body.className = 'bag-step-caption-text';
    body.textContent = text || '';
    cap.append(num, body);
    return cap;
  }

  function positionOutlineBox(entry) {
    const { target, box, caption } = entry;
    if (!target.isConnected) {
      box.style.display = 'none';
      if (caption) caption.style.display = 'none';
      return;
    }
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      box.style.display = 'none'; // detached 相当(非表示・ゼロ矩形)は枠を隠し、再描画での再解決に委ねる
      if (caption) caption.style.display = 'none';
      return;
    }
    Object.assign(box.style, {
      display: 'block',
      left: `${r.left - 2}px`,
      top: `${r.top - 2}px`,
      width: `${r.width + 4}px`,
      height: `${r.height + 4}px`,
    });
    if (caption) positionStepCaption(caption, r);
  }

  // キャプションは枠の左上の“上”に出す。上に余白が無ければ枠の下へ回し、右端も画面内へ収める。
  function positionStepCaption(caption, r) {
    caption.style.display = 'flex';
    caption.style.left = '0px';
    caption.style.top = '-9999px'; // 寸法計測のため一旦画面外で可視化
    const cw = caption.offsetWidth || 0;
    const ch = caption.offsetHeight || 0;
    let left = Math.max(4, r.left - 2);
    if (left + cw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - cw - 4);
    let top = r.top - 2 - ch - 4; // 既定は枠の上
    if (top < 4) top = r.bottom + 2 + 4; // 上に入らなければ枠の下へ回す
    top = Math.max(4, Math.min(top, window.innerHeight - ch - 4)); // 下端も画面内へ収める(横clampと対称)
    caption.style.left = `${left}px`;
    caption.style.top = `${top}px`;
  }

  function repositionOutlineBoxes() {
    for (const entry of outlineBoxes) positionOutlineBox(entry);
  }

  // kind 指定でその種別だけ、未指定で全部の枠を撤去する。
  // note 枠は renderAnnotations が毎回作り直し、pick 枠は openAuthoring/closeAuthoring が管理する。
  function clearOutlineBoxes(kind) {
    outlineBoxes = outlineBoxes.filter((entry) => {
      if (kind && entry.kind !== kind) return true;
      entry.box.remove();
      entry.caption?.remove();
      return false;
    });
  }

  // ===========================================================================
  // お描きワークフロー
  // 既存の「通し番号(annoDrawingNumber)」を手順番号として流用し、番号付きのお描きを
  // 1→2→3 と順序コネクタで結ぶ。再生で各手順をスポットライトし、AIには手順として渡す。
  // すべて加算的: 既定では順序コネクタ/再生UIは出さず、お描きが2件以上の時だけパネルを出す。
  // ===========================================================================

  // 手順順(通し番号の昇順)に並べた drawRegistry のエントリ。
  function workflowSteps() {
    return drawRegistry
      .filter((e) => e.anno?.kind === 'drawing')
      .slice()
      .sort((a, b) => annoDrawingNumber(a.anno) - annoDrawingNumber(b.anno));
  }

  // パネル・順序コネクタをまとめて最新化する(renderAnnotations / reposition の後に呼ぶ)。
  function syncWorkflowUi() {
    updateWorkflowPanel();
    renderWorkflowConnectors();
  }

  // 順序コネクタの矢印定義(drawLayer は renderAnnotations で都度クリアされるので毎回確認)。
  function ensureWorkflowDefs() {
    if (!drawLayer || drawLayer.querySelector('#bag-wf-arrow')) return;
    const defs = svgEl('defs');
    const marker = svgEl('marker', {
      id: 'bag-wf-arrow', markerWidth: '8', markerHeight: '8',
      refX: '6', refY: '3', orient: 'auto', markerUnits: 'userSpaceOnUse',
    });
    const path = svgEl('path', { class: 'bag-wf-arrowhead', d: 'M0,0 L6,3 L0,6 Z' });
    path.setAttribute(ATTR.ui, '1');
    marker.appendChild(path);
    defs.appendChild(marker);
    drawLayer.prepend(defs);
  }

  // 手順 i の番号バッジ中心 → 手順 i+1 の番号バッジ中心 を結ぶ順序コネクタを描く。
  // 番号バッジは translate(-50%,-50%) で entry._box.L/T(図形左上)に中心が来るので、その点を使う。
  function renderWorkflowConnectors() {
    for (const ln of wfConnectors) ln.remove();
    wfConnectors = [];
    if (!wfMode || !drawLayer) return;
    const steps = workflowSteps().filter((e) => e.el?.isConnected && e._box);
    if (steps.length < 2) return;
    ensureWorkflowDefs();
    for (let i = 0; i < steps.length - 1; i += 1) {
      const a = steps[i]._box;
      const b = steps[i + 1]._box;
      const ln = svgEl('line', {
        class: 'bag-wf-connector',
        x1: a.L, y1: a.T, x2: b.L, y2: b.T,
        'marker-end': 'url(#bag-wf-arrow)',
      });
      ln.setAttribute(ATTR.ui, '1');
      if (wfPlayIdx >= 0 && i < wfPlayIdx) ln.classList.add('bag-wf-connector--done');
      drawLayer.appendChild(ln);
      wfConnectors.push(ln);
    }
  }

  // 手順ハイライト(再生・パネル操作)。step は1始まり、null で全解除。
  function workflowHighlight(step) {
    for (const e of drawRegistry) {
      const isStep = step != null && annoDrawingNumber(e.anno) === step;
      const dim = step != null && !isStep;
      e.memo?.classList.toggle('bag-memo--active', isStep);
      e.memo?.classList.toggle('bag-memo--dim', dim);
      e.g?.classList.toggle('bag-draw-g--active', isStep);
      e.g?.classList.toggle('bag-draw-g--dim', dim);
      e.connector?.classList.toggle('bag-memo-connector--active', isStep);
      e.connector?.classList.toggle('bag-memo-connector--dim', dim);
      e.numEl?.classList.toggle('bag-anno-num--active', isStep);
      e.numEl?.classList.toggle('bag-anno-num--dim', dim);
    }
    wfConnectors.forEach((ln, i) => {
      ln.classList.toggle('bag-wf-connector--done', step != null && i < step - 1);
    });
  }

  // 指定手順へ移動してスポットライト(任意でスクロール)。
  function workflowGoto(step, scroll) {
    const steps = workflowSteps();
    if (!steps.length) return;
    const target = clamp(step, 1, steps.length);
    wfPlayIdx = target - 1;
    workflowHighlight(target);
    if (scroll) {
      const el = steps[wfPlayIdx]?.el;
      if (el?.isConnected) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    updateWorkflowPanel();
  }

  // 1手順ずつ順送りで再生(スポットライト + スクロール)。
  function workflowPlay() {
    const steps = workflowSteps();
    if (!steps.length) return;
    workflowStop(false);
    let i = 0;
    const tick = () => {
      if (i >= steps.length) { workflowStop(false); return; }
      workflowGoto(i + 1, true);
      i += 1;
    };
    tick();
    wfPlayTimer = setInterval(tick, WF_PLAY_MS);
    updateWorkflowPanel();
  }

  function workflowStop(clearHighlight) {
    if (wfPlayTimer) { clearInterval(wfPlayTimer); wfPlayTimer = 0; }
    if (clearHighlight) { wfPlayIdx = -1; workflowHighlight(null); renderWorkflowConnectors(); }
    updateWorkflowPanel();
  }

  // 操作パネル(左下)。お描きが2件以上の時だけ表示する。一度だけ生成しイベントを束ねる。
  function ensureWorkflowPanel() {
    if (wfPanel && wfPanel.isConnected) return wfPanel;
    wfPanel = document.createElement('div');
    wfPanel.className = 'bag-wf-panel';
    wfPanel.setAttribute(ATTR.ui, '1');
    wfPanel.hidden = true;
    const wfTitle = escapeHtml(t('cs.wf.title'));
    const wfShowOrder = escapeHtml(t('cs.wf.showOrder'));
    const wfPrev = escapeHtml(t('cs.wf.prev'));
    const wfPlayPause = escapeHtml(t('cs.wf.playPause'));
    const wfNext = escapeHtml(t('cs.wf.next'));
    wfPanel.innerHTML =
      '<div class="bag-wf-row">' +
      `<span class="bag-wf-title">${wfTitle}</span>` +
      '<span class="bag-wf-count" data-wf="count"></span>' +
      '</div>' +
      `<label class="bag-wf-toggle"><input type="checkbox" data-wf="mode"> ${wfShowOrder}</label>` +
      '<div class="bag-wf-controls" data-wf="controls" hidden>' +
      `<button type="button" class="bag-wf-btn" data-wf="prev" title="${wfPrev}" aria-label="${wfPrev}">⏮</button>` +
      `<button type="button" class="bag-wf-btn" data-wf="play" title="${wfPlayPause}" aria-label="${wfPlayPause}">▶</button>` +
      `<button type="button" class="bag-wf-btn" data-wf="next" title="${wfNext}" aria-label="${wfNext}">⏭</button>` +
      '<span class="bag-wf-step" data-wf="step"></span>' +
      '</div>';
    document.documentElement.appendChild(wfPanel);
    const q = (s) => wfPanel.querySelector(`[data-wf="${s}"]`);
    q('mode').addEventListener('change', (e) => {
      wfMode = e.target.checked;
      if (!wfMode) workflowStop(true);
      syncWorkflowUi();
    });
    q('prev').addEventListener('click', () => workflowGoto((wfPlayIdx < 0 ? 1 : wfPlayIdx + 1) - 1, true));
    q('next').addEventListener('click', () => workflowGoto((wfPlayIdx < 0 ? 0 : wfPlayIdx + 1) + 1, true));
    q('play').addEventListener('click', () => (wfPlayTimer ? workflowStop(false) : workflowPlay()));
    return wfPanel;
  }

  function updateWorkflowPanel() {
    const n = workflowSteps().length;
    if (n < 2) {
      if (wfPlayTimer) { clearInterval(wfPlayTimer); wfPlayTimer = 0; }
      if (wfPanel) wfPanel.hidden = true;
      return;
    }
    ensureWorkflowPanel();
    wfPanel.hidden = false;
    const q = (s) => wfPanel.querySelector(`[data-wf="${s}"]`);
    q('count').textContent = t('cs.wf.count', { count: n });
    q('mode').checked = wfMode;
    q('controls').hidden = !wfMode;
    q('play').textContent = wfPlayTimer ? '⏸' : '▶';
    q('step').textContent = wfPlayIdx >= 0 ? `${wfPlayIdx + 1} / ${n}` : `– / ${n}`;
  }

  // AI連携: 番号付きお描きを手順順に構造化して返す(explainWorkflow / COLLECT_CONTEXT 共用)。
  function buildWorkflowContext() {
    const steps = annotations
      .filter((x) => x.kind === 'drawing')
      .map((a, i) => {
        const t = a.anchor ? resolveAnchor(a.anchor) : null;
        return {
          step: i + 1,
          target: t ? truncate(labelOf(t), 60) : '',
          shape: describeShapes(a.shapes),
          note: a.note || '',
          forAI: memoForAI(a),
          resolved: Boolean(t),
        };
      });
    return { count: steps.length, steps };
  }

  // AI連携: 指定要素を囲む番号付きお描き(手順)を1つ追加する。番号は通し番号の続きで自動採番。
  async function addWorkflowStep(a) {
    const el = requireEl(a);
    const kindMap = { ellipse: 'ellipse', 円: 'ellipse', circle: 'ellipse', rect: 'rect', 四角: 'rect', arrow: 'arrow', 矢印: 'arrow' };
    const kind = kindMap[a.kind] || 'rect';
    const color = /^#[0-9a-fA-F]{3,8}$/.test(a.color || '') ? a.color : '#2563eb';
    const width = DRAW_DEFAULT_WIDTH;
    let shape;
    if (kind === 'ellipse') shape = { type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.62, ry: 0.72, color, width };
    else if (kind === 'arrow') shape = { type: 'arrow', x1: -0.28, y1: -0.32, x2: 0.12, y2: 0.12, color, width };
    else shape = { type: 'rect', x: -0.04, y: -0.08, w: 1.08, h: 1.16, color, width };
    const anchor = buildAnchor(el);
    const saved = await upsertAnnotation({ kind: 'drawing', anchor, shapes: [shape], note: a.note || '', forAI: true });
    return {
      added: saved?.id || true,
      step: annotations.filter((x) => x.kind === 'drawing').length,
      target: truncate(labelOf(el), 60),
    };
  }

  // ===========================================================================
  // 視覚フィードバックの収集（vision ブリッジ用）
  // お描き注釈を「現在のビューポート px」へ解決して返す。service worker が
  // captureVisibleTab した PNG の上に、この座標で図形を burn-in する。
  // 比率(0..1)座標は対象要素の現在矩形を基準に px へ戻す（redrawEntry と同式）。
  // ===========================================================================

  // 次フレームを n 回待つ（自前UIを隠した結果が確実に描画されてから capture するため）。
  function nextFrames(n) {
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        i += 1;
        if (i >= n) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  // 比率(0..1)図形を、対象矩形(L,T,W,H)を基準にビューポート px の図形へ戻す。
  function fracShapeToPx(s, L, T, W, H) {
    const fx = (x) => L + x * W;
    const fy = (y) => T + y * H;
    const base = { type: s.type, color: s.color, width: s.width };
    if (s.type === 'rect') return { ...base, x: fx(s.x), y: fy(s.y), w: (s.w || 0) * W, h: (s.h || 0) * H };
    if (s.type === 'ellipse') return { ...base, cx: fx(s.cx), cy: fy(s.cy), rx: (s.rx || 0) * W, ry: (s.ry || 0) * H };
    if (s.type === 'arrow') return { ...base, x1: fx(s.x1), y1: fy(s.y1), x2: fx(s.x2), y2: fy(s.y2) };
    return { ...base, pts: (s.pts || []).map(([x, y]) => [fx(x), fy(y)]) };
  }

  // px 図形群の bounding box（ビューポート px）。
  function bboxOfPxShapes(shapes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const s of shapes) {
      if (s.type === 'rect') {
        add(s.x, s.y);
        add(s.x + s.w, s.y + s.h);
      } else if (s.type === 'ellipse') {
        add(s.cx - s.rx, s.cy - s.ry);
        add(s.cx + s.rx, s.cy + s.ry);
      } else if (s.type === 'arrow') {
        add(s.x1, s.y1);
        add(s.x2, s.y2);
      } else {
        (s.pts || []).forEach(([x, y]) => add(x, y));
      }
    }
    if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
    return { minX, minY, maxX, maxY };
  }

  // 注釈要素の outerHTML を上限つきで取得する。画像を使わず「メモを残した HTML 要素そのもの」を
  // CLI へ渡すための経路（画像なしの context ツールに載る）。巨大要素のトークン肥大を防ぐため
  // 最大長で切り、超過時は truncated:true を立てて全体バイト数も残す。
  const HTML_CAPTURE_MAX = 8000;
  function captureOuterHtml(el) {
    if (!el || el.nodeType !== 1) return null;
    let html = '';
    try {
      html = el.outerHTML || '';
    } catch {
      return null; // outerHTML が読めない要素（稀）は html 無しで続行
    }
    if (!html) return null;
    const bytes = html.length;
    const truncated = bytes > HTML_CAPTURE_MAX;
    return { outerHTML: truncated ? html.slice(0, HTML_CAPTURE_MAX) : html, bytes, truncated };
  }

  // 軽量な a11y 記述子（role / name / level / state）。画像なしで要素の意味を CLI に渡す。
  function captureA11y(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    const a11y = { role: roleOf(el), name: truncate(labelOf(el), 120) };
    const level = el.getAttribute('aria-level') || (/^h[1-6]$/.test(tag) ? tag.slice(1) : '');
    if (level) a11y.level = String(level);
    const states = [];
    for (const s of ['aria-disabled', 'aria-checked', 'aria-expanded', 'aria-selected', 'aria-pressed', 'aria-current', 'aria-hidden']) {
      const v = el.getAttribute(s);
      if (v != null) states.push(`${s.slice(5)}=${v}`);
    }
    if (el.disabled) states.push('disabled');
    if (states.length) a11y.states = states;
    return a11y;
  }

  // お描き注釈を vision ブリッジ用のデータに変換する。
  function collectVisualFeedbackData() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const items = [];
    for (const a of annotations) {
      // お描き(drawing)＋メモ(note)を AI/daemon へ送る。marker/button は対象外。
      if (a.kind !== 'drawing' && a.kind !== 'note') continue;
      if (!memoForAI(a)) continue; // 「AIに渡す」OFF は除外（note は forAI 未設定=ON）
      const isDrawing = a.kind === 'drawing';
      // メモは本文が空なら送らない（空メモが inbox/sendCount を汚さない）。
      // 文字列化は sendCount / sidepanel と同一式（String(...).trim()）に揃える。
      if (!isDrawing && !String(a.note || '').trim()) continue;
      const target = a.anchor ? resolveAnchor(a.anchor) : null;
      const resolved = Boolean(target);
      let shapesPx = [];
      let bboxPx = null;
      let inViewport = false;
      if (resolved) {
        const rect = target.getBoundingClientRect();
        const W = rect.width || 1;
        const H = rect.height || 1;
        if (isDrawing) {
          shapesPx = (a.shapes || []).map((s) => fracShapeToPx(s, rect.left, rect.top, W, H));
          bboxPx = bboxOfPxShapes(shapesPx);
        } else {
          // メモは図形を持たない。対象要素の矩形を bbox として、その隣にメモ吹き出し＋番号バッジを描く。
          bboxPx = { minX: rect.left, minY: rect.top, maxX: rect.left + W, maxY: rect.top + H };
        }
        // ビューポートと bbox が少しでも重なれば描画対象。
        inViewport = bboxPx.maxX > 0 && bboxPx.minX < vw && bboxPx.maxY > 0 && bboxPx.minY < vh;
      }
      const firstColor = (a.shapes && a.shapes[0] && a.shapes[0].color) || '#ef4444';
      const anchor = a.anchor || {};
      const targetCandidates = target ? buildTargetCandidates(target) : Array.isArray(anchor.targetCandidates) ? anchor.targetCandidates : [];
      const best = bestTargetCandidate(targetCandidates) || {};
      const bestLabel = targetCandidates.find((c) => c.label)?.label || '';
      const href = (target ? normalizedLinkHref(target) : anchor.href) || best.href || '';
      const dataAsin = (target ? nearestDataAsin(target) : anchor.dataAsin) || asinFromHref(href) || best.dataAsin || '';
      const anchorLabel = target ? truncate(labelOf(target) || bestLabel, 60) : truncate(anchor.text || bestLabel || anchor.tag || '', 60);
      items.push({
        id: a.id,
        color: firstColor,
        note: a.note || '',
        intent: a.intent || '',
        // メモは図形を持たないので shapeText は空（describeShapes([]) の「お描きで印を付けた」を本文に混ぜない）。
        shapeText: isDrawing ? describeShapes(a.shapes) : '',
        anchorLabel,
        selector: anchor.selector || '',
        dataAgentId: target?.getAttribute?.('data-agent-id') || anchor.dataAgentId || '',
        testid: anchor.testid || '',
        dataAsin,
        href,
        tag: target?.tagName?.toLowerCase?.() || anchor.tag || '',
        role: target ? roleOf(target) : anchor.role || '',
        html: target ? captureOuterHtml(target) : null,
        a11y: target ? captureA11y(target) : null,
        targetCandidates,
        resolved,
        inViewport,
        shapesPx,
        bboxPx,
        shapesFrac: a.shapes || [],
      });
    }
    return {
      url: location.href,
      title: document.title,
      dpr: window.devicePixelRatio || 1,
      viewport: { width: vw, height: vh },
      items,
    };
  }

  // お描きのコメント(目的)入力フォーム。新規・編集の両方で使う。
  function openDrawingAuthoring(draft) {
    closeAuthoring();
    const anchor = draft.anchor || {};
    const heading = anchor.text || anchor.ariaLabel || anchor.placeholder || anchor.tag || t('cs.author.targetFallback');
    const wrap = document.createElement('div');
    wrap.className = 'bag-author';
    wrap.setAttribute(ATTR.ui, '1');
    wrap.innerHTML = `
      <div class="bag-author-head">${escapeHtml(t('cs.author.drawAddComment'))}</div>
      <div class="bag-author-target">${escapeHtml(t('cs.author.target'))} <b>${escapeHtml(truncate(heading, 40))}</b> <span class="muted">&lt;${escapeHtml(anchor.role || anchor.tag || '')}&gt;</span></div>
      <div class="bag-author-target">${escapeHtml(t('cs.author.drawing'))} ${escapeHtml(describeShapes(draft.shapes))}</div>
      <label class="bag-author-row">
        <span>${escapeHtml(t('cs.author.aiContent'))}</span>
        <textarea data-f="note" rows="3" placeholder="${escapeHtml(t('cs.author.aiContentPlaceholder'))}"></textarea>
      </label>
      <div class="bag-author-actions">
        <button data-f="cancel" type="button">${escapeHtml(t('cs.author.cancel'))}</button>
        <button data-f="save" type="button" class="primary">${escapeHtml(t('cs.author.placeMemo'))}</button>
      </div>`;
    document.documentElement.appendChild(wrap);
    const target = anchor ? resolveAnchor(anchor) : null;
    positionAuthoring(wrap, target);
    setupAuthoringDrag(wrap);
    authoringEl = wrap;
    if (draft.note) wrap.querySelector('[data-f="note"]').value = draft.note;
    wrap.querySelector('[data-f="cancel"]').addEventListener('click', closeAuthoring);
    wrap.querySelector('[data-f="save"]').addEventListener('click', async () => {
      const note = wrap.querySelector('[data-f="note"]').value.trim();
      const saved = await upsertAnnotation({
        id: draft.id,
        kind: 'drawing',
        anchor,
        shapes: draft.shapes,
        note,
        intent: draft.intent || '', // 旧データのintentは保持(フォームでは編集しない)
        forAI: draft.forAI !== false, // 既存のforAIを保持(未設定はON)
      });
      closeAuthoring();
      focusMemo(saved?.id || draft.id);
      toast(t('cs.toast.memoSaved'), 'success');
    });
  }

  // ---- 外部AI(別のChatUI)へ貼る決定的なページ文脈テキスト ----
  function buildContextText() {
    annotatePage();
    renderAnnotations();
    const targets = collectReferenceTargets();
    const affs = collectAffordances();
    const lines = [];
    lines.push('# このページの文脈（Browser Agent Guide が生成）');
    lines.push(`URL: ${location.href}`);
    lines.push(`タイトル: ${document.title}`);
    lines.push('');
    if (annotations.length) {
      lines.push('## 人が付けた補足・目印（最優先で従ってください）');
      for (const a of annotations) {
        // お描きメモは「AIに渡す」がOFFのものを文脈から除外する(forAI=falseは送らない)。
        if (a.kind === 'drawing' && !memoForAI(a)) continue;
        const t = a.anchor ? resolveAnchor(a.anchor) : null;
        const where = t
          ? `「${truncate((t.innerText || t.getAttribute('aria-label') || a.anchor.text || '').trim(), 40)}」`
          : '(対象未検出)';
        if (a.kind === 'note')
          lines.push(`- 手順${annoNoteNumber(a)}（人の補足｜番号順に実施）: ${a.note}${a.intent ? `（目的: ${a.intent}）` : ''} -> 対象 ${where}`);
        else if (a.kind === 'marker')
          lines.push(`- 目印「${a.name}」: ${a.intent || '(目的未設定)'} -> 対象 ${where}`);
        else if (a.kind === 'button')
          lines.push(`- 合図ボタン「${a.label}」: 目的 ${a.intent || '(未設定)'}`);
        else if (a.kind === 'drawing')
          lines.push(
            `- お描きメモ: ${describeShapes(a.shapes)}${a.note ? `（指示: ${a.note}）` : ''}${a.intent ? `（目的: ${a.intent}）` : ''} -> 対象 ${where}`
          );
      }
      lines.push('');
    }
    lines.push('## 操作できる要素（指示ではこの[ID]で要素を指してください）');
    for (const f of affs.slice(0, 60)) {
      lines.push(
        `- [${f.aiId}] <${f.role}> "${truncate(f.label, 50)}"${f.value ? ` 値="${truncate(f.value, 24)}"` : ''}`
      );
    }
    if (targets.length) {
      lines.push('');
      lines.push('## 参照できる見出し・区画（強調やスクロールではこの[ID]で指してください）');
      for (const t of targets.slice(0, 80)) {
        const level = t.level ? ` level=${t.level}` : '';
        lines.push(`- [${t.aiId}] <${t.role}${level}> "${truncate(t.label, 70)}"`);
      }
    }
    if (signalLog.length) {
      lines.push('');
      lines.push('## ユーザーが押した合図ボタンの履歴');
      for (const s of signalLog) lines.push(`- ${s.intent}（${s.aiId}）`);
    }
    return lines.join('\n');
  }

  function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ---- 実行器 ----
  function isActionAllowed(verbName, source) {
    if (source === 'chat' && CHAT_BLOCKED_VERBS.has(verbName)) return false;
    if (source === 'recipe' && RECIPE_BLOCKED_VERBS.has(verbName)) return false;
    // autorun は deny-by-default: 許可された安全動詞だけ通す。
    if (source === 'autorun') return AUTORUN_ALLOWED_VERBS.has(verbName);
    return true;
  }

  // レシピ/アクションの実行条件(when)を評価する。満たさなければそのアクションはスキップ。
  //   when.urlContains    : 現在URL(location.href)に指定文字列を含むときだけ実行(SPAの画面別出し分け)
  //   when.selectorExists : 指定セレクタの要素が存在するときだけ実行
  //   when.selectorAbsent : 指定セレクタの要素が存在しないときだけ実行(重複注入の防止など)
  function evalWhen(when) {
    if (!when || typeof when !== 'object') return true;
    if (when.urlContains && !location.href.includes(when.urlContains)) return false;
    if (when.selectorExists) {
      try {
        if (!document.querySelector(when.selectorExists)) return false;
      } catch {
        return false; // 無効セレクタは「存在しない」とみなす
      }
    }
    if (when.selectorAbsent) {
      try {
        if (document.querySelector(when.selectorAbsent)) return false;
      } catch {
        /* 無効セレクタは「存在しない」とみなして実行を許す */
      }
    }
    return true;
  }

  async function runActions(actions, source = 'manual', options = {}) {
    const results = [];
    for (const a of actions || []) {
      const verb = AI_VERBS[a.verb];
      if (!verb) {
        results.push({ verb: a.verb, ok: false, error: t('cs.err.unknownVerb') });
        continue;
      }
      if (!isActionAllowed(a.verb, source)) {
        results.push({
          verb: a.verb,
          ok: false,
          reason: a.reason || '',
          error: t('cs.err.verbBlocked'),
        });
        continue;
      }
      // 実行条件(when): 満たさなければスキップ(失敗ではない)。SPAの画面別出し分けに使う。
      if (a.when && !evalWhen(a.when)) {
        results.push({ verb: a.verb, ok: true, skipped: true, reason: a.reason || '', result: null });
        continue;
      }
      // 出現待ち(waitFor): 非同期で後から現れる要素を待ってから実行する(遅延ロード/SPA対応)。
      if (a.waitFor && a.waitFor.selector) {
        const found = await waitFor(a.waitFor.selector, Number(a.waitFor.timeoutMs) || 5000);
        if (!found) {
          results.push({
            verb: a.verb,
            ok: false,
            reason: a.reason || '',
            error: t('cs.err.waitForTimeout', { selector: a.waitFor.selector }),
          });
          continue;
        }
      }
      // 自動実行の不可逆ガード: 対象ラベルが「注文を確定/購入/削除」等、または名前が一切取れない
      // (アイコンのみ等)クリックは自動では押さず保留する(fail-safe)。ユーザーが手動で押す前提。
      // 要素が解決できない場合は requireEl が例外→クリックされないので安全(保留扱いは不要)。
      if (source === 'autorun' && !options.allowIrreversibleClicks && AUTORUN_GUARD_VERBS.has(a.verb)) {
        let guardEl = null;
        try {
          guardEl = getEl(a.args || {});
        } catch {
          guardEl = null;
        }
        if (guardEl) {
          const guardLabel = guardLabelOf(guardEl);
          if (isIrreversibleLabel(guardLabel) || !guardLabel.trim()) {
            results.push({
              verb: a.verb,
              ok: false,
              held: true,
              reason: a.reason || '',
              label: truncate(guardLabel || '(名前不明 / unnamed)', 60),
              error: t('cs.err.autorunHeld'),
            });
            continue;
          }
        }
      }
      try {
        const value = await verb.run(a.args || {});
        results.push({ verb: a.verb, ok: true, reason: a.reason || '', result: value ?? null });
      } catch (e) {
        results.push({ verb: a.verb, ok: false, reason: a.reason || '', error: String(e?.message || e) });
      }
    }
    return results;
  }

  function getCatalog() {
    return Object.entries(AI_VERBS)
      .filter(([, v]) => v.exposeToAI !== false)
      .map(([name, v]) => ({
        name,
        description: v.description,
        args: v.args || {},
      }));
  }

  // ---- メッセージ受信 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type !== 'PING') await loadI18n();
      switch (msg?.type) {
        case 'PING':
          return { ok: true };
        case 'COLLECT_CONTEXT':
          annotatePage();
          renderAnnotations(); // 目印を最新解決して反映してから収集
          const targets = collectReferenceTargets();
          return {
            url: location.href,
            title: document.title,
            affordances: collectAffordances(),
            targets,
            verbs: getCatalog(),
            signals: signalLog.slice(),
            annotations: annotations.map(annoSummary),
            workflow: buildWorkflowContext(),
          };
        case 'RUN_ACTIONS':
          return { results: await runActions(msg.actions, msg.source || 'manual', msg.options || {}) };
        case 'START_PICKER':
          await loadAnnotations();
          return startPicker();
        case 'STOP_PICKER':
          return stopPicker();
        case 'START_DRAWING':
          await loadAnnotations();
          return startDrawing();
        case 'STOP_DRAWING':
          return stopDrawing();
        case 'LIST_ANNOTATIONS':
          // サイドパネルの一覧更新は storage 変化のたびに飛んでくる。メモ本文を編集すると
          // その保存自体がこの再読込→再描画を誘発し、入力中のテキストエリアが作り直されて
          // フォーカス/IME変換が飛ぶ。編集中は再読込・再描画を行わず、現在の一覧だけ返す
          // (編集終了時に flushPendingMemoRender で最新状態へ反映する)。
          if (isMemoEditing()) {
            pendingMemoRender = true;
          } else {
            await loadAnnotations();
            renderAnnotations();
          }
          return { annotations: annotations.map(annoSummary), scope: scopeKey() };
        case 'EDIT_ANNOTATION': {
          const a = annotations.find((x) => x.id === msg.id);
          if (!a) return { error: t('cs.err.annotationNotFound') };
          if (a.kind === 'drawing') {
            // お描きはページ上のメモで編集する。メモが表示中ならそこへスクロール＋フォーカス。
            const onPage = drawPinHost?.querySelector(`.bag-memo[${ATTR.anno}="${cssEscape(msg.id)}"]`);
            if (onPage) {
              const target = a.anchor ? resolveAnchor(a.anchor) : null;
              target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
              focusMemo(msg.id);
            } else {
              // 対象未解決などでメモが無い場合は従来のフォームで編集する。
              openDrawingAuthoring(a);
            }
            return { editing: msg.id };
          }
          const target = a.anchor ? resolveAnchor(a.anchor) : null;
          openAuthoring(target, a);
          return { editing: msg.id };
        }
        case 'REMOVE_ANNOTATION':
          return await deleteAnnotation(msg.id);
        case 'EXPORT_CONTEXT':
          return { text: buildContextText() };
        case 'PREPARE_CAPTURE': {
          // capture 直前: 注釈を最新解決し、自前UIを一時的に隠す（二重描画回避）。
          // 図形は自前 px 計算で burn-in するので、隠しても座標計算には影響しない。
          await loadAnnotations();
          renderAnnotations();
          document.documentElement.classList.add('bag-capturing');
          await nextFrames(2); // 非表示が確実に描画されてから capture させる
          return collectVisualFeedbackData();
        }
        case 'FINISH_CAPTURE':
          document.documentElement.classList.remove('bag-capturing');
          return { ok: true };
        case 'ACTIVATE': {
          annotatePage();
          collectReferenceTargets();
          await loadAnnotations();
          renderAnnotations();
          let appliedRecipes = false;
          if (Array.isArray(msg.recipes) && msg.recipes.length) {
            // タブ切替等でのACTIVATE再送による二重適用を防ぐ。
            const sig = JSON.stringify(msg.recipes);
            if (sig !== appliedRecipeSig) {
              appliedRecipeSig = sig;
              await runActions(msg.recipes, 'recipe');
              appliedRecipes = true;
            }
          }
          return { activated: true, appliedRecipes };
        }
        default:
          return { error: `未知のメッセージ: ${msg?.type}` };
      }
    })().then(sendResponse);
    return true; // 非同期応答
  });

  // 言語設定の変更を検知して辞書を更新し、ページ上の注釈(AIメモ等)を再描画する。
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.aiAdvisorSettings) {
        i18nLoaded = false;
        loadI18n({ force: true }).then(() => renderAnnotations());
      }
    });
  } catch {
    /* storage 監視不可環境は無視 */
  }

  // ---- 初期化: ロケール辞書を読み込み、保存済みの注釈を復元する ----
  (async () => {
    await loadI18n();
    await loadAnnotations();
    renderAnnotations();
  })();
})();
