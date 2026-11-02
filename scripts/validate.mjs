#!/usr/bin/env node
/**
 * Zero-dependency validator for respire plugins.
 *
 * Checks the portable Agent Plugins 1.0.0 contract (closed plugin.json,
 * skills/, mcp.json) and, when present, the MiniMax Code client extension
 * (.claude-plugin/plugin.json + io.minimax.mcode/hooks/hooks.json).
 *
 * Usage:
 *   node scripts/validate.mjs [plugin-dir]
 *
 * Exit 0 = pass, 1 = at least one FAIL.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MANIFEST_KEYS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'license',
  'keywords',
  'extensions',
  'repository',
]);
const EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
]);
const V1_CATEGORIES = new Set([
  'Office',
  'Studio',
  'Design & Sites',
  'Code',
  'Business',
  'Sales',
  'Productivity',
  'Science & Healthcare',
  'Education',
  'Other',
]);
let failed = false;

function ok(message) {
  console.log(`OK   ${message}`);
}
function fail(message) {
  failed = true;
  console.error(`FAIL ${message}`);
}
function readJson(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return { missing: true };
  try {
    return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    fail(`${rel}: invalid JSON (${error.message})`);
    return { missing: false, invalid: true };
  }
}
function inside(file) {
  try {
    const resolved = fs.realpathSync(file);
    const root = fs.realpathSync(ROOT);
    return resolved === root || resolved.startsWith(root + path.sep);
  } catch {
    return false;
  }
}
function checkContained(label, rel, base = ROOT) {
  const file = path.resolve(base, rel);
  if (!fs.existsSync(file)) return fail(`${label}: missing ${rel}`);
  if (!inside(file)) return fail(`${label}: escapes plugin root (${rel})`);
  return true;
}
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ---------------------------------------------------------------- manifest

const manifest = readJson('plugin.json');
let rootManifest = null;
if (manifest.value) {
  const doc = manifest.value;
  if (!isRecord(doc)) {
    fail('plugin.json: top level must be an object');
  } else {
    rootManifest = doc;
    for (const key of Object.keys(doc)) {
      if (!MANIFEST_KEYS.has(key)) fail(`plugin.json: unknown top-level field ${key}`);
    }
    if (doc.$schema !== SCHEMA) fail(`plugin.json: $schema must be ${SCHEMA}`);
    if (typeof doc.name !== 'string' || !NAME_RE.test(doc.name) || doc.name.length > 64) {
      fail('plugin.json: invalid name');
    } else if (doc.name !== path.basename(ROOT)) {
      fail(`plugin.json: name ${doc.name} != directory ${path.basename(ROOT)}`);
    }
    if (doc.version !== undefined && typeof doc.version !== 'string') fail('plugin.json: version must be string');
    if (doc.description !== undefined && typeof doc.description !== 'string') fail('plugin.json: description must be string');
    if (doc.homepage !== undefined && typeof doc.homepage !== 'string') fail('plugin.json: homepage must be string');
    if (doc.repository !== undefined && typeof doc.repository !== 'string') fail('plugin.json: repository must be string');
    if (doc.license !== undefined && typeof doc.license !== 'string') fail('plugin.json: license must be string');
    if (doc.keywords !== undefined && !isStringArray(doc.keywords)) fail('plugin.json: keywords must be string[]');
    if (doc.author !== undefined) {
      if (!isRecord(doc.author)) fail('plugin.json: author must be object');
      else {
        for (const [key, value] of Object.entries(doc.author)) {
          if (!['name', 'email', 'url'].includes(key)) fail(`plugin.json: author.${key} not allowed`);
          if (typeof value !== 'string') fail(`plugin.json: author.${key} must be string`);
        }
      }
    }
    if (doc.extensions !== undefined && !isRecord(doc.extensions)) {
      fail('plugin.json: extensions must be object');
    }
    if (!failed) ok('plugin.json (Agent Plugins 1.0.0 manifest)');
  }
}

// -------------------------------------------------------------------- mcp

function validateServer(name, server, label) {
  if (!isRecord(server)) return fail(`${label}.${name}: must be object`);
  const type = server.type;
  const allowed =
    type === 'stdio'
      ? new Set(['type', 'command', 'args', 'env', 'cwd'])
      : type === 'streamable-http' || type === 'sse'
        ? new Set(['type', 'url', 'headers'])
        : null;
  if (!allowed) return fail(`${label}.${name}: unsupported type ${JSON.stringify(type)}`);
  for (const key of Object.keys(server)) {
    if (!allowed.has(key)) fail(`${label}.${name}: field ${key} not allowed for ${type}`);
  }
  if (type === 'stdio') {
    if (typeof server.command !== 'string' || !server.command.trim()) {
      fail(`${label}.${name}: command required`);
    } else if (/\s/.test(server.command)) {
      fail(`${label}.${name}: command must be one executable token`);
    } else if (server.command.startsWith('./')) {
      checkContained(`${label}.${name}.command`, server.command);
    } else if (server.command.includes('/') || server.command.includes('\\')) {
      fail(`${label}.${name}: command must be bare or ./-relative`);
    } else if (/\$\{/.test(server.command)) {
      fail(`${label}.${name}: placeholders are not expanded in command`);
    }
    if (server.args !== undefined && !isStringArray(server.args)) fail(`${label}.${name}: args must be string[]`);
    for (const arg of server.args || []) {
      if (arg.includes('..')) fail(`${label}.${name}: args must not contain ..`);
      for (const token of ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
        const pattern = new RegExp(`\\$\\{${token}\\}/([^"' ]+)`, 'g');
        for (const match of arg.matchAll(pattern)) {
          checkContained(`${label}.${name}.args`, match[1]);
        }
      }
    }
    if (server.env !== undefined) {
      if (!isRecord(server.env)) fail(`${label}.${name}: env must be object`);
      else {
        for (const [key, value] of Object.entries(server.env)) {
          if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA') fail(`${label}.${name}: reserved env ${key}`);
          if (typeof value !== 'string') fail(`${label}.${name}.env.${key}: must be string`);
        }
      }
    }
    if (server.cwd !== undefined) {
      if (typeof server.cwd !== 'string') fail(`${label}.${name}: cwd must be string`);
      else if (!/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(server.cwd)) {
        fail(`${label}.${name}: invalid cwd form ${server.cwd}`);
      } else if (server.cwd.startsWith('./')) {
        checkContained(`${label}.${name}.cwd`, server.cwd);
      }
    }
  } else {
    if (typeof server.url !== 'string') return fail(`${label}.${name}: url required`);
    let url;
    try {
      url = new URL(server.url);
    } catch {
      return fail(`${label}.${name}: invalid url`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) fail(`${label}.${name}: url must be http(s)`);
    if (url.username || url.password) fail(`${label}.${name}: url must not contain userinfo`);
    if (url.hash) fail(`${label}.${name}: url must not contain a fragment`);
    const loopback =
      url.hostname === 'localhost' || /^(?:127\.|::1$|\[::1\])/.test(url.hostname);
    if (url.protocol === 'http:' && !loopback) fail(`${label}.${name}: non-loopback url must use https`);
    if (server.headers !== undefined) {
      if (!isRecord(server.headers)) fail(`${label}.${name}: headers must be object`);
      else {
        const seen = new Set();
        for (const [key, value] of Object.entries(server.headers)) {
          if (seen.has(key.toLowerCase())) fail(`${label}.${name}: duplicate header ${key}`);
          seen.add(key.toLowerCase());
          if (typeof value !== 'string') fail(`${label}.${name}.headers.${key}: must be string`);
          if (/\$\{/.test(value)) fail(`${label}.${name}.headers.${key}: no placeholder expansion allowed`);
        }
      }
    }
  }
}

const mcp = readJson('mcp.json');
let portableMcpCount = 0;
if (mcp.value) {
  const doc = mcp.value;
  if (!isRecord(doc)) fail('mcp.json: top level must be object');
  else {
    for (const key of Object.keys(doc)) {
      if (!['$schema', 'mcpServers'].includes(key)) fail(`mcp.json: unknown field ${key}`);
    }
    if (doc.$schema !== MCP_SCHEMA) fail(`mcp.json: $schema must be ${MCP_SCHEMA}`);
    if (!isRecord(doc.mcpServers)) fail('mcp.json: mcpServers must be object');
    for (const [name, server] of Object.entries(doc.mcpServers || {})) {
      validateServer(name, server, 'mcp.json.mcpServers');
      portableMcpCount += 1;
    }
    if (!failed) ok('mcp.json (portable stdio/HTTP server config)');
  }
} else if (
  !fs.existsSync(path.join(ROOT, '.claude-plugin', 'plugin.json')) &&
  !fs.existsSync(path.join(ROOT, '.minimax-plugin', 'plugin.json'))
) {
  fail('missing mcp.json (and no client manifest to declare servers)');
}

// ------------------------------------------------------------------ skills

function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { error: 'missing frontmatter' };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { error: 'unterminated frontmatter' };
  const block = normalized.slice(3, end).trim();
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (Object.hasOwn(fields, match[1])) return { error: `duplicate frontmatter key ${match[1]}` };
    fields[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return { fields };
}

const skillsDir = path.join(ROOT, 'skills');
let skillCount = 0;
if (!fs.existsSync(skillsDir)) {
  fail('missing skills/');
} else if (!fs.statSync(skillsDir).isDirectory()) {
  fail('skills is not a directory');
} else {
  const skills = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: entry.name, file: path.join(skillsDir, entry.name, 'SKILL.md') }))
    .filter((skill) => fs.existsSync(skill.file));
  skillCount = skills.length;
  if (!skills.length) fail('skills/: no <name>/SKILL.md found');
  for (const skill of skills) {
    const text = fs.readFileSync(skill.file, 'utf8');
    const parsed = parseFrontmatter(text);
    if (parsed.error) {
      fail(`skills/${skill.dir}/SKILL.md: ${parsed.error}`);
      continue;
    }
    const { name, description } = parsed.fields;
    if (name !== skill.dir) fail(`skills/${skill.dir}/SKILL.md: name ${JSON.stringify(name)} != directory`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || '') || name.length > 64) {
      fail(`skills/${skill.dir}/SKILL.md: invalid name`);
    }
    if (!description) fail(`skills/${skill.dir}/SKILL.md: description required`);
    if (!inside(skill.file)) fail(`skills/${skill.dir}/SKILL.md: escapes plugin root`);
  }
  if (!failed) ok(`skills/ (${skills.length} skill${skills.length === 1 ? '' : 's'})`);
}

// ---------------------------------------------- MiniMax official V1

const v1Manifest = readJson('.minimax-plugin/plugin.json');
let hasMinimaxV1 = false;
let v1McpCount = 0;
if (!v1Manifest.missing) {
  const doc = v1Manifest.value;
  if (!isRecord(doc)) fail('.minimax-plugin/plugin.json: top level must be object');
  else {
    hasMinimaxV1 = true;
    for (const key of [
      'schemaVersion',
      'name',
      'version',
      'description',
      'author',
      'icon',
      'category',
      'exampleQueries',
      'apps',
      'mcpServers',
      'skills',
    ]) {
      if (!(key in doc)) fail(`.minimax-plugin/plugin.json: missing ${key}`);
    }
    if (doc.schemaVersion !== 1) fail('.minimax-plugin/plugin.json: schemaVersion must be 1');
    if (doc.name !== path.basename(ROOT)) {
      fail(`.minimax-plugin/plugin.json: name ${doc.name} != directory ${path.basename(ROOT)}`);
    }
    if (!V1_CATEGORIES.has(doc.category)) fail('.minimax-plugin/plugin.json: invalid category');
    if (
      !isStringArray(doc.exampleQueries) ||
      doc.exampleQueries.length < 1 ||
      doc.exampleQueries.length > 3 ||
      doc.exampleQueries.some((query) => !query.trim())
    ) {
      fail('.minimax-plugin/plugin.json: exampleQueries must be 1..3 non-empty strings');
    }
    if (!isStringArray(doc.apps)) fail('.minimax-plugin/plugin.json: apps must be string[]');
    if (typeof doc.icon !== 'string' || !/\.(?:png|jpe?g|webp)$/i.test(doc.icon)) {
      fail('.minimax-plugin/plugin.json: icon must be png/jpeg/webp');
    } else {
      checkContained('icon', doc.icon);
    }

    if (!isStringArray(doc.mcpServers) || !doc.mcpServers.length) {
      fail('.minimax-plugin/plugin.json: mcpServers must be a non-empty string[]');
    } else {
      for (const rel of doc.mcpServers) {
        if (!rel.endsWith('.mcp.json')) {
          fail(`mcpServers ref must end with .mcp.json (${rel})`);
          continue;
        }
        if (!checkContained('mcpServers', rel)) continue;
        const value = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.mcpServers)) {
          fail(`${rel}: needs schemaVersion 1 and mcpServers object`);
          continue;
        }
        for (const [name, server] of Object.entries(value.mcpServers)) {
          validateServer(name, server, rel);
          v1McpCount += 1;
        }
      }
    }

    if (!isStringArray(doc.skills) || !doc.skills.length) {
      fail('.minimax-plugin/plugin.json: skills must be a non-empty string[]');
    } else {
      for (const rel of doc.skills) {
        if (!/^skills\/[A-Za-z0-9._-]+\/SKILL\.md$/.test(rel)) {
          fail(`skills ref must be skills/<name>/SKILL.md (${rel})`);
          continue;
        }
        if (!checkContained('skills', rel)) continue;
        const parsed = parseFrontmatter(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        const dir = rel.split('/')[1];
        if (parsed.error || parsed.fields.name !== dir) {
          fail(`${rel}: frontmatter name must equal ${dir}`);
        }
      }
    }

    if (doc.hooks !== undefined) {
      if (!isStringArray(doc.hooks)) fail('.minimax-plugin/plugin.json: hooks must be string[]');
      else {
        for (const rel of doc.hooks) {
          if (!rel.endsWith('.json')) {
            fail(`hooks ref must be JSON (${rel})`);
            continue;
          }
          if (!checkContained('hooks', rel)) continue;
          const value = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
          if (!isRecord(value) || !isRecord(value.hooks)) {
            fail(`${rel}: needs top-level hooks object`);
            continue;
          }
          for (const [event, groups] of Object.entries(value.hooks)) {
            if (!EVENTS.has(event)) fail(`${rel}: unsupported event ${event}`);
            if (!Array.isArray(groups)) {
              fail(`${rel}.${event}: must be array`);
              continue;
            }
            for (const group of groups) {
              if (!isRecord(group) || !Array.isArray(group.hooks)) {
                fail(`${rel}.${event}: group needs hooks[]`);
                continue;
              }
              for (const handler of group.hooks) {
                if (!isRecord(handler)) {
                  fail(`${rel}.${event}: handler must be object`);
                  continue;
                }
                if (handler.type !== 'command') fail(`${rel}.${event}: only type=command`);
                if (typeof handler.command !== 'string' || !handler.command.trim()) {
                  fail(`${rel}.${event}: command required`);
                }
                if (
                  handler.timeout !== undefined &&
                  (!Number.isInteger(handler.timeout) || handler.timeout < 1 || handler.timeout > 10)
                ) {
                  fail(`${rel}.${event}: timeout must be 1..10 seconds`);
                }
                if (handler.commandWindows !== undefined && typeof handler.commandWindows !== 'string') {
                  fail(`${rel}.${event}: commandWindows must be string`);
                }
              }
            }
          }
        }
      }
    }
    if (!failed) ok('.minimax-plugin/plugin.json (MiniMax Plugin V1)');
  }
}

// ---------------------------------------------- MiniMax client extension

const mcodeManifest = readJson('.claude-plugin/plugin.json');
const legacyHooks = readJson('io.minimax.mcode/hooks/hooks.json');
let hasCompatible = false;
let inlineMcpCount = 0;

if (!mcodeManifest.missing) {
  const doc = mcodeManifest.value;
  if (!isRecord(doc)) fail('.claude-plugin/plugin.json: top level must be object');
  else {
    hasCompatible = true;
    if (typeof doc.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.name)) {
      fail('.claude-plugin/plugin.json: invalid name');
    }
    const expectedName = rootManifest ? rootManifest.name : path.basename(ROOT);
    if (doc.name !== expectedName) {
      fail(`.claude-plugin/plugin.json: name ${doc.name} must match ${expectedName}`);
    }
    if (doc.version !== undefined && typeof doc.version !== 'string') fail('.claude-plugin/plugin.json: version must be string');
    if (doc.hooks !== undefined) {
      if (!isRecord(doc.hooks)) fail('.claude-plugin/plugin.json: hooks must be object');
      else {
        for (const [event, groups] of Object.entries(doc.hooks)) {
          if (!EVENTS.has(event)) fail(`hooks: unsupported event ${event}`);
          if (!Array.isArray(groups)) {
            fail(`hooks.${event}: must be array`);
            continue;
          }
          for (const group of groups) {
            if (!isRecord(group) || !Array.isArray(group.hooks)) {
              fail(`hooks.${event}: group needs hooks[]`);
              continue;
            }
            if (group.matcher !== undefined && typeof group.matcher !== 'string') {
              fail(`hooks.${event}: matcher must be string`);
            }
            for (const handler of group.hooks) {
              if (!isRecord(handler)) {
                fail(`hooks.${event}: handler must be object`);
                continue;
              }
              if (handler.type !== 'command') fail(`hooks.${event}: only type=command is supported`);
              if (typeof handler.command !== 'string' || !handler.command.trim()) {
                fail(`hooks.${event}: command required`);
              }
              if (handler.args !== undefined && !isStringArray(handler.args)) {
                fail(`hooks.${event}: args must be string[]`);
              }
              if (
                handler.timeout !== undefined &&
                (!Number.isInteger(handler.timeout) || handler.timeout < 1 || handler.timeout > 10)
              ) {
                fail(`hooks.${event}: timeout must be an integer in 1..10 (seconds)`);
              }
              const allArgs = [handler.command, ...(handler.args || [])].join(' ');
              for (const token of ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
                const pattern = new RegExp(`\\$\\{${token}\\}/([^"' ]+)`, 'g');
                for (const match of allArgs.matchAll(pattern)) {
                  checkContained(`hooks.${event}: ${match[1]}`, match[1]);
                }
              }
            }
          }
        }
      }
    }
    if (doc.skills !== undefined) {
      const list = typeof doc.skills === 'string' ? [doc.skills] : doc.skills;
      if (!isStringArray(list)) fail('.claude-plugin/plugin.json: skills must be string or string[]');
      else {
        for (const rel of list) {
          if (!rel.startsWith('./')) fail(`skills path must start with ./ (${rel})`);
          else if (checkContained('skills', rel.slice(2))) {
            const parts = rel.split('/');
            if (parts.length > 2 && parts[1] === 'skills' && parts[2] !== '') {
              const parsed = parseFrontmatter(fs.readFileSync(path.join(ROOT, rel.slice(2)), 'utf8'));
              if (!parsed.error && parsed.fields.name !== parts[2]) {
                fail(`skills path ${rel}: directory must match frontmatter name`);
              }
            }
          }
        }
      }
    }
    if (doc.mcpServers !== undefined) {
      if (!isRecord(doc.mcpServers)) fail('.claude-plugin/plugin.json: mcpServers must be object');
      else {
        for (const [name, server] of Object.entries(doc.mcpServers)) {
          validateServer(name, server, '.claude-plugin.mcpServers');
          inlineMcpCount += 1;
        }
      }
    }
    if (!failed) ok('.claude-plugin/plugin.json (MiniMax Code 0.4.0+ manifest)');
  }
}

if (!legacyHooks.missing) {
  const doc = legacyHooks.value;
  if (!isRecord(doc) || !isRecord(doc.hooks)) {
    fail('io.minimax.mcode/hooks/hooks.json: needs top-level hooks object');
  } else {
    for (const [event, entries] of Object.entries(doc.hooks)) {
      if (!EVENTS.has(event)) fail(`legacy hooks: unsupported event ${event}`);
      if (!Array.isArray(entries)) {
        fail(`legacy hooks.${event}: must be array`);
        continue;
      }
      for (const entry of entries) {
        if (!isRecord(entry)) {
          fail(`legacy hooks.${event}: entry must be object`);
          continue;
        }
        if (typeof entry.command !== 'string' || !entry.command.trim()) {
          fail(`legacy hooks.${event}: command required`);
        }
        if (entry.args !== undefined && !isStringArray(entry.args)) {
          fail(`legacy hooks.${event}: args must be string[]`);
        }
        if (
          entry.timeout !== undefined &&
          (!Number.isInteger(entry.timeout) || entry.timeout < 1000 || entry.timeout > 10_000)
        ) {
          fail(`legacy hooks.${event}: timeout must be 1000..10000 (milliseconds)`);
        }
        const command = [entry.command || '', ...(entry.args || [])].join(' ');
        for (const match of command.matchAll(/\$\{PLUGIN_ROOT\}\/([^"' ]+)/g)) {
          checkContained(`legacy hooks.${event}: ${match[1]}`, match[1]);
        }
      }
    }
    if (!failed) ok('io.minimax.mcode/hooks/hooks.json (MiniMax 0.3.x hooks)');
  }
}

// hook/mcp script syntax
for (const rel of [
  'io.minimax.mcode/hooks/scripts/respire-hook.mjs',
  'hooks/scripts/respire-hook.mjs',
  'mcp/respire-mcp.mjs',
  'lib/inject.mjs',
  'scripts/setup-inject.mjs',
]) {
  const script = path.join(ROOT, rel);
  if (!fs.existsSync(script)) continue;
  const check = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  if (check.status === 0) ok(`${rel} syntax`);
  else fail(`${rel} syntax: ${check.stderr.split('\n')[0]}`);
}

if (!rootManifest && !hasCompatible && !hasMinimaxV1) {
  fail('missing plugin.json (and no client manifest)');
}
if (skillCount + portableMcpCount + inlineMcpCount + v1McpCount === 0) {
  fail('plugin exposes no Skill or MCP server');
}

// required docs
for (const file of ['README.md', 'LICENSE']) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`missing ${file}`);
}
if (!failed) ok('README.md + LICENSE');

// secret scan
const SECRET = /(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
let secretHit = false;
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.plugin-data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full);
      continue;
    }
    if (!/\.(md|json|mjs|js|cjs|py|txt|ya?ml|cmd|sh)$/i.test(entry.name) && entry.name !== 'LICENSE') continue;
    let text = '';
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (SECRET.test(text)) {
      fail(`possible secret in ${path.relative(ROOT, full)}`);
      secretHit = true;
    }
  }
}
scan(ROOT);
if (!secretHit) ok('secret scan');

if (failed) {
  console.error('\nVALIDATION FAILED');
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED: ${ROOT}`);
