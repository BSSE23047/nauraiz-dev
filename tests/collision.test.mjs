import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCollision } from '../scripts/task/collision.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'scripts', 'task', 'collision.mjs');
const config = { branch: { base: 'main', pattern: 'feature/${issue}-${slug}' } };
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });
const j = (v) => ok(JSON.stringify(v));

/** gh stub: `issue` and `prs` are JSON values (or a runner result); records every call. */
function ghStub({ me = 'me-dev', issue = { assignees: [], body: '' }, prs = [], headPrs = [] } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api') return typeof me === 'string' ? ok(`${me}\n`) : me;
    if (args[0] === 'issue') return issue.code === undefined ? j(issue) : issue;
    if (args[0] === 'pr' && args.includes('--head')) return Array.isArray(headPrs) ? j(headPrs) : headPrs;
    if (args[0] === 'pr') return Array.isArray(prs) ? j(prs) : prs;
    return bad('unexpected');
  };
  gh.calls = calls;
  return gh;
}

/** git stub: `remote` is the ls-remote output, `log` the `%an|%ae` lines. */
function gitStub({ name = 'Me Dev', email = 'me@x.io', remote = '', fetch = ok(), log = '' } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'config') return ok((args[1] === 'user.name' ? name : email) + '\n');
    if (args[0] === 'ls-remote') return typeof remote === 'string' ? ok(remote) : remote;
    if (args[0] === 'fetch') return fetch;
    if (args[0] === 'log') return typeof log === 'string' ? ok(log) : log;
    return bad('unexpected');
  };
  git.calls = calls;
  return git;
}

const run = (opts) => checkCollision({ issue: 27, cwd: here, config, ...opts });
const pr = (over) => ({ number: 5, author: { login: 'colleague' }, headRefName: 'feature/27-x', title: 'Do thing', body: '', ...over });

test('free: no assignee, no PR, no remote branch', async () => {
  const r = await run({ gh: ghStub(), git: gitStub() });
  assert.equal(r.verdict, 'free');
  assert.equal(r.me, 'me-dev');
  assert.deepEqual(r.assignees, []);
  assert.deepEqual(r.otherAssignees, []);
  assert.deepEqual(r.openPRs, []);
  assert.match(r.reason, /^free: /);
});

test('taken: another assignee', async () => {
  const r = await run({ gh: ghStub({ issue: { assignees: [{ login: 'colleague' }], body: '' } }), git: gitStub() });
  assert.equal(r.verdict, 'taken');
  assert.deepEqual(r.otherAssignees, ['colleague']);
  assert.match(r.reason, /colleague/);
});

test('assigned only to me and nothing else: free', async () => {
  const r = await run({ gh: ghStub({ issue: { assignees: [{ login: 'ME-dev' }], body: '' } }), git: gitStub() });
  assert.equal(r.verdict, 'free');
  assert.deepEqual(r.otherAssignees, []);
});

test('taken: someone else open PR referencing #27 in its title', async () => {
  const gh = ghStub({ prs: [pr({ title: 'Fix #27 properly', headRefName: 'whatever' })] });
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.verdict, 'taken');
  assert.deepEqual(r.openPRs, [{ number: 5, author: 'colleague', head: 'whatever' }]);
  assert.match(r.reason, /#5/);
  const search = gh.calls.find((a) => a[0] === 'pr');
  assert.ok(search.includes('--state') && search.includes('open'));
  assert.ok(search.some((a) => a.includes('27 in:title,body')));
});

test('a PR mentioning #270 (or x#27) is not a match', async () => {
  const prs = [pr({ title: 'Fix #270', body: 'see #2700 and foo#27' })];
  const r = await run({ gh: ghStub({ prs }), git: gitStub() });
  assert.equal(r.verdict, 'free');
  assert.deepEqual(r.openPRs, []);
});

test('taken: PR body reference counts, closing keyword form', async () => {
  const r = await run({ gh: ghStub({ prs: [pr({ title: 'x', body: 'Closes #27.' })] }), git: gitStub() });
  assert.equal(r.verdict, 'taken');
});

test('PR whose head equals the branch matches without a reference', async () => {
  const prs = [pr({ title: 'unrelated', body: '', headRefName: 'feature/27-x' })];
  const r = await run({ branch: 'feature/27-x', gh: ghStub({ prs }), git: gitStub() });
  assert.equal(r.verdict, 'taken');
  assert.equal(r.openPRs.length, 1);
});

test('taken: a PR found only by --head (no #27 in title/body, absent from search)', async () => {
  const headPrs = [pr({ title: 'Quiet work', body: '', headRefName: 'feature/27-x' })];
  const r = await run({ branch: 'feature/27-x', gh: ghStub({ headPrs }), git: gitStub() });
  assert.equal(r.verdict, 'taken');
  assert.deepEqual(r.openPRs, [{ number: 5, author: 'colleague', head: 'feature/27-x' }]);
});

test('--head query args, and the same PR from search and --head is listed once', async () => {
  const same = pr({ title: 'Closes #27' });
  const gh = ghStub({ prs: [same], headPrs: [same] });
  const r = await run({ branch: 'feature/27-x', gh, git: gitStub() });
  const head = gh.calls.find((a) => a[0] === 'pr' && a.includes('--head'));
  assert.deepEqual(head, ['pr', 'list', '--state', 'open', '--head', 'feature/27-x', '--json', 'number,author,headRefName,title,body', '--limit', '100']);
  assert.equal(r.openPRs.length, 1);
});

test('no --head query when no branch is known', async () => {
  const gh = ghStub();
  await run({ gh, git: gitStub() });
  assert.equal(gh.calls.some((a) => a.includes('--head')), false);
});

test('gh failure on the --head query: unknown', async () => {
  const r = await run({ branch: 'feature/27-x', gh: ghStub({ headPrs: bad('rate limited') }), git: gitStub() });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /gh pr list --head/);
});

test('ours: my own PR', async () => {
  const prs = [pr({ author: { login: 'me-dev' }, title: 'Closes #27' })];
  const r = await run({ gh: ghStub({ prs }), git: gitStub() });
  assert.equal(r.verdict, 'ours');
  assert.match(r.reason, /^ours: /);
});

test('taken: assignee wins over my own PR', async () => {
  const gh = ghStub({ issue: { assignees: [{ login: 'colleague' }, { login: 'me-dev' }], body: '' }, prs: [pr({ author: { login: 'me-dev' }, title: '#27' })] });
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.verdict, 'taken');
});

test('branch name parsed from "Branch: `...`" in the body; remote by another author is taken', async () => {
  const gh = ghStub({ issue: { assignees: [], body: 'Do it.\nBranch: `feature/27-x`\n' } });
  const git = gitStub({ remote: 'abc123\trefs/heads/feature/27-x\n', log: 'Other Person|other@x.io\nOther Person|other@x.io\n' });
  const r = await run({ gh, git });
  assert.equal(r.remoteBranch.name, 'feature/27-x');
  assert.equal(r.remoteBranch.exists, true);
  assert.deepEqual(r.remoteBranch.authors, ['Other Person']);
  assert.equal(r.verdict, 'taken');
  assert.deepEqual(git.calls.find((a) => a[0] === 'ls-remote'), ['ls-remote', '--heads', 'origin', 'feature/27-x']);
  assert.deepEqual(git.calls.find((a) => a[0] === 'fetch'), ['fetch', 'origin', 'feature/27-x']);
  assert.deepEqual(git.calls.find((a) => a[0] === 'log'), ['log', 'origin/feature/27-x', '--not', 'origin/main', '--format=%an|%ae']);
});

test('the branch argument beats the body', async () => {
  const gh = ghStub({ issue: { assignees: [], body: 'Branch: `feature/27-body`' } });
  const r = await run({ branch: 'feature/27-arg', gh, git: gitStub() });
  assert.equal(r.remoteBranch.name, 'feature/27-arg');
});

test('remote branch with only my commits (by name or by email) is ours', async () => {
  const git = gitStub({ remote: 'abc\trefs/heads/feature/27-x\n', log: 'Me Dev|a@b.c\nSomeone Else Name|me@x.io\n' });
  const r = await run({ branch: 'feature/27-x', gh: ghStub(), git });
  assert.equal(r.verdict, 'ours');
  assert.equal(r.remoteBranch.exists, true);
});

test('remote branch with no commits beyond base does not make it taken', async () => {
  const git = gitStub({ remote: 'abc\trefs/heads/feature/27-x\n', log: '' });
  const r = await run({ branch: 'feature/27-x', gh: ghStub(), git });
  assert.equal(r.verdict, 'free');
  assert.equal(r.remoteBranch.exists, true);
  assert.deepEqual(r.remoteBranch.authors, []);
});

test('no branch in arg or body: pattern with ${slug} gives no remote check', async () => {
  const git = gitStub({ remote: 'abc\trefs/heads/feature/27-\n' });
  const r = await run({ gh: ghStub(), git });
  assert.equal(r.remoteBranch.name, null);
  assert.equal(r.remoteBranch.exists, false);
  assert.equal(git.calls.some((a) => a[0] === 'ls-remote'), false);
});

test('pattern without ${slug} is a complete branch name and is checked', async () => {
  const git = gitStub({ remote: 'abc\trefs/heads/issue-27\n', log: 'Other|o@x.io\n' });
  const r = await run({ config: { branch: { base: 'main', pattern: 'issue-${issue}' } }, gh: ghStub(), git });
  assert.equal(r.remoteBranch.name, 'issue-27');
  assert.equal(r.verdict, 'taken');
});

test('gh missing (runner throws ENOENT) gives unknown, never free, never throws', async () => {
  const gh = () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); };
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /gh/);
  assert.ok(r.reason.length > 0);
});

test('gh unauthenticated on the issue query: unknown, reason names the command', async () => {
  const r = await run({ gh: ghStub({ issue: bad('HTTP 401') }), git: gitStub() });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /gh issue view 27/);
  assert.equal(r.me, 'me-dev');
});

test('gh failure on the PR query: unknown', async () => {
  const r = await run({ gh: ghStub({ prs: bad('rate limited') }), git: gitStub() });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /gh pr list/);
});

test('gh api user failure: unknown', async () => {
  const r = await run({ gh: ghStub({ me: bad('not logged in') }), git: gitStub() });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /gh api user/);
});

test('unparsable gh JSON: unknown', async () => {
  const gh = (args) => (args[0] === 'api' ? ok('me-dev') : ok('not json'));
  const r = await run({ gh, git: gitStub() });
  assert.equal(r.verdict, 'unknown');
});

test('ls-remote failure with gh saying free: unknown (R13), exists null, mentioned in reason', async () => {
  const git = gitStub({ remote: bad('network down') });
  const r = await run({ branch: 'feature/27-x', gh: ghStub(), git });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /^unknown: /);
  assert.match(r.reason, /network down/);
  assert.equal(r.remoteBranch.exists, null);
  assert.match(r.reason, /remote branch/i);
  assert.match(r.reason, /ls-remote/);
});

test('ls-remote failure still reports taken when gh says taken', async () => {
  const gh = ghStub({ issue: { assignees: [{ login: 'colleague' }], body: '' } });
  const r = await run({ branch: 'feature/27-x', gh, git: gitStub({ remote: bad() }) });
  assert.equal(r.verdict, 'taken');
  assert.equal(r.remoteBranch.exists, null);
});

test('git runner that throws counts as a failed command: unknown, never free', async () => {
  const git = () => { throw new Error('git not found'); };
  const r = await run({ branch: 'feature/27-x', gh: ghStub(), git });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /git not found/);
  assert.equal(r.remoteBranch.exists, null);
});

test('branch exists but authors cannot be read (fetch fails): not free, unknown', async () => {
  const git = gitStub({ remote: 'abc\trefs/heads/feature/27-x\n', fetch: bad('denied') });
  const r = await run({ branch: 'feature/27-x', gh: ghStub(), git });
  assert.equal(r.remoteBranch.exists, true);
  assert.deepEqual(r.remoteBranch.authors, []);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /fetch/);
});

test('git log failing after a successful ls-remote and fetch: unknown', async () => {
  const git = gitStub({ remote: 'abc\trefs/heads/feature/27-x\n', log: bad('bad revision') });
  const r = await run({ branch: 'feature/27-x', gh: ghStub(), git });
  assert.equal(r.remoteBranch.exists, true);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /git log/);
});

test('remote branch with mixed mine and others commits: taken, both listed as authors', async () => {
  const git = gitStub({ remote: 'abc\trefs/heads/feature/27-x\n', log: 'Me Dev|me@x.io\nOther Person|o@x.io\n' });
  const r = await run({ branch: 'feature/27-x', gh: ghStub(), git });
  assert.equal(r.verdict, 'taken');
  assert.deepEqual(r.remoteBranch.authors, ['Me Dev', 'Other Person']);
});

test('invalid issue number: unknown, no throw', async () => {
  const r = await checkCollision({ issue: 'abc', cwd: here, config, gh: ghStub(), git: gitStub() });
  assert.equal(r.verdict, 'unknown');
  assert.ok(r.reason);
});

test('CLI: prints JSON with the full shape and exits 0 even without a usable gh', () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'nd-nogh-'));
  const env = { PATH: empty, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
  let res;
  try {
    res = spawnSync(process.execPath, [cli, '27', '--branch', 'feature/27-x'], { cwd: here, env, encoding: 'utf8' });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.verdict, 'unknown');
  assert.match(out.reason, /gh/);
  for (const k of ['me', 'assignees', 'otherAssignees', 'openPRs', 'remoteBranch', 'verdict', 'reason']) assert.ok(k in out, k);
  assert.deepEqual(Object.keys(out.remoteBranch).sort(), ['authors', 'exists', 'name']);
});

test('CLI: missing issue argument still prints JSON and exits 0', () => {
  const res = spawnSync(process.execPath, [cli], { cwd: here, encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).verdict, 'unknown');
});

test('issueData given: gh issue view is not called and the data is used', async () => {
  const gh = ghStub({ issue: bad('should not be asked') });
  const r = await run({ gh, git: gitStub(), issueData: { assignees: [{ login: 'other-dev' }], body: 'Branch: `feature/27-x`' } });
  assert.equal(r.verdict, 'taken');
  assert.equal(r.remoteBranch.name, 'feature/27-x');
  assert.equal(gh.calls.filter((a) => a[0] === 'issue').length, 0);
});
