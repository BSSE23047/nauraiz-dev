import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflight } from '../scripts/task/preflight.mjs';
import { checkCollision } from '../scripts/task/collision.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'scripts', 'task', 'preflight.mjs');
const config = { branch: { base: 'main', pattern: 'feature/${issue}-${slug}' } };
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });
const j = (v) => ok(JSON.stringify(v));

const ISSUE = {
  title: 'Add export', body: 'Please add export.\nBranch: `feature/27-export`', state: 'OPEN',
  labels: [{ name: 'enhancement' }, { name: 'p1' }],
  assignees: [],
  comments: [{ author: { login: 'colleague' }, body: 'I agree' }],
};

/** gh stub: records every call; `issue` is a JSON value or a runner result (has `code`). */
function ghStub({ me = 'me-dev', issue = ISSUE, prs = [], headPrs = [] } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api') return typeof me === 'string' ? ok(`${me}\n`) : me;
    if (args[0] === 'issue') return issue.code === undefined ? j(issue) : issue;
    if (args[0] === 'pr' && args.includes('--head')) return j(headPrs);
    if (args[0] === 'pr') return j(prs);
    return bad('unexpected');
  };
  gh.calls = calls;
  return gh;
}

/** git stub: fetch result, behind/ahead counts, ls-remote output. Records every call. */
function gitStub({ fetch = ok(), behind = '0\n', ahead = '2\n', remote = '', log = '' } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'config') return ok(args[1] === 'user.name' ? 'Me Dev\n' : 'me@x.io\n');
    if (args[0] === 'ls-remote') return ok(remote);
    if (args[0] === 'fetch') return fetch;
    if (args[0] === 'log') return ok(log);
    if (args[0] === 'rev-list' && args[2]?.startsWith('HEAD..')) return typeof behind === 'string' ? ok(behind) : behind;
    if (args[0] === 'rev-list') return typeof ahead === 'string' ? ok(ahead) : ahead;
    if (args[0] === 'rev-parse') return bad(''); // resolveBase: no such local ref -> origin/<base>
    return bad('unexpected');
  };
  git.calls = calls;
  return git;
}

const run = (opts) => preflight({ issue: 27, cwd: here, config, ...opts });
const issueCalls = (gh) => gh.calls.filter((a) => a[0] === 'issue');

test('free path: issue shaped, verdict free, base up to date; one issue call, one fetch', async () => {
  const gh = ghStub();
  const git = gitStub();
  const r = await run({ gh, git });
  assert.deepEqual(r.issue, {
    number: 27, title: 'Add export', body: 'Please add export.\nBranch: `feature/27-export`', labels: ['enhancement', 'p1'],
    state: 'OPEN', comments: [{ author: 'colleague', body: 'I agree' }],
  });
  assert.equal(r.collision.verdict, 'free');
  assert.equal(r.collision.remoteBranch.name, 'feature/27-export', 'the body branch comes from the shared issue data');
  assert.equal(r.base.name, 'main');
  assert.equal(r.base.ref, 'origin/main');
  assert.equal(r.base.behind, 0);
  assert.equal(r.base.fetched, true);
  assert.match(r.base.reason, /up to date/);
  assert.equal(issueCalls(gh).length, 1, 'gh issue view runs once');
  assert.deepEqual(issueCalls(gh)[0].slice(0, 3), ['issue', 'view', '27']);
  assert.ok(issueCalls(gh)[0].join(' ').includes('title,body,labels,state,comments,assignees'));
  assert.equal(git.calls.filter((a) => a[0] === 'fetch').length, 1 + 0, 'only the base fetch (no remote branch to read)');
  assert.deepEqual(git.calls.find((a) => a[0] === 'fetch'), ['fetch', 'origin', 'main']);
});

test('the collision result is exactly checkCollision with the same stubs', async () => {
  const mk = () => ({ gh: ghStub({ issue: { ...ISSUE, assignees: [{ login: 'other-dev' }] } }), git: gitStub() });
  const a = await run(mk());
  const b = await checkCollision({ issue: 27, cwd: here, config, ...mk() });
  assert.deepEqual(a.collision, b);
  assert.equal(a.collision.verdict, 'taken');
});

test('taken: another assignee still gives the issue and the base status', async () => {
  const gh = ghStub({ issue: { ...ISSUE, assignees: [{ login: 'other-dev' }] } });
  const r = await run({ gh, git: gitStub({ behind: '3\n', ahead: '0\n' }) });
  assert.equal(r.collision.verdict, 'taken');
  assert.deepEqual(r.collision.otherAssignees, ['other-dev']);
  assert.equal(r.issue.title, 'Add export');
  assert.equal(r.base.behind, 3);
  assert.equal(r.base.ahead, 0);
  assert.match(r.base.reason, /3 commits behind origin\/main; the branch has no commits of its own/);
});

test('unknown: gh issue view fails once; issue is null, verdict unknown, gh issue not called twice', async () => {
  const gh = ghStub({ issue: bad('HTTP 404') });
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.issue, null);
  assert.equal(r.collision.verdict, 'unknown');
  assert.match(r.collision.reason, /gh issue view.*HTTP 404/);
  assert.equal(issueCalls(gh).length, 1);
  assert.equal(r.base.behind, 0, 'the base check still runs');
});

test('unknown: gh itself missing (null exit) is tolerated', async () => {
  const gh = () => ({ code: null, stdout: '', stderr: 'spawn gh ENOENT' });
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.issue, null);
  assert.equal(r.collision.verdict, 'unknown');
});

test('unparsable issue JSON: issue null, verdict unknown, still one issue call', async () => {
  const gh = ghStub({ issue: ok('not json') });
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.issue, null);
  assert.equal(r.collision.verdict, 'unknown');
  assert.match(r.collision.reason, /unparsable JSON/);
  assert.equal(issueCalls(gh).length, 1);
});

test('no issue number: issue null, unknown verdict, gh never asked about the issue, base still checked', async () => {
  const gh = ghStub();
  const r = await preflight({ cwd: here, config, gh, git: gitStub() });
  assert.equal(r.issue, null);
  assert.equal(r.collision.verdict, 'unknown');
  assert.equal(gh.calls.length, 0);
  assert.equal(r.base.fetched, true);
});

test('a leading # on the issue is accepted', async () => {
  const r = await run({ issue: '#27', gh: ghStub(), git: gitStub() });
  assert.equal(r.issue.number, 27);
});

test('fetch failure: fetched false, behind null, reason set, never throws', async () => {
  const r = await run({ gh: ghStub(), git: gitStub({ fetch: bad('fatal: no such remote') }) });
  assert.equal(r.base.fetched, false);
  assert.equal(r.base.behind, null);
  assert.match(r.base.reason, /git fetch origin main failed \(fatal: no such remote\)/);
  assert.equal(r.collision.verdict, 'free', 'a base fetch failure is not a collision problem');
});

test('rev-list failure after a good fetch: behind null with a reason', async () => {
  const r = await run({ gh: ghStub(), git: gitStub({ behind: bad('bad revision') }) });
  assert.equal(r.base.fetched, true);
  assert.equal(r.base.behind, null);
  assert.match(r.base.reason, /bad revision/);
});

test('a throwing git runner never throws out of preflight', async () => {
  const git = () => { throw new Error('git exploded'); };
  const r = await run({ gh: ghStub(), git });
  assert.equal(r.base.behind, null);
  assert.equal(r.base.fetched, false);
  assert.equal(r.issue.title, 'Add export');
});

test('a throwing gh runner gives unknown, not a throw', async () => {
  const gh = () => { throw new Error('gh exploded'); };
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.issue, null);
  assert.equal(r.collision.verdict, 'unknown');
});

test('truncation: body and each comment are cut at 4000 chars with a marker; short text is untouched', async () => {
  const long = 'x'.repeat(5000);
  const gh = ghStub({ issue: { ...ISSUE, body: long, comments: [{ author: { login: 'a' }, body: long }, { author: null, body: 'short' }] } });
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.issue.body.length, 4000 + '…[truncated]'.length);
  assert.ok(r.issue.body.endsWith('…[truncated]'));
  assert.equal(r.issue.body.slice(0, 4000), 'x'.repeat(4000));
  assert.ok(r.issue.comments[0].body.endsWith('…[truncated]'));
  assert.deepEqual(r.issue.comments[1], { author: null, body: 'short' });
  const exact = await run({ gh: ghStub({ issue: { ...ISSUE, body: 'y'.repeat(4000) } }), git: gitStub() });
  assert.equal(exact.issue.body.length, 4000, 'exactly 4000 is not cut');
});

test('remote branch exists: the collision check fetches it too, so there are two fetches (branch, then base)', async () => {
  const git = gitStub({ remote: 'abc123\trefs/heads/feature/27-export\n', log: '' });
  const r = await run({ gh: ghStub(), git });
  assert.equal(r.collision.verdict, 'free');
  assert.equal(r.collision.remoteBranch.exists, true);
  // checkCollision runs `git fetch origin <branch>` to read the branch's authors; preflight then fetches the base once.
  assert.deepEqual(git.calls.filter((a) => a[0] === 'fetch'), [['fetch', 'origin', 'feature/27-export'], ['fetch', 'origin', 'main']]);
  assert.equal(r.base.fetched, true);
});

test('behind null after a good fetch (unreadable count) is reported with a reason, not as 0', async () => {
  const r = await run({ gh: ghStub(), git: gitStub({ behind: ok('garbage') }) });
  assert.equal(r.base.fetched, true);
  assert.equal(r.base.behind, null);
  assert.match(r.base.reason, /could not count commits behind origin\/main/);
});

test('an unreadable config file is tolerated in the exported function (defaults are used)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-preflight-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{ not json');
    const r = await preflight({ issue: 27, cwd: dir, gh: ghStub(), git: gitStub() });
    assert.equal(r.base.name, 'main');
    assert.equal(r.collision.verdict, 'free');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--branch is passed through to the collision check', async () => {
  const git = gitStub({ remote: '' });
  const r = await run({ gh: ghStub(), git, branch: 'feature/27-mine' });
  assert.equal(r.collision.remoteBranch.name, 'feature/27-mine');
  assert.ok(git.calls.some((a) => a[0] === 'ls-remote' && a.includes('feature/27-mine')));
});

test('CLI: prints one JSON object and exits 0 even when nothing works (no issue number)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-preflight-')); // not a repo: git fails fast, nothing is fetched
  try {
    const r = spawnSync(process.execPath, [cli, '--cwd', dir], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.issue, null);
    assert.equal(out.collision.verdict, 'unknown');
    assert.equal(out.base.fetched, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: started in a subfolder it loads the config of the project root (branch.base from the root file)', () => {
  const top = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nd-preflight-')));
  try {
    mkdirSync(path.join(top, '.claude'));
    mkdirSync(path.join(top, 'apps', 'server'), { recursive: true });
    writeFileSync(path.join(top, '.claude', 'nauraiz-dev.json'), JSON.stringify({ branch: { base: 'develop' } }));
    const sub = path.join(top, 'apps', 'server');
    const r = spawnSync(process.execPath, [cli], { cwd: sub, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).base.name, 'develop');
    const none = spawnSync(process.execPath, [cli, '--cwd'], { cwd: sub, encoding: 'utf8', timeout: 60000 });
    assert.equal(none.status, 0, '--cwd without a value does not throw');
  } finally { rmSync(top, { recursive: true, force: true }); }
});
