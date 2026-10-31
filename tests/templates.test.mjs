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
const flat = (s) => s.replace(/\s+/g, ' ');
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
  assert.ok(text.includes("paste the gate runner's output verbatim"), 'gate section matches ship: the runner output, verbatim');
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
  for (const needle of ['--local', '--print', '.claude/nauraiz-dev.local.json', '.claude/settings.local.json', 'exclude.mjs', 'sharedPaths', 'offeredGate', 'testOneShot',
    'only the keys that differ from the tracked file', 'Never copy `protectedPaths`, `sharedPaths` or gate entries the tracked']) {
    assert.ok(body.includes(needle), `init skill must mention ${needle}`);
  }
  assert.ok(lines(text).length <= 110);
});

test('no client material in templates, the init and task skills, the agents, their evals or the init fixtures', () => {
  const dirs = [
    'templates', 'skills/init', 'skills/start-task', 'skills/grill', 'skills/kickoff-prompt', 'scripts/init',
    'skills/gate', 'skills/ship', 'skills/review', 'agents',
    'skills/capture-lesson', 'skills/memory-hygiene', 'skills/find-skills', 'scripts/memory', 'tests/fixtures/memory',
    'evals/capture-lesson-triggers', 'evals/memory-hygiene-triggers',
    'evals/start-task-triggers', 'evals/start-task-small-negative', 'evals/grill-asks-on-decisions', 'evals/kickoff-triggers',
    'evals/grill-small-negative', 'evals/start-task-taken-stops',
    'evals/gate-triggers', 'evals/ship-not-model-invoked', 'evals/review-triggers',
    'tests/fixtures/repos/npm-app', 'tests/fixtures/repos/flutter-app',
    'skills/measure', 'scripts/measure', 'tests/fixtures/measure',
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
  assert.match(fm, /^allowed-tools: Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/task\/preflight\.mjs" \*\) Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/task\/collision\.mjs" \*\) Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/gate\/run\.mjs" \*\) Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/show\.mjs" \*\) Bash\(gh issue view \*\) Bash\(git fetch \*\) Bash\(git rev-list \*\) Bash\(git branch --show-current\) Read Glob Grep$/m);
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
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs"', 'grill', 'gh issue view', 'branch.base',
    'even if `gh issue view` failed', 'prints no `verdict`', 'one process per phase',
    'that is the Plan phase', 'matches `sharedPaths`', 'run `grill` again before building',
    '`--branch <current branch>` when the issue',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/task/preflight.mjs"', 'ONE call for steps 1 to 3', 'make no other `gh` or `git` call',
    '`collision.verdict`', '`fetched` false', '`ahead` is 0', 'once, from any folder in the project',
    'never append `echo $?`, pipes or `cd`', 'Re-run only after you changed code, or once with `--plan <path>` when a row says `no plan for this branch`',
    '`behind` null', '`behind` above 0',
  ]) assert.ok(flat(body).includes(needle), `start-task must mention ${needle}`);
  // the plugin's reference file is read once, at routing, and never for a small task
  assert.equal(body.split('scripts/show.mjs').length - 1, 1, 'reference.md is read in one place');
  assert.ok(body.indexOf('scripts/show.mjs') > body.indexOf('\n6. **Route the process.**'), 'read at step 6, not at triage');
  assert.ok(body.includes('never read `reference.md`'), 'small tasks never read it');
  assert.doesNotMatch(body, /git fetch origin|git rev-list --count/, 'the fetch and the counts come from preflight');
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
    'plan.dir', 'plan.template', 'templates/plan-frontmatter.md', APPROVAL_RULE,
    'Use the Plan skill picked in step 6', '`## Decisions`', 'run `grill` again before building',
  ]) assert.ok(ref.includes(needle), `reference must mention ${needle}`);
  assert.doesNotMatch(ref, /\*\*(small|normal|large)\*\*/, 'the size rules live in SKILL.md only');
  assert.ok(ref.includes('`SKILL.md`, step 4'), 'reference points at the triage in SKILL.md');
  if (FORBIDDEN) assert.doesNotMatch(ref, FORBIDDEN);
});

test('grill skill: must-ask triggers, three questions, AskUserQuestion, headless rule, hands back to start-task', () => {
  const { body } = taskSkill('grill');
  for (const needle of [
    'Decisions needed', 'Open decision', '"decide"', '"confirm"', '"TBD"', 'sharedPaths', '`shared`', '`*_approval`',
    'At most 3 questions', 'AskUserQuestion', 'recommended option first', 'cost if', 'Decisions to confirm',
    'claude -p', '`AskUserQuestion` is not available', 'returns no answer', '`## Decisions`',
    'until step 8 writes the plan', 'Hand back to `start-task`',
  ]) assert.ok(body.includes(needle), `grill must mention ${needle}`);
  assert.doesNotMatch(body, /superpowers:brainstorming/, 'the design skill is routed by start-task, not hard-coded in grill');
  assert.doesNotMatch(body, /plain text/, 'no plain-text fallback: an unusable AskUserQuestion means headless');
});

test('kickoff-prompt skill and template: guard block first, placeholders, model and budget', () => {
  const { body } = taskSkill('kickoff-prompt');
  for (const needle of ['node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/kickoff-prompt.md', 'gh issue view', '- Model: size the task', '- Budget: the cap the owner gave',
    'one line naming the model and the budget', 'mockupRoot', '{{absPath}}']) {
    assert.ok(body.includes(needle), `kickoff-prompt must mention ${needle}`);
  }
  const t = tpl('kickoff-prompt.md');
  for (const needle of ['{{absPath}}', '{{branch}}', '{{version}}', '{{enforcement}}', '`pwd`', '`git branch --show-current`',
    'a line starting with `nauraiz-dev v{{version}} · enforcement={{enforcement}}`', 'in any path form',
    'do not cd', 'do not branch', 'Model:', 'Budget:']) {
    assert.ok(t.includes(needle), `kickoff template must contain ${needle}`);
  }
  assert.ok(t.startsWith('Work only in {{absPath}}.'), 'the guard block comes first');
  assert.ok(t.includes('stays `pending owner confirmation` unless the owner says yes in that session'), 'approval rule as in start-task');
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
  assert.match(g.prompt, /no GitHub issue/);
  assert.doesNotMatch(g.prompt, /#\d+/, 'an issue number would rightly send start-task to the collision check, which this case cannot run');
  assert.match(g.graders, /AskUserQuestion/);
  assert.match(g.graders, /Decisions to confirm/);
  const k = evalCase('kickoff-triggers');
  assert.match(k.prompt, /^write a kickoff prompt for issue 12/m);
  assert.ok(k.graders.includes(skillFired('kickoff-prompt')));
  const gs = evalCase('grill-small-negative');
  assert.match(gs.prompt, /^fix the typo .* in README line 3$/m);
  assert.match(gs.prompt, /^allowed_tools: \[.*AskUserQuestion.*\]$/m, 'the tool must be available for "never asked" to mean anything');
  assert.match(gs.graders, /^tool: AskUserQuestion$/m);
  assert.match(gs.graders, /^max: 0$/m);
  const ts = evalCase('start-task-taken-stops');
  assert.match(ts.prompt, /"verdict": "taken"/);
  assert.match(ts.prompt, /^allowed_tools: \[.*Edit, Write\]$/m, 'Edit and Write are available, so "not used" is a real stop');
  for (const tool of ['Edit', 'Write']) assert.match(ts.graders, new RegExp(`^tool: ${tool}\\ninput_match: .+\\nmin: 0\\nmax: 0$`, 'm'));
  assert.match(ts.graders, /^type: llm$/m);
  assert.match(ts.graders, /names other-dev/);
  for (const c of [t, n, g, k, gs, ts]) assert.match(c.prompt, /^---\ndescription: .+\nmax_turns: \d+\nallowed_tools: \[/);
});

const GATE_CMD = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs"';
const RUN_GATE_TOOL = 'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" *)';

/** Check each numbered step `N. **Title.**` appears, in order. */
function stepsInOrder(body, names) {
  let at = -1;
  names.forEach((s, i) => {
    const next = body.indexOf(`\n${i + 1}. **${s}.**`);
    assert.ok(next > at, `step ${i + 1} "${s}" missing or out of order`);
    at = next;
  });
}

test('gate skill: one runner call, exit codes 0/1/2, paste the output, no re-run by hand, init on exit 2', () => {
  const { fm, body } = taskSkill('gate');
  const tools = /^allowed-tools: (.*)$/m.exec(fm)?.[1] ?? '';
  assert.ok(tools.includes(RUN_GATE_TOOL), 'gate pre-approves the runner');
  assert.ok(tools.includes('Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs") '), 'gate pre-approves the bare call too');
  for (const needle of [
    GATE_CMD, '--plan <path>', '--only', '`0`', '`1`', '`2`', 'no gate is configured', '/nauraiz-dev:init',
    'no plan for this branch (pass --plan)', 'exit 0 but', 'verbatim', 'Never re-run', 'unless the runner reported',
    'never the gate result', '`nauraiz-dev:`', 'config failed to load', 'Any other non-zero exit',
    '`3`', 'gate runner failed', 'whatever the exit code',
    'once, from any folder in the project', "prints every command's exit code itself", 'never append `echo $?`, pipes',
    'or `cd`', 'Re-run only after you changed code, or once with `--plan <path>` when a row says `no plan for this branch`', 'nauraiz-dev gate: project root', 'relative paths are relative to the project root',
  ]) assert.ok(flat(body).includes(needle), `gate must mention ${needle}`);
  assert.doesNotMatch(body, /scripts\\gate/, 'forward slashes only: the Stop hook looks for scripts/gate/run.mjs');
});

test('ship skill: user-only, the seven steps in order, approvals panel, PR body source, never force or merge', () => {
  const text = read('skills/ship/SKILL.md');
  const fm = text.split('---\n')[1];
  const body = text.split('---\n').slice(2).join('---\n');
  assert.match(fm, /^name: ship$/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  const description = /^description: "(.*)"$/m.exec(fm)?.[1];
  assert.ok(description && description.length <= 300, `description ${description?.length}`);
  assert.match(description, /\bNot for\b/);
  const tools = /^allowed-tools: (.*)$/m.exec(fm)?.[1] ?? '';
  for (const t of [RUN_GATE_TOOL, 'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" *)', 'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" *)']) {
    assert.ok(tools.includes(t), `ship pre-approves ${t}`);
  }
  assert.doesNotMatch(tools, /git push|gh pr create|gh pr merge|git rebase/, 'writes to the remote or history are never pre-approved');
  assert.ok(lines(text).length <= 90, `${lines(text).length} lines`);
  // The plan commit comes before the gate, so the pushed HEAD is the gated HEAD without a history rewrite.
  stepsInOrder(body, ['Collision check', 'Base', 'Approvals', 'Plan commit', 'Gate', 'PR body', 'Push and open']);
  for (const needle of [
    "git log --format='%an <%ae>' origin/<base>..origin/<branch>", 'git config user.name', 'git config user.email',
    'git status --porcelain --untracked-files=no', 'commit or stash', 'refuses to start', 'gated HEAD',
    'git ls-files', '`nauraiz-dev:`', 'config failed to load', 'never offer to ship without a gate',
    'gh pr view <branch> --json url,state', 'instead of `gh pr create`',
    'leaving out the plan file', 'git status --porcelain -- <plan>', 'covers tracked files', 'untracked file the gate reads',
    'docs: plan for <branch>', 'Any other non-zero exit',
    'once, from any folder in the project', 'never append `echo $?`, pipes or `cd`',
    're-run only after you changed code, or once with `--plan <path>` when a row says `no plan for this branch`',
  ]) assert.ok(flat(body).includes(needle), `ship must mention ${needle}`);
  assert.doesNotMatch(body, /which to keep/, 'ship never rewrites history to drop commits');
  assert.doesNotMatch(body, /For each section/, 'the PR template is shown once');
  assert.equal(body.split('scripts/show.mjs').length - 1, 1, 'show.mjs runs once');
  for (const t of ['Bash(git config user.name)', 'Bash(git config user.email)']) assert.ok(tools.includes(t), `ship pre-approves ${t}`);
  for (const needle of [
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs"', '`taken`', '`unknown`', 'git fetch', 'git rebase origin/<base>',
    'git rebase --abort', 'force push', GATE_CMD, '`pending owner confirmation`', 'AskUserQuestion', '"Keep as given"', '"Set to pending"',
    'Headless', 'set every one to `pending owner confirmation`', 'Never choose for the owner',
    'git ls-tree -r --name-only origin/<base>', 'local mode',
    'gh pr list --state merged --author @me --limit 1 --json number', 'gh pr view <n> --json body', '`pr.sections`',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/PR_TEMPLATE.md', 'verbatim', '## Not verified', 'attribution',
    'git rev-parse --git-path', 'gh pr create', '--body-file', 'Never `--force`', 'never merge', 'do not ask again',
    'Exit 3 (the runner failed)',
  ]) assert.ok(flat(body).includes(needle), `ship must mention ${needle}`);
});

test('review skill: two modes, reviewer agent on a diff file, gate in a temp worktree, never Approved, merge only on "merge"', () => {
  const { fm, body } = taskSkill('review');
  const description = /^description: "(.*)"$/m.exec(fm)[1];
  assert.match(description, /\/nauraiz-dev:ship/, 'points push/PR requests at the user-only ship command');
  const tools = /^allowed-tools: (.*)$/m.exec(fm)?.[1] ?? '';
  assert.ok(tools.includes(RUN_GATE_TOOL));
  assert.doesNotMatch(tools, /gh pr merge|git checkout|gh pr checkout/, 'merging and checkouts are never pre-approved');
  for (const t of ['Bash(git worktree add --detach *)', 'Bash(git worktree list*)']) assert.ok(tools.includes(t), `review pre-approves ${t}`);
  assert.doesNotMatch(tools, /Bash\(git worktree \*\)|git worktree remove/, 'removing a worktree is never pre-approved');
  for (const needle of [
    "require('os').tmpdir()", '-review-<n>-<random>', 'never relative to', 'must not exist', 'the exact `<wt>` this run created',
    'isCrossRepository', 'package.json scripts', 'gate result includes uncommitted changes',
    '`sonnet`, `opus`, `haiku` or `fable`', 'Dispatch only after the diff file is written',
    'delete `<wt>/.claude/nauraiz-dev.json` and `<wt>/.claude/nauraiz-dev.local.json`',
    "this runs the fork's code through the gate", 'only if `git worktree add` succeeded',
  ]) assert.ok(flat(body).includes(needle), `review must mention ${needle}`);
  assert.doesNotMatch(body, /\.\.\/<this folder/, 'the worktree is never relative to the checkout');
  assert.doesNotMatch(body, /worktree prune/, 'prune could drop worktrees this run did not create');
  for (const needle of [
    '## Branch mode', '## PR mode', '`nauraiz-dev:reviewer`', 'models.review', 'git diff origin/<base>...HEAD >',
    'git rev-parse --git-path', 'Never paste a diff', GATE_CMD, 'gh pr diff <n> >', 'git fetch origin pull/<n>/head',
    'git worktree add --detach', '--cwd', 'git worktree remove --force', 'even when a step failed', '/code-review',
    '"Approved"', 'says "merge"', 'branch.merge', 'gh pr merge <n>', 'kickoff-prompt', 'After a merge only',
    'git branch --show-current', 'gh pr checkout',
    'once, from any folder in the project', 'never append `echo $?`, pipes or `cd`',
    're-run only after you changed code, or once with `--plan <path>` when a row says `no plan for this branch`',
  ]) assert.ok(flat(body).includes(needle), `review must mention ${needle}`);
});

/** Frontmatter of an agent file as a key -> raw value map, and its body. */
function agent(name) {
  const text = read(`agents/${name}.md`);
  const parts = text.split('---\n');
  assert.equal(parts[0], '', `${name}: starts with frontmatter`);
  const fm = Object.fromEntries(parts[1].trim().split('\n').map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }));
  return { fm, body: parts.slice(2).join('---\n') };
}

test('implementer agent: sonnet, edit tools, TDD and verification skills, one task, never pushes', () => {
  const { fm, body } = agent('implementer');
  assert.equal(fm.name, 'implementer');
  assert.ok(fm.description && fm.description.length <= 300);
  assert.equal(fm.model, 'sonnet');
  assert.equal(fm.tools, 'Read, Grep, Glob, Edit, Write, Bash');
  assert.equal(fm.skills, '[superpowers:test-driven-development, superpowers:verification-before-completion]');
  for (const needle of ['one task', '### Allowed', 'failing test', '`pending owner confirmation`', 'Never push', 'Status']) {
    assert.ok(body.includes(needle), `implementer must mention ${needle}`);
  }
});

test('reviewer agent: opus, read-only tools, reads the diff file, ranked review notes, never edits', () => {
  const { fm, body } = agent('reviewer');
  assert.equal(fm.name, 'reviewer');
  assert.ok(fm.description && fm.description.length <= 300);
  assert.equal(fm.model, 'opus');
  assert.equal(fm.tools, 'Read, Grep, Glob', 'R8: no Bash, the reviewer works from the diff file');
  for (const needle of ['diff file', 'Critical', 'Important', 'Minor', 'review notes', 'Never edit', '"Approved"', 'file:line']) {
    assert.ok(body.includes(needle), `reviewer must mention ${needle}`);
  }
  assert.doesNotMatch(body, /\bBash\b|git (log|show|blame|grep)/, 'the reviewer has no shell');
});

test('evals for gate, ship and review exist with the expected graders', () => {
  const evalCase = (name) => ({
    prompt: read(`evals/${name}/prompt.md`),
    graders: readdirSync(path.join(root, 'evals', name, 'graders')).map((f) => read(`evals/${name}/graders/${f}`)).join('\n'),
  });
  const skillFired = (skill) => `input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?${skill}"'`;
  const g = evalCase('gate-triggers');
  assert.ok(g.graders.includes(skillFired('gate')));
  assert.doesNotMatch(g.graders, /^max: 0$/m);
  const s = evalCase('ship-not-model-invoked');
  assert.match(s.prompt, /open a PR/);
  assert.ok(s.graders.includes(skillFired('ship')));
  assert.match(s.graders, /^max: 0$/m);
  assert.match(s.graders, /^type: llm$/m);
  assert.match(s.graders, /\/nauraiz-dev:ship/);
  const r = evalCase('review-triggers');
  assert.ok(r.graders.includes(skillFired('review')));
  assert.doesNotMatch(r.graders, /^max: 0$/m);
  for (const c of [g, s, r]) assert.match(c.prompt, /^---\ndescription: .+\nmax_turns: \d+\nallowed_tools: \[/);
});

test('capture-lesson, memory-hygiene and find-skills: short trigger-first descriptions, no shell beyond their script and read-only searches', () => {
  for (const name of ['capture-lesson', 'memory-hygiene', 'find-skills']) {
    const { fm } = taskSkill(name);
    const description = /^description: "(.*)"$/m.exec(fm)[1];
    assert.ok(description.length <= 200, `${name}: description is ${description.length} chars, budget is 200`);
  }
  const lesson = taskSkill('capture-lesson');
  assert.match(lesson.fm, /^allowed-tools: Read Write Edit Glob Grep$/m, 'capture-lesson has no shell');
  for (const needle of [
    'mode=local', '.claude/nauraiz-dev.local.json', 'auto-memory only', 'Never write a', 'tracked file', '.claude/knowledge/', '.claude/rules/',
    '<slug>', 'every non-alphanumeric character replaced by `-`', 'case-insensitively','*/memory/MEMORY.md', 'ask the owner for the folder', '[[file-name]]', 'MEMORY.md', '`Verified <date>:`',
    'Incident, <date>:', 'absolute dates', 'Do not commit',
  ]) assert.ok(lesson.body.includes(needle), `capture-lesson must mention ${needle}`);
  const hygiene = taskSkill('memory-hygiene');
  assert.match(hygiene.fm, /^allowed-tools: Read Edit Glob Grep Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/memory\/scan\.mjs" \*\)$/m);
  for (const needle of [
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/memory/scan.mjs"', '.claude/knowledge', '.claude/rules', 'relativeDates', 'staleSince', 'missingRefs', 'brokenLinks',
    'overLimit', '200 lines or 25,000 bytes', 'mode=local', '.claude/nauraiz-dev.local.json', 'only inside the auto-memory', 'never apply',
    'cannot rename or delete', 'by hand', 'every non-alphanumeric character replaced by `-`', 'case-insensitively', 'Propose, do not edit', '**stop**', 'Apply only the approved', '/doctor', 'contradict',
  ]) assert.ok(hygiene.body.includes(needle), `memory-hygiene must mention ${needle}`);
  const find = taskSkill('find-skills');
  const tools = /^allowed-tools: (.*)$/m.exec(find.fm)[1];
  assert.doesNotMatch(tools, /npx skills add|install|Write|Edit/, 'find-skills never installs or writes');
  assert.ok(tools.includes('Bash(gh search code *)'));
  assert.doesNotMatch(find.body, /gh api repos/, 'a raw read goes through the permission prompt, never a pre-approved gh api');
  for (const needle of [
    'npx skills find', 'gh search repos', 'offline, nothing suggested', 'at most 5', 'install command', 'listing cost', 'chars', 'Never run an install command',
    'gh search code description --filename SKILL.md --repo <owner>/<repo>',
  ]) assert.ok(find.body.includes(needle), `find-skills must mention ${needle}`);
});

test('no skill pre-approves gh api (it can mutate with the owner credentials)', () => {
  for (const name of readdirSync(path.join(root, 'skills'))) {
    const fm = read(`skills/${name}/SKILL.md`).split('---\n')[1];
    const tools = /^allowed-tools: (.*)$/m.exec(fm)?.[1] ?? '';
    assert.doesNotMatch(tools, /gh api/, `${name} must not allow gh api`);
  }
});

test('evals for capture-lesson and memory-hygiene trigger their skill', () => {
  const evalCase = (name) => ({
    prompt: read(`evals/${name}/prompt.md`),
    graders: readdirSync(path.join(root, 'evals', name, 'graders')).map((f) => read(`evals/${name}/graders/${f}`)).join('\n'),
  });
  const skillFired = (skill) => `input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?${skill}"'`;
  const c = evalCase('capture-lesson-triggers');
  assert.match(c.prompt, /^That was a gotcha, remember it for next time\.$/m);
  assert.ok(c.graders.includes(skillFired('capture-lesson')));
  const m = evalCase('memory-hygiene-triggers');
  assert.match(m.prompt, /^Clean up my project memory\.$/m);
  assert.ok(m.graders.includes(skillFired('memory-hygiene')));
  for (const e of [c, m]) assert.match(e.prompt, /^---\ndescription: .+\nmax_turns: \d+\nallowed_tools: \[/);
});
