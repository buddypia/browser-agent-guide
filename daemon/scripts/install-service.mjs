#!/usr/bin/env node
// install-service.mjs — デーモンを常駐化(daemonization)するための launchd/systemd ユニットを
// 生成して表示、または --write でユーザー領域に書き出す CLI。
//
// 既定は「表示のみ」(副作用なし)。--write でユニットファイルだけ書き、load は実行しない
// (システム状態を勝手に変えない — ユーザーが load コマンドを自分で実行)。
//
// 使い方:
//   node scripts/install-service.mjs                          # 現在の platform 向けユニットを表示
//   node scripts/install-service.mjs --port 8765 --inbox /p   # その引数でデーモンを起動するユニット
//   node scripts/install-service.mjs --write                  # ユーザー領域に書き出し + load 手順を表示
//   node scripts/install-service.mjs --token <t>              # トークンを env で渡す(任意)
//
// デーモン本体の引数(--inbox/--port/--host/--storage)はそのままユニットの起動引数になる。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { servicePlan } from '../src/service-template.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = resolve(SCRIPT_DIR, '..', 'src', 'index.js');

// デーモン本体が解釈するフラグだけを通す(install 用フラグと混ざらないように)。
const DAEMON_FLAGS = new Set(['--inbox', '--port', '--host', '--storage']);

function parse(argv) {
  const out = { write: false, daemonArgs: [], env: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--token') out.env.BAG_VF_TOKEN = argv[(i += 1)];
    else if (DAEMON_FLAGS.has(a)) {
      out.daemonArgs.push(a, argv[(i += 1)]);
    } else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'install-service.mjs — デーモン常駐化ユニット生成',
      '',
      '  node scripts/install-service.mjs [--write] [--port N] [--inbox DIR] [--host H] [--storage MODE] [--token T]',
      '',
      '  (既定)  現在の platform 向けユニットを表示(副作用なし)',
      '  --write ユーザー領域にユニットを書き出し + load 手順を表示(load は実行しない)',
      '',
    ].join('\n')
  );
}

function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  let plan;
  try {
    plan = servicePlan({
      platform: process.platform,
      home: homedir(),
      nodePath: process.execPath,
      scriptPath: DAEMON_ENTRY,
      args: opts.daemonArgs,
      env: opts.env,
    });
  } catch (e) {
    process.stderr.write(`[bag-vf] ${e.message}\n`);
    process.stderr.write('[bag-vf] 手動常駐化: nohup/pm2/tmux 等で `node src/index.js` を起動してください。\n');
    return 1;
  }

  if (!opts.write) {
    process.stdout.write(plan.content);
    process.stderr.write(`\n[bag-vf] 上記を ${plan.unitPath} に保存し、次で常駐化:\n`);
    process.stderr.write(`[bag-vf]   ${plan.loadCmd}\n`);
    process.stderr.write(`[bag-vf] そのまま書き出すには --write を付けて再実行。\n`);
    return 0;
  }

  try {
    mkdirSync(dirname(plan.unitPath), { recursive: true });
    writeFileSync(plan.unitPath, plan.content, { mode: 0o644 });
  } catch (e) {
    process.stderr.write(`[bag-vf] 書き出し失敗: ${e.message}\n`);
    return 1;
  }
  process.stderr.write(`[bag-vf] ユニットを書き出しました: ${plan.unitPath}\n`);
  process.stderr.write(`[bag-vf] 常駐化(load)は手動で実行してください:\n`);
  process.stderr.write(`[bag-vf]   ${plan.loadCmd}\n`);
  process.stderr.write(`[bag-vf] 状態確認: ${plan.statusCmd}\n`);
  process.stderr.write(`[bag-vf] 停止/解除: ${plan.unloadCmd}\n`);
  return 0;
}

process.exit(main());
