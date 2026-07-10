// service-template.mjs — 常駐化(daemonization)用のサービスユニットを生成する純粋モジュール。
//
// デーモンをログイン/再起動を跨いで常駐させるための launchd(macOS) / systemd(Linux) の
// ユニット定義を文字列で組み立てる。副作用なし(ファイル I/O は install-service.mjs 側)。
//
// 設計:
//   - すべて純粋関数。入力(node/script のパス, args, env, ログ先)から定義テキストを返すだけ。
//   - escape を厳密に: launchd は XML(<>&), systemd は値の改行除去。
//   - 既定ラベル/サービス名は LABEL でSSOT化。

export const LABEL = 'com.buddypia.bag-pf-daemon';
export const SYSTEMD_UNIT_NAME = 'bag-pf-daemon.service';

/** XML テキストノード用 escape(launchd plist)。 */
export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** systemd の値は1行に畳む(改行はユニット破壊につながるため除去)。 */
function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 共通設定を正規化する。platform 依存の既定パスを与える。
 * @param {{ platform?: string, nodePath: string, scriptPath: string, args?: string[], env?: Record<string,string>, home?: string }} opts
 */
export function normalizeServiceConfig(opts = {}) {
  const platform = opts.platform || process.platform;
  const args = Array.isArray(opts.args) ? opts.args.map((a) => String(a)) : [];
  const env = {};
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (typeof k === 'string' && k && v != null) env[k] = String(v);
  }
  return {
    platform,
    label: LABEL,
    nodePath: String(opts.nodePath || ''),
    scriptPath: String(opts.scriptPath || ''),
    args,
    env,
  };
}

/**
 * macOS launchd の LaunchAgent plist を生成する。RunAtLoad + KeepAlive で常駐。
 * @param {{ nodePath: string, scriptPath: string, args?: string[], env?: Record<string,string>, logDir: string, label?: string }} cfg
 */
export function launchdPlist(cfg = {}) {
  const label = cfg.label || LABEL;
  const programArgs = [cfg.nodePath, cfg.scriptPath, ...(cfg.args || [])].filter((s) => s != null && s !== '');
  const argXml = programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const envEntries = Object.entries(cfg.env || {});
  const envXml = envEntries.length
    ? [
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        ...envEntries.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`),
        '  </dict>',
      ].join('\n')
    : '';
  const outLog = `${cfg.logDir}/bag-pf-daemon.out.log`;
  const errLog = `${cfg.logDir}/bag-pf-daemon.err.log`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argXml,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    ...(envXml ? [envXml] : []),
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(outLog)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(errLog)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * Linux systemd の user unit を生成する。Restart=on-failure で常駐。
 * @param {{ nodePath: string, scriptPath: string, args?: string[], env?: Record<string,string>, description?: string }} cfg
 */
export function systemdUnit(cfg = {}) {
  const description = oneLine(cfg.description || 'Browser Agent Guide page-feedback daemon');
  const exec = [cfg.nodePath, cfg.scriptPath, ...(cfg.args || [])]
    .filter((s) => s != null && s !== '')
    .map((s) => oneLine(s))
    .join(' ');
  const envLines = Object.entries(cfg.env || {}).map(([k, v]) => `Environment=${oneLine(k)}=${oneLine(v)}`);
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec}`,
    'Restart=on-failure',
    'RestartSec=5',
    ...envLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * platform 別に「どこへ何を書き、どう load/unload するか」を1つにまとめた純粋プラン。
 * install-service.mjs はこれを使って print / write する（副作用はそちら側）。
 *
 * @param {{ platform: string, home: string, nodePath: string, scriptPath: string, args?: string[], env?: Record<string,string> }} opts
 * @returns {{ platform, unitPath, content, logDir, loadCmd, unloadCmd, statusCmd }}
 * @throws {Error} 未対応 platform
 */
export function servicePlan(opts = {}) {
  const cfg = normalizeServiceConfig(opts);
  const home = String(opts.home || '');
  if (!home) throw new Error('servicePlan: home is required');

  if (cfg.platform === 'darwin') {
    const logDir = `${home}/Library/Logs`;
    const unitPath = `${home}/Library/LaunchAgents/${cfg.label}.plist`;
    return {
      platform: 'darwin',
      unitPath,
      content: launchdPlist({ ...cfg, logDir }),
      logDir,
      loadCmd: `launchctl load -w "${unitPath}"`,
      unloadCmd: `launchctl unload -w "${unitPath}"`,
      statusCmd: `launchctl list | grep ${cfg.label}`,
    };
  }

  if (cfg.platform === 'linux') {
    const unitPath = `${home}/.config/systemd/user/${SYSTEMD_UNIT_NAME}`;
    return {
      platform: 'linux',
      unitPath,
      content: systemdUnit(cfg),
      logDir: '(journald)',
      loadCmd: `systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
      unloadCmd: `systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`,
      statusCmd: `systemctl --user status ${SYSTEMD_UNIT_NAME}`,
    };
  }

  throw new Error(`unsupported platform: ${cfg.platform} (launchd=darwin / systemd=linux のみ)`);
}
