import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCollision, branchHasIssue } from '../scripts/task/collision.mjs';

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
  assert.deepEqual(r.openPRs, [{ number: 5, author: 'colleague', head: 'whatever', why: 'mention' }]);
  assert.match(r.reason, /#5/);
  const search = gh.calls.find((a) => a.includes('--search'));
  assert.ok(search.includes('--state') && search.includes('open'));
  assert.ok(search.some((a) => a.includes('27 in:title,body')));
});

test('a PR mentioning #270 (or x#27) is not a match', async () => {
  const prs = [pr({ title: 'Fix #270', body: 'see #2700 and foo#27', headRefName: 'whatever' })];
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
  assert.deepEqual(r.openPRs, [{ number: 5, author: 'colleague', head: 'feature/27-x', why: 'head' }]);
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

test('no branch in arg or body: pattern with ${slug} gives no exact-branch check, only the one full listing', async () => {
  const git = gitStub({ remote: 'abc\trefs/heads/feature/27-\n' });
  const r = await run({ gh: ghStub(), git });
  assert.equal(r.remoteBranch.name, null);
  assert.equal(r.remoteBranch.exists, false);
  assert.deepEqual(git.calls.filter((a) => a[0] === 'ls-remote'), [['ls-remote', '--heads', 'origin']]);
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

// ---- 0.2.4: linked pull requests and branch-named pull requests / remote branches ----

/** gh stub that tells the three PR queries apart: `all` = the plain open list, `search`, `head`. */
function ghThree({ all = [], search = [], head = [], me = 'me-dev', issue = { assignees: [], body: '' } } = {}) {
  const calls = [];
  const answer = (v) => (Array.isArray(v) ? j(v) : v);
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api') return ok(`${me}\n`);
    if (args[0] === 'issue') return j(issue);
    if (args.includes('--head')) return answer(head);
    if (args.includes('--search')) return answer(search);
    return answer(all);
  };
  gh.calls = calls;
  return gh;
}
const n34 = (opts) => checkCollision({ issue: 34, cwd: here, config, ...opts });
const pr34 = (over) => ({ number: 341, author: { login: 'colleague' }, headRefName: 'unrelated', title: 'Quiet work', body: '', closingIssuesReferences: [], ...over });

test('branchHasIssue: whole-token rule, dotted versions and longer numbers excluded', () => {
  for (const b of ['fix/34-x', '34-x', 'feature/34', 'bug_34_y', 'a.34.b', 'fix/34', 'x-34']) assert.equal(branchHasIssue(b, 34), true, b);
  for (const b of ['fix/340-x', 'fix/134-x', 'release/1.34.0', '34.2-x', 'v1.34', 'issue34', '', null]) assert.equal(branchHasIssue(b, 34), false, String(b));
});

test('the plain open-PR list query is made with the closing references and a limit of 200', async () => {
  const gh = ghThree();
  await n34({ gh, git: gitStub() });
  const all = gh.calls.find((a) => a[0] === 'pr' && !a.includes('--search') && !a.includes('--head'));
  assert.deepEqual(all, ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,author,headRefName,title,body,closingIssuesReferences']);
  assert.ok(gh.calls.some((a) => a.includes('--search')), 'the search query is kept');
});

test('taken: a PR linked to the issue only through closingIssuesReferences (why linked)', async () => {
  const gh = ghThree({ all: [pr34({ number: 56, closingIssuesReferences: [{ number: 34 }] })] });
  const r = await n34({ gh, git: gitStub() });
  assert.equal(r.verdict, 'taken');
  assert.deepEqual(r.openPRs, [{ number: 56, author: 'colleague', head: 'unrelated', why: 'linked' }]);
  assert.match(r.reason, /#56 by colleague \(linked\)/);
});

test('taken: a PR whose head branch is fix/34-x and says nothing else (why branch)', async () => {
  const gh = ghThree({ all: [pr34({ headRefName: 'fix/34-consistent-error-formatting' })] });
  const r = await n34({ gh, git: gitStub() });
  assert.equal(r.verdict, 'taken');
  assert.equal(r.openPRs[0].why, 'branch');
  assert.match(r.reason, /\(branch\)/);
});

test('PRs on fix/340-x and release/1.34.0 are not matched', async () => {
  const gh = ghThree({ all: [pr34({ number: 1, headRefName: 'fix/340-x' }), pr34({ number: 2, headRefName: 'release/1.34.0' })] });
  const r = await n34({ gh, git: gitStub() });
  assert.equal(r.verdict, 'free');
  assert.deepEqual(r.openPRs, []);
});

test('taken: a URL ending /issues/34 in the body (why url); /issues/340 does not match', async () => {
  const hit = await n34({ gh: ghThree({ all: [pr34({ body: 'Fixes https://github.com/o/r/issues/34' })] }), git: gitStub() });
  assert.equal(hit.verdict, 'taken');
  assert.equal(hit.openPRs[0].why, 'url');
  const miss = await n34({ gh: ghThree({ all: [pr34({ body: 'see https://github.com/o/r/issues/340' })] }), git: gitStub() });
  assert.equal(miss.verdict, 'free');
});

test('why: #34 in the title is a mention; the exact --head match is head', async () => {
  const m = await n34({ gh: ghThree({ all: [pr34({ title: 'Fix #34' })] }), git: gitStub() });
  assert.equal(m.openPRs[0].why, 'mention');
  const h = await n34({ branch: 'work/foo', gh: ghThree({ head: [pr34({ headRefName: 'work/foo' })] }), git: gitStub() });
  assert.equal(h.openPRs[0].why, 'head');
  assert.equal(h.verdict, 'taken');
});

test('ours: my own PR linked only through closingIssuesReferences', async () => {
  const gh = ghThree({ all: [pr34({ author: { login: 'ME-dev' }, closingIssuesReferences: [{ number: 34 }] })] });
  const r = await n34({ gh, git: gitStub() });
  assert.equal(r.verdict, 'ours');
  assert.equal(r.openPRs[0].why, 'linked');
});

test('the same PR returned by all three queries is listed once', async () => {
  const same = pr34({ number: 7, title: 'Closes #34', headRefName: 'fix/34-x', closingIssuesReferences: [{ number: 34 }] });
  const r = await n34({ branch: 'fix/34-x', gh: ghThree({ all: [same], search: [same], head: [same] }), git: gitStub() });
  assert.equal(r.openPRs.length, 1);
  assert.equal(r.openPRs[0].why, 'linked');
});

test('a PR the search returns without closing references still gets them from the list query', async () => {
  const bare = { number: 9, author: { login: 'colleague' }, headRefName: 'z', title: 'Search hit', body: '' };
  const r = await n34({ gh: ghThree({ search: [bare], all: [{ ...bare, closingIssuesReferences: [{ number: 34 }] }] }), git: gitStub() });
  assert.deepEqual(r.openPRs, [{ number: 9, author: 'colleague', head: 'z', why: 'linked' }]);
});

test('the plain list query failing: unknown, whatever the other queries say', async () => {
  const gh = ghThree({ all: bad('rate limited'), search: [] });
  const r = await n34({ gh, git: gitStub() });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /gh pr list/);
  assert.match(r.reason, /rate limited/);
});

test('a full page of 200 open PRs with no match is unknown, not free (the list may be cut off)', async () => {
  const many = Array.from({ length: 200 }, (_, i) => pr34({ number: 1000 + i, headRefName: `other/x${i}` }));
  const r = await n34({ gh: ghThree({ all: many }), git: gitStub() });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /200/);
  const some = await n34({ gh: ghThree({ all: [...many.slice(1), pr34({ number: 5, headRefName: 'fix/34-x' })] }), git: gitStub() });
  assert.equal(some.verdict, 'taken', 'a match still wins');
});

test('taken: remote branch feature/34-y by another author, no PR, no known branch name', async () => {
  const git = gitStub({ remote: 'a1\trefs/heads/feature/34-y\nb2\trefs/heads/feature/340-z\nc3\trefs/heads/main\n', log: 'Other Person|o@x.io\n' });
  const r = await n34({ gh: ghThree(), git });
  assert.equal(r.verdict, 'taken');
  assert.deepEqual(r.remoteBranches, [{ name: 'feature/34-y', authors: ['Other Person'] }]);
  assert.equal(r.remoteBranch.name, null);
  assert.match(r.reason, /feature\/34-y/);
  assert.match(r.reason, /Other Person/);
  assert.deepEqual(git.calls.filter((a) => a[0] === 'ls-remote'), [['ls-remote', '--heads', 'origin']]);
  assert.deepEqual(git.calls.filter((a) => a[0] === 'fetch'), [['fetch', 'origin', 'feature/34-y']], 'only the matching branch is fetched');
  assert.deepEqual(git.calls.find((a) => a[0] === 'log'), ['log', 'origin/feature/34-y', '--not', 'origin/main', '--format=%an|%ae']);
});

test('a token-matching remote branch with only my commits is ours; with no commits beyond base it is free', async () => {
  const mine = await n34({ gh: ghThree(), git: gitStub({ remote: 'a\trefs/heads/fix/34-x\n', log: 'Me Dev|me@x.io\n' }) });
  assert.equal(mine.verdict, 'ours');
  assert.deepEqual(mine.remoteBranches, [{ name: 'fix/34-x', authors: ['Me Dev'] }]);
  const empty = await n34({ gh: ghThree(), git: gitStub({ remote: 'a\trefs/heads/fix/34-x\n', log: '' }) });
  assert.equal(empty.verdict, 'free');
  assert.deepEqual(empty.remoteBranches, [{ name: 'fix/34-x', authors: [] }]);
});

test('a token-matching remote branch whose authors cannot be read: unknown', async () => {
  const r = await n34({ gh: ghThree(), git: gitStub({ remote: 'a\trefs/heads/fix/34-x\n', fetch: bad('denied') }) });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /fix\/34-x/);
  assert.match(r.reason, /fetch/);
});

test('git ls-remote --heads origin failing with nothing else found: unknown, never free', async () => {
  const r = await n34({ gh: ghThree(), git: gitStub({ remote: bad('network down') }) });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /ls-remote/);
  assert.match(r.reason, /network down/);
});

test('more than 5 token-matching remote branches: only 5 are read, the rest make it unknown, not free', async () => {
  const remote = Array.from({ length: 7 }, (_, i) => `s${i}\trefs/heads/fix/34-v${i}\n`).join('');
  const git = gitStub({ remote, log: '' });
  const r = await n34({ gh: ghThree(), git });
  assert.equal(git.calls.filter((a) => a[0] === 'fetch').length, 5);
  assert.equal(r.remoteBranches.length, 5);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /2 more/);
});

test('the exact branch is not repeated in remoteBranches; other token branches still count next to it', async () => {
  const git = gitStub({ remote: 'a\trefs/heads/feature/34-x\nb\trefs/heads/fix/34-y\n', log: 'Other Person|o@x.io\n' });
  const r = await n34({ branch: 'feature/34-x', gh: ghThree(), git });
  assert.equal(r.remoteBranch.name, 'feature/34-x');
  assert.deepEqual(r.remoteBranches.map((b) => b.name), ['fix/34-y']);
  assert.equal(r.verdict, 'taken');
});

test('the result has remoteBranches on every path, including invalid input', async () => {
  const bad1 = await checkCollision({ issue: 'abc', cwd: here, config, gh: ghStub(), git: gitStub() });
  assert.deepEqual(bad1.remoteBranches, []);
  const free = await n34({ gh: ghThree(), git: gitStub() });
  assert.deepEqual(free.remoteBranches, []);
});

test('ours but a branch could not be read: unknown, not ours', async () => {
  const gh = ghThree({ all: [pr34({ author: { login: 'me-dev' }, closingIssuesReferences: [{ number: 34 }] })] });
  const r = await n34({ gh, git: gitStub({ remote: 'a\trefs/heads/fix/34-x\n', fetch: bad('denied') }) });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /your open PR #341/);
  assert.match(r.reason, /fix\/34-x/);
  const clean = await n34({ gh, git: gitStub() });
  assert.equal(clean.verdict, 'ours', 'with nothing unverified it stays ours');
});

test('a remote branch named like an option is never passed to git fetch or log; the verdict is unknown', async () => {
  const git = gitStub({ remote: 'a\trefs/heads/--upload-pack=x-34\nb\trefs/heads/fix/34-ok\n', log: '' });
  const r = await n34({ gh: ghThree(), git });
  assert.equal(git.calls.some((a) => a.some((x) => x.includes('upload-pack') && a[0] !== 'ls-remote')), false);
  assert.deepEqual(git.calls.filter((a) => a[0] === 'fetch'), [['fetch', 'origin', 'fix/34-ok']], 'the ordinary branch is still read');
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /--upload-pack=x-34/);
});

test('an exact branch name starting with "-" (from --branch or the issue body) is not passed to git either', async () => {
  const git = gitStub({ remote: 'a\trefs/heads/x\n' });
  const r = await n34({ branch: '--upload-pack=evil', gh: ghThree(), git });
  assert.equal(git.calls.length, 0);
  assert.equal(r.remoteBranch.exists, null);
  assert.equal(r.verdict, 'unknown');
});
