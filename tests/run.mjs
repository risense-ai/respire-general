#!/usr/bin/env node
/**
 * respire-general test suite (zero dependencies, no real memory writes).
 *
 *   node tests/run.mjs           build generated plugin + run all checks
 *   node tests/run.mjs --check   verify the generated plugin is up to date, then test
 *
 * A fake `rsrs` shim is created in a temp directory, so the hook branches
 * (status / recall / remember / failures) are deterministic and isolated.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = path.resolve(ROOT, '..', 'respire-minimax-code');
const HOOK = path.join(GENERATED, 'io.minimax.mcode', 'hooks', 'scripts', 'respire-hook.mjs');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate.mjs');
const BUILDER = path.join(ROOT, 'scripts', 'build-minimax.mjs');
const CHECK_ONLY = process.argv.includes('--check');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'respire-general-test-'));
const EMPTY_DIR = path.join(TMP, 'empty');
fs.mkdirSync(EMPTY_DIR, { recursive: true });

let passed = 0;
let failed = 0;

function pass(name, extra = '') {
  passed += 1;
  console.log(`PASS ${name}${extra ? `  ${extra}` : ''}`);
}
function fail(name, detail) {
  failed += 1;
  console.error(`FAIL ${name}${detail ? `  ${detail}` : ''}`);
}
function check(name, condition, detail = '') {
  if (condition) pass(name);
  else fail(name, detail);
}
function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  });
}
function safeName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

// ------------------------------------------------------------- fake engine

const fakeDir = path.join(TMP, 'fake-rsrs');
fs.mkdirSync(fakeDir, { recursive: true });
fs.writeFileSync(
  path.join(fakeDir, 'cli.js'),
  `const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_CALL_LOG) fs.appendFileSync(process.env.FAKE_CALL_LOG, JSON.stringify(args) + '\\n');
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const command = args[0];
if (command === 'status') {
  if (process.env.FAKE_STATUS === 'fail') say({ status: 'fail', errors: ['boom'] });
  else say({ status: 'ok', summary: { session: { has_token: true, user: 'tester' }, local_total: 42 } });
} else if (command === 'recall') {
  if (process.env.FAKE_RECALL === 'skip') say({ status: 'skip', details: [] });
  else if (process.env.FAKE_RECALL === 'slow') setTimeout(() => say({ status: 'ok', details: [
    { id: 'abcdef1234567890', title: '项目 A 使用 pnpm 管理依赖', score: 0.91 }
  ] }), 5000);
  else say({ status: 'ok', details: [
    { id: 'abcdef1234567890', title: '项目 A 使用 pnpm 管理依赖', score: 0.91 },
    { id: 'fedcba9876543210', title: '构建脚本走 vite', score: 0.74 }
  ] });
} else if (command === 'diary') {
  const term = args[2] || '';
  const rows = [
    { id: '1111111122222222', title: '项目 A 使用 pnpm 管理依赖', content: '构建脚本走 vite，依赖用 pnpm。', importance: 'important' },
    { id: '3333333344444444', title: '活动轨迹 2026-11-01', content: '今天的杂事。', importance: 'trivial' }
  ].filter((row) => (row.title + row.content).includes(term) || term === '项目');
  say({ status: 'ok', summary: { count: rows.length }, details: rows });
} else if (command === 'mcp') {
  process.stdin.once('data', (chunk) => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'echo', params: { data: chunk.toString() } }) + '\\n';
    process.stdout.write(line, () => process.exit(0));
  });
} else if (command === 'remember') {
  if (process.env.FAKE_STORE === 'pending') say({ status: 'pending', written: false, items: [{ name: 'old', value: '旧记忆：项目 A 用 npm' }] });
  else say({ status: 'ok', summary: { id: '1122334455667788' } });
} else {
  say({ status: 'ok' });
}
`,
  'utf8',
);
const shim =
  process.platform === 'win32'
    ? path.join(fakeDir, 'fake-rsrs.cmd')
    : path.join(fakeDir, 'fake-rsrs');
fs.writeFileSync(
  shim,
  process.platform === 'win32'
    ? '@node "%~dp0cli.js" %*\n'
    : '#!/bin/sh\nexec node "$(dirname "$0")/cli.js" "$@"\n',
  'utf8',
);
if (process.platform !== 'win32') fs.chmodSync(shim, 0o755);

function runHook(name, event, payload, options = {}) {
  const dir = path.join(TMP, 'cases', safeName(name));
  fs.mkdirSync(dir, { recursive: true });
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      rsrs: options.hideEngine
        ? ''
        : options.engine === undefined
          ? shim
          : options.engine,
      ...(options.config || {}),
    }),
    'utf8',
  );
  const env = {
    ...process.env,
    PLUGIN_ROOT: GENERATED,
    RESPITE_CONFIG: config,
    RESPITE_DATA: dir,
    RESPITE_LOG: path.join(dir, 'hook.log'),
    RESPITE_NUDGE_STATE: path.join(dir, '.nudge'),
    FAKE_CALL_LOG: path.join(dir, 'calls.log'),
    ...(options.env || {}),
  };
  if (options.hideEngine) {
    env.PATH = EMPTY_DIR;
    env.APPDATA = '';
    env.LOCALAPPDATA = '';
    env.USERPROFILE = path.join(TMP, 'nohome');
    env.HOME = path.join(TMP, 'nohome');
    env.RESPITE_RSRS = '';
    env.RESPIRE_BIN = '';
  }
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [HOOK, event], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  return {
    dir,
    durationMs: Date.now() - startedAt,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    calls: fs.existsSync(path.join(dir, 'calls.log'))
      ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean)
      : [],
  };
}

const base = { hook_event_name: 'UserPromptSubmit', session_id: 'test', cwd: TMP };

// --------------------------------------------------------- build/validate

const build = CHECK_ONLY
  ? runNode([BUILDER, '--check'])
  : runNode([BUILDER]);
check(
  CHECK_ONLY ? 'generated plugin is up to date' : 'generated plugin builds',
  build.status === 0,
  (build.stderr || build.stdout || '').trim().split('\n').slice(-2).join(' | '),
);

const validateGeneral = runNode([VALIDATOR, ROOT]);
check('general package validates', validateGeneral.status === 0, validateGeneral.stderr.trim());
const validateGenerated = runNode([VALIDATOR, GENERATED]);
check('generated package validates', validateGenerated.status === 0, validateGenerated.stderr.trim());

const adapter = fs.readFileSync(
  path.join(ROOT, 'adapters', 'minimax-code', 'respire-hook.mjs'),
  'utf8',
);
const generatedHook = fs.readFileSync(HOOK, 'utf8');
check('hook script copied byte-for-byte', adapter === generatedHook);

const rootMcp = JSON.parse(fs.readFileSync(path.join(GENERATED, 'mcp.json'), 'utf8'));
const inlineManifest = JSON.parse(
  fs.readFileSync(path.join(GENERATED, '.claude-plugin', 'plugin.json'), 'utf8'),
);
const rootArg = rootMcp.mcpServers.respire.args.join(' ');
const inlineArg = inlineManifest.mcpServers.respire.args.join(' ');
check('portable MCP uses ${PLUGIN_ROOT}', rootArg.includes('${PLUGIN_ROOT}/mcp/respire-mcp.mjs'));
check(
  'mcode inline MCP uses ${CLAUDE_PLUGIN_ROOT}',
  inlineArg.includes('${CLAUDE_PLUGIN_ROOT}/mcp/respire-mcp.mjs'),
);
check('mcode inline MCP does not leak ${PLUGIN_ROOT}', !inlineArg.includes('${PLUGIN_ROOT}'));

const inlineHookArg = inlineManifest.hooks.SessionStart[0].hooks[0].args.join(' ');
const legacyHooks = JSON.parse(
  fs.readFileSync(path.join(GENERATED, 'io.minimax.mcode', 'hooks', 'hooks.json'), 'utf8'),
);
const legacyHookArg = legacyHooks.hooks.SessionStart[0].args.join(' ');
check('mcode inline hooks use ${CLAUDE_PLUGIN_ROOT}', inlineHookArg.includes('${CLAUDE_PLUGIN_ROOT}'));
check('mcode 0.3 hooks use ${PLUGIN_ROOT}', legacyHookArg.includes('${PLUGIN_ROOT}'));

const bridge = path.join(GENERATED, 'mcp', 'respire-mcp.mjs');
const bridgeRun = spawnSync(process.execPath, [bridge], {
  input: 'ping\n',
  encoding: 'utf8',
  timeout: 15_000,
  env: { ...process.env, RESPITE_BIN: shim, RESPITE_RSRS: '', RESPITE_CONFIG: '' },
});
check(
  'MCP bridge resolves the shim and proxies stdio',
  bridgeRun.status === 0 && bridgeRun.stdout.includes('ping'),
  `${bridgeRun.status} ${bridgeRun.stdout.slice(0, 120)} ${bridgeRun.stderr.slice(0, 120)}`,
);

const noEngineEnv = {
  ...process.env,
  PATH: EMPTY_DIR,
  APPDATA: '',
  LOCALAPPDATA: '',
  USERPROFILE: path.join(TMP, 'nohome'),
  HOME: path.join(TMP, 'nohome'),
  RESPITE_BIN: '',
  RESPITE_RSRS: '',
  RESPITE_CONFIG: '',
};
const bridgeMissing = spawnSync(process.execPath, [bridge], {
  input: '',
  encoding: 'utf8',
  timeout: 15_000,
  env: noEngineEnv,
});
check(
  'MCP bridge fails visibly when the engine is missing',
  bridgeMissing.status !== 0 && bridgeMissing.stderr.includes('engine not found'),
  bridgeMissing.stderr.slice(0, 160),
);

// ---------------------------------------------------------------- session

let r = runHook('session', 'SessionStart', { ...base, source: 'startup' });
check('SessionStart injects rules', r.stdout.includes('respire 记忆层'));
check('SessionStart names rrss.rs', r.stdout.includes('rsrs.rs'));
check('SessionStart quiet when logged in', !r.stdout.includes('尚未登录'));
check('SessionStart quiet when library not empty', !r.stdout.includes('记忆库还是空的'));
check('SessionStart quiet when model installed', !r.stdout.includes('语义模型（BGE-M3）未装'));
check('SessionStart exits 0', r.status === 0, String(r.status));

r = runHook('session-login', 'SessionStart', { ...base, source: 'startup' }, { env: { RESPITE_FAKE_LOGGED_OUT: '1' } });
check('SessionStart nudges login', r.stdout.includes('尚未登录'));
check('SessionStart login nudge has oauth command', r.stdout.includes('rsrs login --oauth --no-open'));

r = runHook('session-empty', 'SessionStart', { ...base, source: 'startup' }, { env: { RESPITE_FAKE_EMPTY: '1' } });
check('SessionStart nudges empty library', r.stdout.includes('记忆库还是空的'));

r = runHook('session-model', 'SessionStart', { ...base, source: 'startup' }, { env: { RESPITE_FAKE_NO_MODEL: '1' } });
check('SessionStart offers optional model install', r.stdout.includes('rsrs model activate m3'));
check('SessionStart labels lexical fallback', r.stdout.includes('词面档'));

r = runHook('session-probe-fail', 'SessionStart', { ...base, source: 'startup' }, { env: { RESPITE_FAKE_PROBE_FAIL: '1' } });
check('SessionStart reports probe failure', r.stdout.includes('状态探测失败'));

r = runHook('session-off', 'SessionStart', { ...base, source: 'startup' }, { config: { session_rules: false } });
check('session_rules=false is silent', r.stdout === '');

// ----------------------------------------------------------------- prompt

r = runHook('prompt-store', 'UserPromptSubmit', { ...base, prompt: '记：项目 A 改用 pnpm，因为 npm 锁文件冲突' });
check('store prefix writes memory', r.stdout.includes('已存入'));
check('store receipt asks for retitle', r.stdout.includes('rsrs retitle'));
check('store calls remember', r.calls.some((line) => line.includes('"remember"')), r.calls.join(' / '));

r = runHook('prompt-store-pending', 'UserPromptSubmit', { ...base, prompt: 'remember: 项目 A 改用 pnpm' }, { env: { FAKE_STORE: 'pending' } });
check('pending store reports candidates', r.stdout.includes('落库待决') && r.stdout.includes('旧记忆'));
check('pending store points to --force', r.stdout.includes('--force'));

r = runHook('prompt-store-force', 'UserPromptSubmit', { ...base, prompt: '记：项目 A 改用 pnpm' }, { config: { store_force: true } });
check('store_force passes --force', r.calls.some((line) => line.includes('--force')), r.calls.join(' / '));
check('store_force receipt discloses skipped dedup', r.stdout.includes('store_force 直写'));

r = runHook('prompt-store-long', 'UserPromptSubmit', { ...base, prompt: `记：${'x'.repeat(20_001)}` });
check('oversized store is rejected before spawning', r.stdout.includes('内容过长') && r.calls.length === 0);

r = runHook('prompt-recall', 'UserPromptSubmit', { ...base, prompt: '项目 A 的构建怎么做' });
check('recall injects title tier', r.stdout.includes('自动召回') && r.stdout.includes('项目 A 使用 pnpm 管理依赖'));
check('recall keeps score and short id', r.stdout.includes('0.91') && r.stdout.includes('abcdef12'));
check('recall never leaks full id', !r.stdout.includes('abcdef1234567890'));
check('recall returns two hits within budget', (r.stdout.match(/^- \[/gm) || []).length === 2);
check('recall passes prompt to engine', r.calls.some((line) => line.includes('项目 A 的构建怎么做')));

r = runHook('prompt-skip', 'UserPromptSubmit', { ...base, prompt: '项目 A 的构建怎么做' }, { env: { FAKE_RECALL: 'skip' } });
check('engine skip injects nothing', r.stdout === '');
check('engine skip does not run lexical fallback', !r.calls.some((line) => line.includes('"diary"')), r.calls.join(' / '));

r = runHook('prompt-lexical', 'UserPromptSubmit', { ...base, prompt: '项目 A 的构建怎么做' }, { config: { semantic_timeout_ms: 600 }, env: { FAKE_RECALL: 'slow' } });
check('semantic timeout falls back to lexical recall', r.stdout.includes('词面兜底') && r.stdout.includes('项目 A 使用 pnpm 管理依赖'));
check('lexical fallback hides trivial entries', !r.stdout.includes('活动轨迹'));
check('lexical fallback calls diary', r.calls.some((line) => line.includes('"diary"')), r.calls.join(' / '));
check('recall stays inside the 10s handler budget', r.durationMs < 10_000, `${r.durationMs}ms`);

r = runHook('prompt-lexical-off', 'UserPromptSubmit', { ...base, prompt: '项目 A 的构建怎么做' }, { config: { semantic_timeout_ms: 600, lexical_fallback: false }, env: { FAKE_RECALL: 'slow' } });
check('lexical_fallback=false keeps the hook silent on timeout', r.stdout === '' && !r.calls.some((line) => line.includes('"diary"')));

r = runHook('prompt-nomem', 'UserPromptSubmit', { ...base, prompt: '/nomem 项目 A 的构建怎么做' });
check('/nomem bypasses recall', r.stdout === '' && r.calls.length === 0);

r = runHook('prompt-short', 'UserPromptSubmit', { ...base, prompt: '好' });
check('short prompt bypasses recall', r.stdout === '' && r.calls.length === 0);

r = runHook('prompt-internal', 'UserPromptSubmit', { ...base, prompt: '内部提示：不要记录' }, { config: { skip_prefixes: ['内部提示：'] } });
check('skip_prefixes bypasses recall', r.stdout === '' && r.calls.length === 0);

// ------------------------------------------------------------ degradation

r = runHook('prompt-no-engine', 'UserPromptSubmit', { ...base, prompt: '记：项目 A 改用 pnpm' }, { hideEngine: true });
check('missing engine gives install command on store', r.stdout.includes('引擎未装') && r.stdout.includes('npm i -g @rsrsai/cli@latest'));

r = runHook('prompt-no-engine-recall', 'UserPromptSubmit', { ...base, prompt: '项目 A 的构建怎么做' }, { hideEngine: true });
check('missing engine fails open on recall', r.stdout === '' && r.status === 0);

// ------------------------------------------------------------------- stop

r = runHook('stop', 'Stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
let stopDecision = {};
try {
  stopDecision = JSON.parse(r.stdout);
} catch {
  /* asserted below */
}
check('Stop blocks with a reason', stopDecision.decision === 'block' && Boolean(stopDecision.reason));
check('Stop reason asks for memory check', String(stopDecision.reason || '').includes('记忆检查'));

r = runHook('stop-active', 'Stop', { ...base, hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'done' });
check('Stop respects stop_hook_active', r.stdout === '');

r = runHook('stop-disabled', 'Stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, { config: { enabled: false } });
check('enabled=false silences the hook', r.stdout === '');

r = runHook('stop-every-two', 'Stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }, { config: { store_nudge_every: 0 } });
check('store_nudge_every=0 disables nudge', r.stdout === '');

// ----------------------------------------------------------- fail-open

r = runHook('bad-json', 'UserPromptSubmit', '{not json');
check('bad stdin fails open', r.stdout === '' && r.status === 0);

r = runHook('unknown-event', 'Nope', base);
check('unknown event is silent', r.stdout === '' && r.status === 0);

// ---------------------------------------------------------------- summary

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
