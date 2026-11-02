#!/usr/bin/env node
/**
 * One-shot / first-run helper for hookless hosts.
 *
 * It checks `rsrs inject --targets` and only runs `rsrs inject --id <target>`
 * when the target is absent or stale. Running it repeatedly is safe: a current
 * target is skipped.
 *
 * Usage:
 *   node scripts/setup-inject.mjs --target auto
 *   node scripts/setup-inject.mjs --target generic --check
 *   node scripts/setup-inject.mjs --target claude --force
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTarget, injectOnce, readPluginConfig } from '../lib/inject.mjs';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}
const json = process.argv.includes('--json');
const checkOnly = process.argv.includes('--check');
const force = process.argv.includes('--force');
const cfg = readPluginConfig();
const target = detectTarget(
  process.env,
  arg('--target', cfg.inject_target || process.env.RESPITE_INJECT_TARGET || 'auto'),
);
const dataDir =
  process.env.RESPITE_DATA ||
  process.env.PLUGIN_DATA ||
  path.join(process.env.PLUGIN_ROOT || process.cwd(), '.plugin-data');

function fail(message) {
  if (json) console.log(JSON.stringify({ status: 'error', reason: message }, null, 2));
  else console.error(`respire inject: ${message}`);
  process.exit(1);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isExecutable(p) {
  if (!isFile(p)) return false;
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function pathCandidates(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  const found = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) found.push(candidate);
    }
  }
  return found;
}
function resolveNodeCliFromShim(shim) {
  try {
    const text = fs.readFileSync(shim, 'utf8').slice(0, 64 * 1024);
    const dir = path.dirname(shim);
    const pattern = /([^\s"'<>|]*cli\.js)/gi;
    let match;
    while ((match = pattern.exec(text))) {
      let file = match[1]
        .replace(/%~dp0\\?/gi, `${dir}${path.sep}`)
        .replace(/%dp0%/gi, `${dir}${path.sep}`);
      if (!path.isAbsolute(file)) file = path.resolve(dir, file);
      if (isFile(file)) return file;
    }
  } catch {
    /* ignore */
  }
  return null;
}
function resolveSpawn(engine) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(engine)) {
    const cli = resolveNodeCliFromShim(engine);
    if (!cli) return null;
    return { command: process.execPath, prefix: [cli] };
  }
  return { command: engine, prefix: [] };
}
function findEngine() {
  const home = os.homedir();
  const candidates = [
    process.env.RESPITE_BIN,
    process.env.RESPITE_RSRS,
    typeof cfg.rsrs === 'string' ? cfg.rsrs : '',
    ...pathCandidates('rsrs'),
    ...pathCandidates('respire'),
    path.join(home, '.local', 'bin', 'rsrs'),
    path.join(home, '.rsrs', 'bin', 'rsrs'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'rsrs.cmd') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm', 'rsrs.cmd') : '',
    '/usr/local/bin/rsrs',
    '/opt/homebrew/bin/rsrs',
    '/usr/bin/rsrs',
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  return null;
}

const engine = findEngine();
if (!engine) {
  fail(
    'rsrs engine not found. Install it with `npm i -g @rsrsai/cli@latest`, ' +
      'or set RESPITE_BIN to the executable.',
  );
}
const spec = resolveSpawn(engine);
if (!spec) fail(`unsupported Windows shim for ${engine}; set RESPITE_BIN to cli.js`);

const result = await injectOnce({
  spec,
  target,
  dataDir,
  force,
  checkOnly,
  log: (message) => {
    if (!json) console.error(message);
  },
});
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.status === 'skip') {
  console.log(`respire inject: skipped (${result.reason || 'already current'})`);
} else if (result.status === 'needed') {
  console.log(`respire inject: needed (target=${result.target}, state=${result.state})`);
} else if (result.status === 'injected') {
  console.log(`respire inject: done (target=${result.target}, state=${result.state})`);
} else {
  console.error(`respire inject: failed (${result.reason || result.status})`);
  process.exitCode = 1;
}
