import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../scripts/lib/config.mjs';
import { parsePlan } from '../scripts/lib/plan.mjs';
import { forbiddenPattern } from './forbidden.mjs';

const FORBIDDEN = forbiddenPattern();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tpl = (rel) => readFileSync(path.join(root, 'templates', rel), 'utf8');
const lines = (text) => text.replace(/\n$/, '').split('\n');

/** Keep the `{{#keep}}` blocks, drop the `{{#drop}}` blocks, remove the marker lines. */
function chooseState(text, keep, drop) {
  const out = [];
  let dropping = false;
  for (const line of text.split('\n')) {
    if (line === `{{#${drop}}}`) dropping = true;
    else if (line === `{{/${drop}}}`) dropping = false;
    else if (!dropping && line !== `{{#${keep}}}` && line !== `{{/${keep}}}`) out.push(line);
  }
  return out.join('\n');
}

test('config template mirrors DEFAULTS with guided enforcement and empty gate/protectedPaths', () => {
  const cfg = JSON.parse(tpl('nauraiz-dev.json'));
  for (const key of Object.keys(DEFAULTS)) assert.ok(key in cfg, `missing ${key}`);
  assert.equal(cfg.enforcement, 'guided');
  assert.equal(cfg.state, '{{state}}');
  assert.deepEqual(cfg.gate, {});
  assert.deepEqual(cfg.protectedPaths, []);
  assert.deepEqual(cfg.sharedPaths, []);
  assert.deepEqual(cfg.models, DEFAULTS.models);
  assert.deepEqual(cfg.pr, DEFAULTS.pr);
  assert.equal(cfg.scopeAsk, true);
});

test('CLAUDE.md template: at most 120 lines, required sections, balanced state blocks', () => {
  const text = tpl('CLAUDE.md');
  assert.ok(lines(text).length <= 120, `${lines(text).length} lines`);
  for (const h of ['What this is', 'Where things are', 'Commands and gate', 'Session discipline', 'Rules']) {
    assert.ok(text.includes(`\n## ${h}\n`), `missing section ${h}`);
  }
  for (const name of ['scaffold', 'none']) {
    const open = text.split(`{{#${name}}}`).length - 1;
    assert.ok(open >= 1);
    assert.equal(open, text.split(`{{/${name}}}`).length - 1, `${name} blocks unbalanced`);
  }
  for (const [keep, drop] of [['scaffold', 'none'], ['none', 'scaffold']]) {
    const out = chooseState(text, keep, drop);
    assert.doesNotMatch(out, /\{\{[#/]/);
    assert.match(out, /\n1\. \*\*Start\.\*\*/);
  }
  assert.match(chooseState(text, 'scaffold', 'none'), /\.claude\/state\/session\.md/);
  assert.doesNotMatch(chooseState(text, 'none', 'scaffold'), /state\/session\.md/);
});

test('plan template produces the plan contract the hooks read', () => {
  const filled = tpl('plan-frontmatter.md').replace('{{branch}}', 'feature/12-example').replace('{{path/or/glob/**}}', 'src/app/**');
  const plan = parsePlan(filled);
  assert.equal(plan.branch, 'feature/12-example');
  assert.deepEqual(plan.allowed, ['src/app/**']);
  assert.match(plan.handoff, /not started/);
});

test('state templates: backlog shows no fake item to the session hook, completed uses dated headings', () => {
  assert.doesNotMatch(tpl('state/backlog.md'), /^## /m);
  assert.match(tpl('state/completed.md'), /^# Completed\n[\s\S]*^## YYYY-MM-DD — Title$/m);
  assert.ok(lines(tpl('state/session.md')).length <= 20, 'session.md head must fit the 20 injected lines');
});

test('PR template has every configured section', () => {
  const text = tpl('PR_TEMPLATE.md');
  for (const s of DEFAULTS.pr.sections) assert.ok(text.includes(`\n## ${s}\n`), `missing ${s}`);
});

test('init skill frontmatter', () => {
  const text = readFileSync(path.join(root, 'skills', 'init', 'SKILL.md'), 'utf8');
  const fm = text.split('---\n')[1];
  const description = /^description: "(.*)"$/m.exec(fm)[1];
  assert.ok(description.length <= 1024);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(fm, /^allowed-tools: Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/init\/detect\.mjs" \*\) Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/show\.mjs" \*\) Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/init\/exclude\.mjs" \*\) Read Write Edit Glob$/m);
  assert.doesNotMatch(text.split('---\n').slice(2).join('---\n'), /Templates are in/);
  const body = text.split('---\n').slice(2).join('---\n');
  for (const needle of ['--local', '--print', '.claude/nauraiz-dev.local.json', '.claude/settings.local.json', 'exclude.mjs', 'sharedPaths', 'offeredGate', 'testOneShot']) {
    assert.ok(body.includes(needle), `init skill must mention ${needle}`);
  }
  assert.ok(lines(text).length <= 110);
});

test('no client material in templates, the init skill or the init fixtures', () => {
  const dirs = ['templates', 'skills/init', 'scripts/init', 'tests/fixtures/repos/npm-app', 'tests/fixtures/repos/flutter-app'];
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p); else files.push(p);
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  assert.ok(files.length >= 12);
  for (const f of files) {
    if (FORBIDDEN) assert.doesNotMatch(readFileSync(f, 'utf8'), FORBIDDEN, path.relative(root, f));
  }
});

test('rules README stays at most 3 lines (Claude Code loads .claude/rules/ every session)', () => {
  assert.ok(lines(tpl('rules/README.md')).length <= 3, `${lines(tpl('rules/README.md')).length} lines`);
  assert.match(tpl('knowledge/README.md'), /^## Writing a rule/m, 'the rule-writing guidance lives in the knowledge README');
});
