// 常駐化ユニット生成(service-template.mjs)の単体テスト。純粋関数なので I/O 無しで検証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LABEL,
  SYSTEMD_UNIT_NAME,
  xmlEscape,
  launchdPlist,
  systemdUnit,
  servicePlan,
} from '../src/service-template.mjs';

test('xmlEscape は & < > を実体参照に変換する', () => {
  assert.equal(xmlEscape('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('launchdPlist: node+script+args を ProgramArguments に並べ、常駐キーを含む', () => {
  const plist = launchdPlist({
    nodePath: '/usr/bin/node',
    scriptPath: '/app/daemon/src/index.js',
    args: ['--port', '8765'],
    env: { BAG_PF_TOKEN: 'tok&en' },
    logDir: '/home/u/Library/Logs',
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.buddypia\.bag-pf-daemon<\/string>/);
  assert.match(plist, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/app\/daemon\/src\/index\.js<\/string>/);
  assert.match(plist, /<string>--port<\/string>/);
  assert.match(plist, /<string>8765<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  // env はエスケープされて入る
  assert.match(plist, /<key>BAG_PF_TOKEN<\/key>\s*<string>tok&amp;en<\/string>/);
  assert.match(plist, /bag-pf-daemon\.out\.log/);
  assert.match(plist, /bag-pf-daemon\.err\.log/);
});

test('launchdPlist: env 無しなら EnvironmentVariables ブロックを出さない', () => {
  const plist = launchdPlist({ nodePath: 'node', scriptPath: 'i.js', logDir: '/l' });
  assert.equal(plist.includes('EnvironmentVariables'), false);
});

test('systemdUnit: ExecStart に node+script+args、Restart と Install を含む', () => {
  const unit = systemdUnit({
    nodePath: '/usr/bin/node',
    scriptPath: '/app/src/index.js',
    args: ['--port', '8765', '--storage', 'hybrid'],
    env: { BAG_PF_TOKEN: 'tok' },
  });
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/app\/src\/index\.js --port 8765 --storage hybrid$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^Environment=BAG_PF_TOKEN=tok$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('systemdUnit: env 改行はユニットを壊さないよう畳まれる', () => {
  const unit = systemdUnit({ nodePath: 'node', scriptPath: 'i.js', env: { K: 'a\nb' } });
  assert.match(unit, /^Environment=K=a b$/m);
});

test('servicePlan darwin: LaunchAgents の plist と launchctl コマンド', () => {
  const plan = servicePlan({
    platform: 'darwin',
    home: '/Users/me',
    nodePath: '/usr/bin/node',
    scriptPath: '/app/src/index.js',
    args: ['--port', '8765'],
  });
  assert.equal(plan.platform, 'darwin');
  assert.equal(plan.unitPath, `/Users/me/Library/LaunchAgents/${LABEL}.plist`);
  assert.match(plan.content, /<plist version="1\.0">/);
  assert.match(plan.loadCmd, /^launchctl load -w /);
  assert.match(plan.unloadCmd, /^launchctl unload -w /);
  // ログ先が home 配下
  assert.match(plan.content, /\/Users\/me\/Library\/Logs\/bag-pf-daemon\.out\.log/);
});

test('servicePlan linux: systemd user unit と systemctl コマンド', () => {
  const plan = servicePlan({
    platform: 'linux',
    home: '/home/me',
    nodePath: '/usr/bin/node',
    scriptPath: '/app/src/index.js',
  });
  assert.equal(plan.platform, 'linux');
  assert.equal(plan.unitPath, `/home/me/.config/systemd/user/${SYSTEMD_UNIT_NAME}`);
  assert.match(plan.content, /^\[Service\]$/m);
  assert.match(plan.loadCmd, /systemctl --user enable --now bag-pf-daemon\.service/);
});

test('servicePlan: 未対応 platform は throw', () => {
  assert.throws(() => servicePlan({ platform: 'win32', home: 'C:/Users/me', nodePath: 'node', scriptPath: 'i.js' }), /unsupported platform/);
});

test('servicePlan: home 必須', () => {
  assert.throws(() => servicePlan({ platform: 'darwin', home: '', nodePath: 'node', scriptPath: 'i.js' }), /home is required/);
});
