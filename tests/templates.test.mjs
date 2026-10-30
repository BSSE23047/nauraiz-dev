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

test('no client material in templates, the init and task skills, their evals or the init fixtures', () => {
  const dirs = [
    'templates', 'skills/init', 'skills/start-task', 'skills/grill', 'skills/kickoff-prompt', 'scripts/init',
    'evals/start-task-triggers', 'evals/start-task-small-negative', 'evals/grill-asks-on-decisions', 'evals/kickoff-triggers',
    'tests/fixtures/repos/npm-app', 'tests/fixtures/repos/flutter-app',
  ];
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

const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const APPROVAL_RULE = "Any `*_approval` field is `pending owner confirmation` unless the owner said yes in this session; then quote the date and the owner's words.";

/** Frontmatter and body of a 0.2 task skill, after checking the rules they share. */
function taskSkill(name) {
  const text = read(`skills/${name}/SKILL.md`);
  const fm = text.split('---\n')[1];
  const body = text.split('---\n').slice(2).join('---\n');
  assert.match(fm, new RegExp(`^name: ${name}$`, 'm'));
  const description = /^description: "(.*)"$/m.exec(fm)?.[1];
  assert.ok(description, `${name}: quoted description`);
  assert.ok(description.length <= 300, `${name}: description is ${description.length} chars`);
  assert.match(description, /\bNot for\b/, `${name}: description says what it is not for`);
  assert.doesNotMatch(fm, /disable-model-invocation/, `${name} must stay model-invocable`);
  assert.ok(lines(text).length <= 90, `${name}: ${lines(text).length} lines`);
  return { fm, body };
}

test('start-task skill: frontmatter, the nine steps in order, collision, exploration, approval rule, gate', () => {
  const { fm, body } = taskSkill('start-task');
  assert.match(fm, /^allowed-tools: Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/task\/collision\.mjs" \*\) Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/gate\/run\.mjs" \*\) Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/show\.mjs" \*\) Bash\(gh issue view \*\) Bash\(git fetch \*\) Bash\(git rev-list \*\) Read Glob Grep$/m);
  const steps = ['Identify', 'Collision check', 'Base check', 'Triage', 'Ask when it matters', 'Route the process', 'Explore cheaply', 'Plan', 'Build, gate, report'];
  let at = -1;
  steps.forEach((s, i) => {
    const next = body.indexOf(`\n${i + 1}. **${s}.**`);
    assert.ok(next > at, `step ${i + 1} "${s}" missing or out of order`);
    at = next;
  });
  for (const needle of [
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs"', '`taken`', '`unknown`', '`ours`', '`free`',
    '`Explore`', 'models.explore', '~5 files', '~800 lines', APPROVAL_RULE,
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" skills/start-task/reference.md',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs"', 'grill', 'gh issue view', 'git rev-list', 'branch.base',
  ]) assert.ok(body.includes(needle), `start-task must mention ${needle}`);
});

test('start-task reference: the routing table and the plan rules', () => {
  const ref = read('skills/start-task/reference.md');
  for (const phase of ['Questions', 'Design (large only)', 'Plan', 'Build', 'Debug', 'Before the report', 'Before a PR']) {
    assert.ok(ref.includes(`\n| ${phase} |`), `routing row ${phase}`);
  }
  for (const needle of [
    'superpowers:brainstorming', 'superpowers:writing-plans', 'superpowers:test-driven-development',
    'superpowers:subagent-driven-development', 'superpowers:systematic-debugging',
    'superpowers:verification-before-completion', '`branch:`', '### Allowed', 'Decisions to confirm',
    'plan.dir', 'plan.template', 'templates/plan-frontmatter.md', APPROVAL_RULE, '**small**', '**normal**', '**large**',
  ]) assert.ok(ref.includes(needle), `reference must mention ${needle}`);
  if (FORBIDDEN) assert.doesNotMatch(ref, FORBIDDEN);
});

test('grill skill: must-ask triggers, three questions, AskUserQuestion, headless rule, brainstorming after', () => {
  const { body } = taskSkill('grill');
  for (const needle of [
    'Decisions needed', 'Open decision', '"decide"', '"confirm"', '"TBD"', 'sharedPaths', '`shared`', '`*_approval`',
    'At most 3 questions', 'AskUserQuestion', 'recommended option first', 'cost if', 'Decisions to confirm',
    'claude -p', '`AskUserQuestion` is not available', 'superpowers:brainstorming',
  ]) assert.ok(body.includes(needle), `grill must mention ${needle}`);
});

test('kickoff-prompt skill and template: guard block first, placeholders, model and budget', () => {
  const { body } = taskSkill('kickoff-prompt');
  for (const needle of ['node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/kickoff-prompt.md', 'gh issue view', 'model', 'budget', 'mockupRoot', '{{absPath}}']) {
    assert.ok(body.includes(needle), `kickoff-prompt must mention ${needle}`);
  }
  const t = tpl('kickoff-prompt.md');
  for (const needle of ['{{absPath}}', '{{branch}}', '{{version}}', '{{enforcement}}', '`pwd`', '`git branch --show-current`',
    'nauraiz-dev v{{version}} · enforcement={{enforcement}}', 'do not cd', 'do not branch', 'Model:', 'Budget:']) {
    assert.ok(t.includes(needle), `kickoff template must contain ${needle}`);
  }
  assert.ok(t.indexOf('{{absPath}}') < t.indexOf('Model:'), 'the guard block comes first');
});

test('evals for start-task, grill and kickoff-prompt exist with the expected graders', () => {
  const evalCase = (name) => ({
    prompt: read(`evals/${name}/prompt.md`),
    graders: readdirSync(path.join(root, 'evals', name, 'graders')).map((f) => read(`evals/${name}/graders/${f}`)).join('\n'),
  });
  const skillFired = (skill) => `input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?${skill}"'`;
  const t = evalCase('start-task-triggers');
  assert.match(t.prompt, /^Work on issue #12 on branch feature\/12-x/m);
  assert.ok(t.graders.includes(skillFired('start-task')));
  const n = evalCase('start-task-small-negative');
  assert.match(n.prompt, /^fix the typo in README line 3/m);
  assert.ok(n.graders.includes(skillFired('start-task')));
  assert.match(n.graders, /^max: 0$/m);
  const g = evalCase('grill-asks-on-decisions');
  assert.match(g.prompt, /^## Decisions needed$/m);
  assert.match(g.graders, /AskUserQuestion/);
  assert.match(g.graders, /Decisions to confirm/);
  const k = evalCase('kickoff-triggers');
  assert.match(k.prompt, /^write a kickoff prompt for issue 12/m);
  assert.ok(k.graders.includes(skillFired('kickoff-prompt')));
  for (const c of [t, n, g, k]) assert.match(c.prompt, /^---\ndescription: .+\nmax_turns: \d+\nallowed_tools: \[/);
});
