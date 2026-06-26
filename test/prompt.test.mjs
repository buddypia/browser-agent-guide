// lib/prompt.js の buildSystemPrompt 単体テスト（bare node script: `node test/prompt.test.mjs`）。
// 目的: 補足(note)が「手順N」として“拡張内チャットAIの主経路”であるシステムプロンプトに
//       番号付きで出ること（buildContextText の export 経路だけでなく、ここにも届く）。
//       併せて、お描き(drawing)のワークフロー手順節が従来どおり出る回帰防止。

import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../lib/prompt.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`ok - ${name}`);
};

// (1) 補足は「💬 手順N（人の補足｜番号順に実施）: 本文」で番号付きに出る。
{
  const p = buildSystemPrompt({
    context: {
      annotations: [
        { kind: 'note', note: '送信前に確認', step: 1, target: '送信ボタン' },
        { kind: 'note', note: '氏名を入力', step: 2, target: '氏名欄' },
      ],
    },
  });
  assert.match(p, /💬 手順1（人の補足｜番号順に実施）: 送信前に確認/, '手順1 が出る');
  assert.match(p, /💬 手順2（人の補足｜番号順に実施）: 氏名を入力/, '手順2 が出る');
  assert.doesNotMatch(p, /💬 補足: /, '番号なしの旧表記は出ない');
  ok('補足はシステムプロンプトに手順番号付きで出る');
}

// (2) step 欠落の後方互換（古い summary でも落ちない）。
{
  const p = buildSystemPrompt({ context: { annotations: [{ kind: 'note', note: 'X' }] } });
  assert.match(p, /💬 手順\?（人の補足｜番号順に実施）: X/, 'step 欠落時は ? でフォールバック');
  ok('step 欠落でも例外なくフォールバック表記で出る');
}

// (3) お描き(drawing)は従来どおりワークフロー手順ブロックに出る（回帰防止）。
{
  const p = buildSystemPrompt({
    context: {
      annotations: [{ kind: 'drawing', note: 'ここを押す', shapeText: '丸', forAI: true, step: 1 }],
      workflow: { count: 1, steps: [{ step: 1, target: 'ボタン', shape: '丸', note: 'ここを押す', forAI: true }] },
    },
  });
  assert.match(p, /お描きワークフロー/, 'お描きワークフロー節が出る');
  ok('お描きは従来どおりワークフロー手順に出る');
}

// (4) 記録ワークフロー(ページ跨ぎ)は URL 付きで番号順に出て、現在ページに ★ が付く。
{
  const p = buildSystemPrompt({
    context: {
      url: 'https://shop.example/cart',
      crossPageWorkflow: {
        count: 2,
        steps: [
          { order: 1, url: 'https://shop.example/item', text: 'カートに入れる', target: '購入ボタン', kind: 'note' },
          { order: 2, url: 'https://shop.example/cart', text: '数量を2に', target: '数量欄', kind: 'note' },
        ],
      },
    },
  });
  assert.match(p, /記録ワークフロー\(URL順の操作手順\)/, '記録ワークフロー節が出る');
  assert.match(p, /1\. \[https:\/\/shop\.example\/item\]/, '手順1 が URL 付きで出る');
  assert.match(p, /2\. \[https:\/\/shop\.example\/cart\] ★現在のページ/, '現在ページの手順に ★ が付く');
  assert.match(p, /navigateTo/, '別URLへ進む手段として navigateTo を案内する');
  ok('記録ワークフローは URL 付き・番号順で出る');
}

// (5) 記録ワークフローが無ければ節は出ない(回帰防止)。
{
  const p = buildSystemPrompt({ context: { url: 'https://x/y' } });
  assert.doesNotMatch(p, /記録ワークフロー/, '空なら記録ワークフロー節は出ない');
  ok('記録ワークフローが無ければ節は出ない');
}

// (6) 自動実行モードでは navigateTo 案内を出さない(allow-list で除外済みのため矛盾指示を避ける)。
//     遷移は SW が決定論的に行うので「★現在のページの手順だけ実行」を指示する。
{
  const ctx = {
    url: 'https://shop.example/cart',
    crossPageWorkflow: {
      count: 2,
      steps: [
        { order: 1, url: 'https://shop.example/item', text: 'カートに入れる', target: '購入ボタン', kind: 'note' },
        { order: 2, url: 'https://shop.example/cart', text: '数量を2に', target: '数量欄', kind: 'note' },
      ],
    },
  };
  const auto = buildSystemPrompt({ context: ctx, autorun: true });
  assert.match(auto, /記録ワークフロー\(URL順の操作手順\)/, '自動実行でも記録ワークフロー節は出る');
  assert.doesNotMatch(auto, /navigateTo/, '自動実行モードでは navigateTo を案内しない');
  assert.match(auto, /自動実行モード/, '自動実行モードの注記が出る');
  assert.match(auto, /最終確定ボタンは押さない/, '既定では最終確定ボタンを押さない');
  const autoAllowed = buildSystemPrompt({ context: ctx, autorun: true, allowIrreversibleAutorun: true });
  assert.match(autoAllowed, /設定で許可済み/, '設定ON時は最終確定クリック許可を明示する');
  assert.doesNotMatch(autoAllowed, /最終確定ボタンは押さない/, '設定ON時は押さない指示を出さない');
  // 既定(チャット経路)は従来どおり navigateTo を案内する(回帰防止)。
  const chat = buildSystemPrompt({ context: ctx });
  assert.match(chat, /navigateTo/, 'チャット経路では navigateTo を案内する');
  ok('自動実行モードは navigateTo 案内を抑制する');
}

// (7) X/Twitter では下書き verb を使い、投稿ボタンを押さない方針を明示する。
{
  const p = buildSystemPrompt({
    context: {
      url: 'https://x.com/home',
      verbs: [{ name: 'draftXPost', description: 'X下書き', args: { text: '本文' } }],
    },
  });
  assert.match(p, /draftXPost/, 'X下書き専用 verb を案内する');
  assert.match(p, /Post\/Tweet\/ポスト\/投稿ボタンはクリックしない/, '投稿ボタンを押さない方針を明示する');
  ok('X/Twitter 下書きでは投稿ボタンを押さない');
}

console.log(`\n${passed} passed`);
