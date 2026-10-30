#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isMain } from '../lib/main.mjs';
import { loadConfig } from '../lib/config.mjs';

const TIMEOUT_MS = 30000;
const BRANCH_IN_BODY = /Branch:\s*`([^`]+)`/;

/** Default runner for `cmd`: never throws, returns { code, stdout, stderr } (code null when it could not run). */
function spawnRunner(cmd, prefix, cwd) {
  return (args) => {
    const r = spawnSync(cmd, [...prefix, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (r.error) return { code: null, stdout: '', stderr: r.error.message };
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/** Run a runner so that a throw, a null/odd result or a non-zero exit all come back as { ok: false, why }. */
function attempt(runner, args) {
  let r;
  try {
    r = runner(args);
  } catch (e) {
    return { ok: false, stdout: '', why: String(e?.message ?? e) };
  }
  if (!r || r.code !== 0) {
    const why = String(r?.stderr ?? '').trim().split(/\r?\n/)[0] || (r ? `exit ${r.code}` : 'no result');
    return { ok: false, stdout: '', why };
  }
  return { ok: true, stdout: String(r.stdout ?? ''), why: '' };
}

const lower = (s) => String(s ?? '').trim().toLowerCase();
const refersTo = (text, issue) => new RegExp(`(?<![\\w#])#${issue}(?!\\d)`).test(String(text ?? ''));
const list = (items) => items.join(', ');

function unknown(partial, command, why) {
  return { ...partial, verdict: 'unknown', reason: `unknown: \`${command}\` failed (${why}); cannot tell whether the issue is taken` };
}

/**
 * Decide whether issue `issue` is already owned by someone else.
 * `gh(args)` / `git(args)` are runners returning { code, stdout, stderr }; the defaults spawn the real CLIs
 * (git with `-C cwd`). Never throws: any gh failure yields verdict "unknown" with a reason.
 */
export async function checkCollision({ issue, branch, cwd = process.cwd(), config, gh, git } = {}) {
  const result = {
    me: null,
    assignees: [],
    otherAssignees: [],
    openPRs: [],
    remoteBranch: { name: null, exists: false, authors: [] },
    verdict: 'unknown',
    reason: '',
  };
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) {
    return { ...result, reason: `unknown: "${issue ?? ''}" is not a valid issue number` };
  }
  const cfg = config ?? loadConfig(cwd).config;
  const base = cfg?.branch?.base || 'main';
  const pattern = cfg?.branch?.pattern || 'feature/${issue}-${slug}';
  const runGh = gh ?? spawnRunner('gh', [], cwd);
  const runGit = git ?? spawnRunner('git', ['-C', cwd], cwd);

  const meRes = attempt(runGh, ['api', 'user', '--jq', '.login']);
  if (!meRes.ok) return unknown(result, 'gh api user', meRes.why);
  const me = meRes.stdout.trim();
  result.me = me;

  const issueCmd = ['issue', 'view', String(n), '--json', 'assignees,body'];
  const issueRes = attempt(runGh, issueCmd);
  if (!issueRes.ok) return unknown(result, `gh ${issueCmd.slice(0, 3).join(' ')}`, issueRes.why);
  let issueData;
  try {
    issueData = JSON.parse(issueRes.stdout);
  } catch {
    return unknown(result, `gh ${issueCmd.slice(0, 3).join(' ')}`, 'unparsable JSON');
  }
  result.assignees = (issueData.assignees ?? []).map((a) => a.login).filter(Boolean);
  result.otherAssignees = result.assignees.filter((a) => lower(a) !== lower(me));

  // Branch: argument, else the body's "Branch: `x`", else the pattern (only when it has no ${slug} to guess).
  let branchName = branch || (BRANCH_IN_BODY.exec(issueData.body ?? '') ?? [])[1] || null;
  if (!branchName && !pattern.includes('${slug}')) branchName = pattern.replaceAll('${issue}', String(n));
  result.remoteBranch.name = branchName;

  const PR_FIELDS = 'number,author,headRefName,title,body';
  /** One `gh pr list` query -> { prs } or { fail }. */
  const queryPRs = (extra, label) => {
    const res = attempt(runGh, ['pr', 'list', '--state', 'open', ...extra, '--json', PR_FIELDS, '--limit', '100']);
    if (!res.ok) return { fail: unknown(result, label, res.why) };
    try {
      const data = JSON.parse(res.stdout);
      if (!Array.isArray(data)) throw new Error('not an array');
      return { prs: data };
    } catch {
      return { fail: unknown(result, label, 'unparsable JSON') };
    }
  };
  // Search does not cover head ref names, so a PR from the issue's branch is looked up by --head as well.
  const searched = queryPRs(['--search', `${n} in:title,body`], 'gh pr list');
  if (searched.fail) return searched.fail;
  const byHead = branchName ? queryPRs(['--head', branchName], 'gh pr list --head') : { prs: [] };
  if (byHead.fail) return byHead.fail;
  const found = new Map();
  for (const p of searched.prs) {
    if (refersTo(p.title, n) || refersTo(p.body, n) || (branchName && p.headRefName === branchName)) found.set(p.number, p);
  }
  for (const p of byHead.prs) found.set(p.number, p);
  result.openPRs = [...found.values()]
    .map((p) => ({ number: p.number, author: p.author?.login ?? null, head: p.headRefName ?? null }));
  const theirPRs = result.openPRs.filter((p) => lower(p.author) !== lower(me));
  const myPRs = result.openPRs.filter((p) => lower(p.author) === lower(me));

  // Remote branch (best effort: a git failure never overrides what gh established).
  const notes = [];
  let otherAuthors = [];
  let myCommits = false;
  let authorsKnown = true;
  if (branchName) {
    const ls = attempt(runGit, ['ls-remote', '--heads', 'origin', branchName]);
    if (!ls.ok) {
      result.remoteBranch.exists = null;
      notes.push(`could not check the remote branch (git ls-remote failed: ${ls.why})`);
    } else if (ls.stdout.trim() === '') {
      result.remoteBranch.exists = false;
    } else {
      result.remoteBranch.exists = true;
      const name = attempt(runGit, ['config', 'user.name']);
      const email = attempt(runGit, ['config', 'user.email']);
      const myName = lower(name.ok ? name.stdout : '');
      const myEmail = lower(email.ok ? email.stdout : '');
      const fetched = attempt(runGit, ['fetch', 'origin', branchName]);
      const log = fetched.ok ? attempt(runGit, ['log', `origin/${branchName}`, '--not', `origin/${base}`, '--format=%an|%ae']) : null;
      if (!fetched.ok) {
        authorsKnown = false;
        notes.push(`could not read the authors of ${branchName} (git fetch failed: ${fetched.why})`);
      } else if (!log.ok) {
        authorsKnown = false;
        notes.push(`could not read the authors of ${branchName} (git log failed: ${log.why})`);
      } else if (!myName && !myEmail) {
        authorsKnown = false;
        notes.push(`could not read the authors of ${branchName} (git user.name and user.email are not set)`);
      } else {
        const names = new Set();
        const others = new Set();
        for (const line of log.stdout.split(/\r?\n/).filter(Boolean)) {
          const cut = line.lastIndexOf('|');
          const an = cut < 0 ? line : line.slice(0, cut);
          const ae = cut < 0 ? '' : line.slice(cut + 1);
          names.add(an);
          if ((myName && lower(an) === myName) || (myEmail && lower(ae) === myEmail)) myCommits = true;
          else others.add(an);
        }
        result.remoteBranch.authors = [...names];
        otherAuthors = [...others];
      }
    }
  }

  const taken = [];
  if (result.otherAssignees.length) taken.push(`assigned to ${list(result.otherAssignees)}`);
  if (theirPRs.length) taken.push(`open PR ${list(theirPRs.map((p) => `#${p.number} by ${p.author}`))}`);
  if (otherAuthors.length) taken.push(`remote branch ${branchName} has commits by ${list(otherAuthors)}`);
  const ours = [];
  if (myPRs.length) ours.push(`your open PR ${list(myPRs.map((p) => `#${p.number}`))}`);
  if (myCommits && !otherAuthors.length) ours.push(`remote branch ${branchName} has your commits`);
  const tail = notes.length ? `; ${notes.join('; ')}` : '';

  if (taken.length) {
    result.verdict = 'taken';
    result.reason = `taken: ${taken.join('; ')}${tail}`;
  } else if (ours.length) {
    result.verdict = 'ours';
    result.reason = `ours: ${ours.join('; ')}${tail}`;
  } else if (result.remoteBranch.exists === true && !authorsKnown) {
    result.verdict = 'unknown';
    result.reason = `unknown: remote branch ${branchName} exists but its authors are unverified${tail}`;
  } else {
    result.verdict = 'free';
    const seen = result.remoteBranch.exists === true
      ? `remote branch ${branchName} has no commits of its own`
      : result.remoteBranch.exists === null ? notes[0] : 'no remote branch';
    result.reason = `free: no other assignee, no open PR, ${seen}`;
  }
  return result;
}

function parseArgs(argv) {
  const opts = { issue: undefined, branch: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--branch') opts.branch = inline !== undefined ? inline : argv[++i];
    else rest.push(argv[i]);
  }
  opts.issue = rest[0]?.replace(/^#/, '');
  return opts;
}

if (isMain(import.meta.url)) {
  const { issue, branch } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  let out;
  try {
    out = await checkCollision({ issue, branch, cwd });
  } catch (e) {
    out = {
      me: null, assignees: [], otherAssignees: [], openPRs: [],
      remoteBranch: { name: null, exists: false, authors: [] },
      verdict: 'unknown', reason: `unknown: collision check crashed (${e.message})`,
    };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
