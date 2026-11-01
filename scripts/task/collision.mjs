#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isMain } from '../lib/main.mjs';
import { loadConfig } from '../lib/config.mjs';
import { findProjectRoot } from '../lib/root.mjs';

const TIMEOUT_MS = 30000;
const BRANCH_IN_BODY = /Branch:\s*`([^`]+)`/;

/** Default runner for `cmd`: never throws, returns { code, stdout, stderr } (code null when it could not run). */
export function spawnRunner(cmd, prefix, cwd) {
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

const MAX_LIST = 200; // the plain open-PR list; a full page may be cut off
const MAX_OTHER_BRANCHES = 5; // token-matching remote branches whose authors are read

const lower = (s) => String(s ?? '').trim().toLowerCase();
const refersTo = (text, issue) => new RegExp(`(?<![\\w#])#${issue}(?!\\d)`).test(String(text ?? ''));
const urlTo = (text, issue) => new RegExp(`/issues/${issue}\\b`).test(String(text ?? ''));
const list = (items) => items.join(', ');
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';
const isSep = (c) => c === undefined || c === '' || '/_.-'.includes(c);

/**
 * Does branch name `branch` carry issue number `issue` as a whole token? The digits must sit between
 * separators (`/ _ . -`) or the ends of the name: `fix/34-x`, `34-x`, `feature/34`, `bug_34_y` match;
 * `fix/340-x` and `issue34` do not. A number that is part of a dotted version (`release/1.34.0`, `34.2-x`)
 * is not a match. Where this is ambiguous it is meant to over-match (a false positive makes start-task
 * ask the owner; a false negative would say "free" about work someone else started).
 */
export function branchHasIssue(branch, issue) {
  const s = String(branch ?? '');
  const num = String(issue);
  for (let i = s.indexOf(num); i >= 0; i = s.indexOf(num, i + 1)) {
    const end = i + num.length;
    const prev = s[i - 1];
    const next = s[end];
    if (isDigit(prev) || isDigit(next)) continue;
    if (!isSep(prev) || !isSep(next)) continue;
    if (prev === '.' && isDigit(s[i - 2])) continue;
    if (next === '.' && isDigit(s[end + 1])) continue;
    return true;
  }
  return false;
}

function unknown(partial, command, why) {
  return { ...partial, verdict: 'unknown', reason: `unknown: \`${command}\` failed (${why}); cannot tell whether the issue is taken` };
}

/**
 * Decide whether issue `issue` is already owned by someone else.
 * `gh(args)` / `git(args)` are runners returning { code, stdout, stderr }; the defaults spawn the real CLIs
 * (git with `-C cwd`). Never throws: any gh failure yields verdict "unknown" with a reason.
 * `issueData` is an already-fetched `gh issue view --json ...assignees,body` object; when present the
 * issue is not fetched again (preflight shares one call). Absent: the issue is fetched here.
 */
export async function checkCollision({ issue, branch, cwd = process.cwd(), config, gh, git, issueData: given } = {}) {
  const result = {
    me: null,
    assignees: [],
    otherAssignees: [],
    openPRs: [],
    remoteBranch: { name: null, exists: false, authors: [] },
    remoteBranches: [],
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

  let issueData = given && typeof given === 'object' ? given : null;
  if (!issueData) {
    const issueCmd = ['issue', 'view', String(n), '--json', 'assignees,body'];
    const issueRes = attempt(runGh, issueCmd);
    if (!issueRes.ok) return unknown(result, `gh ${issueCmd.slice(0, 3).join(' ')}`, issueRes.why);
    try {
      issueData = JSON.parse(issueRes.stdout);
    } catch {
      return unknown(result, `gh ${issueCmd.slice(0, 3).join(' ')}`, 'unparsable JSON');
    }
  }
  result.assignees = (issueData.assignees ?? []).map((a) => a.login).filter(Boolean);
  result.otherAssignees = result.assignees.filter((a) => lower(a) !== lower(me));

  // Branch: argument, else the body's "Branch: `x`", else the pattern (only when it has no ${slug} to guess).
  let branchName = branch || (BRANCH_IN_BODY.exec(issueData.body ?? '') ?? [])[1] || null;
  if (!branchName && !pattern.includes('${slug}')) branchName = pattern.replaceAll('${issue}', String(n));
  result.remoteBranch.name = branchName;

  const PR_FIELDS = 'number,author,headRefName,title,body';
  /** One `gh pr list` query -> { prs } or { fail }. `tail` is everything after `--state open`. */
  const queryPRs = (tail, label) => {
    const res = attempt(runGh, ['pr', 'list', '--state', 'open', ...tail]);
    if (!res.ok) return { fail: unknown(result, label, res.why) };
    try {
      const data = JSON.parse(res.stdout);
      if (!Array.isArray(data)) throw new Error('not an array');
      return { prs: data.filter((p) => p && typeof p === 'object') };
    } catch {
      return { fail: unknown(result, label, 'unparsable JSON') };
    }
  };
  // Three views of the open PRs, merged by number. The plain list carries `closingIssuesReferences` (a PR
  // linked to the issue need not name it anywhere) and head branch names; search finds #n mentions beyond the
  // list's limit; --head finds a PR from the issue's own branch.
  const listed = queryPRs(['--limit', String(MAX_LIST), '--json', `${PR_FIELDS},closingIssuesReferences`], 'gh pr list');
  if (listed.fail) return listed.fail;
  const searched = queryPRs(['--search', `${n} in:title,body`, '--json', PR_FIELDS, '--limit', '100'], 'gh pr list --search');
  if (searched.fail) return searched.fail;
  const byHead = branchName
    ? queryPRs(['--head', branchName, '--json', PR_FIELDS, '--limit', '100'], 'gh pr list --head')
    : { prs: [] };
  if (byHead.fail) return byHead.fail;
  const merged = new Map(); // number -> { pr, viaHead }
  const merge = (prs, viaHead) => {
    for (const p of prs) {
      const prev = merged.get(p.number);
      merged.set(p.number, { pr: { ...prev?.pr, ...p }, viaHead: viaHead || prev?.viaHead === true });
    }
  };
  merge(listed.prs, false);
  merge(searched.prs, false);
  merge(byHead.prs, true);
  /** Which rule ties this PR to issue n: linked | mention | url | head | branch, or null. */
  const whyReferred = ({ pr: p, viaHead }) => {
    const refs = Array.isArray(p.closingIssuesReferences) ? p.closingIssuesReferences : [];
    if (refs.some((r) => Number(r !== null && typeof r === 'object' ? r.number : r) === n)) return 'linked';
    if (refersTo(p.title, n) || refersTo(p.body, n)) return 'mention';
    if (urlTo(p.title, n) || urlTo(p.body, n)) return 'url';
    if (viaHead || (branchName && p.headRefName === branchName)) return 'head';
    if (branchHasIssue(p.headRefName, n)) return 'branch';
    return null;
  };
  for (const entry of merged.values()) {
    const why = whyReferred(entry);
    if (why) result.openPRs.push({ number: entry.pr.number, author: entry.pr.author?.login ?? null, head: entry.pr.headRefName ?? null, why });
  }
  const theirPRs = result.openPRs.filter((p) => lower(p.author) !== lower(me));
  const myPRs = result.openPRs.filter((p) => lower(p.author) === lower(me));
  const notes = [];
  // A full page may have been cut off: with no match in it, "no open PR" is not established.
  const listCut = listed.prs.length >= MAX_LIST;
  if (listCut) notes.push(`the open PR list is ${MAX_LIST} long and may be cut off, so PRs beyond it were not checked`);

  // Remote branches: a git failure never overrides a taken or ours that gh established, but it turns
  // "free" into "unknown" (a branch may hold someone's work). Every unverified thing adds a note.
  let identity; // me as git knows me; read once, and only when a branch's authors have to be read
  const whoAmI = () => {
    if (!identity) {
      const name = attempt(runGit, ['config', 'user.name']);
      const email = attempt(runGit, ['config', 'user.email']);
      identity = { name: lower(name.ok ? name.stdout : ''), email: lower(email.ok ? email.stdout : '') };
    }
    return identity;
  };
  /** Who committed to origin/<name> beyond origin/<base>: { known, why, names, others, mine }. */
  const readAuthors = (name) => {
    const me2 = whoAmI();
    const out = { known: false, why: '', names: [], others: [], mine: false };
    // A name that starts with "-" would be read by git as an option (--upload-pack=...): never pass it on.
    if (name.startsWith('-')) return { ...out, why: 'the branch name starts with "-" and was not passed to git' };
    const fetched = attempt(runGit, ['fetch', 'origin', name]);
    if (!fetched.ok) return { ...out, why: `git fetch failed: ${fetched.why}` };
    const log = attempt(runGit, ['log', `origin/${name}`, '--not', `origin/${base}`, '--format=%an|%ae']);
    if (!log.ok) return { ...out, why: `git log failed: ${log.why}` };
    if (!me2.name && !me2.email) return { ...out, why: 'git user.name and user.email are not set' };
    const names = new Set();
    const others = new Set();
    for (const line of log.stdout.split(/\r?\n/).filter(Boolean)) {
      const cut = line.lastIndexOf('|');
      const an = cut < 0 ? line : line.slice(0, cut);
      const ae = cut < 0 ? '' : line.slice(cut + 1);
      names.add(an);
      if ((me2.name && lower(an) === me2.name) || (me2.email && lower(ae) === me2.email)) out.mine = true;
      else others.add(an);
    }
    return { ...out, known: true, names: [...names], others: [...others] };
  };

  // The exact branch (argument, issue body or pattern).
  let otherAuthors = [];
  let myCommits = false;
  if (branchName && branchName.startsWith('-')) {
    result.remoteBranch.exists = null;
    notes.push(`could not check the remote branch (the name ${branchName} starts with "-" and was not passed to git)`);
  } else if (branchName) {
    const ls = attempt(runGit, ['ls-remote', '--heads', 'origin', branchName]);
    if (!ls.ok) {
      result.remoteBranch.exists = null;
      notes.push(`could not check the remote branch (git ls-remote failed: ${ls.why})`);
    } else if (ls.stdout.trim() === '') {
      result.remoteBranch.exists = false;
    } else {
      result.remoteBranch.exists = true;
      const a = readAuthors(branchName);
      if (!a.known) {
        notes.push(`could not read the authors of ${branchName} (${a.why})`);
      } else {
        result.remoteBranch.authors = a.names;
        otherAuthors = a.others;
        myCommits = a.mine;
      }
    }
  }

  // Every other remote branch with the issue number in its name (someone may have pushed work under a
  // name this plugin did not predict). One listing; at most MAX_OTHER_BRANCHES are read.
  const branchTaken = []; // "remote branch X has commits by A, B"
  const branchMine = [];
  if (result.remoteBranch.exists !== null) { // the exact check already found git unreachable
    const all = attempt(runGit, ['ls-remote', '--heads', 'origin']);
    if (!all.ok) {
      notes.push(`could not list the remote branches (git ls-remote --heads origin failed: ${all.why})`);
    } else {
      const names = [];
      for (const line of all.stdout.split(/\r?\n/)) {
        const m = /^\S+\s+refs\/heads\/(.+?)\s*$/.exec(line);
        if (m && m[1] !== branchName && branchHasIssue(m[1], n) && !names.includes(m[1])) names.push(m[1]);
      }
      for (const name of names.slice(0, MAX_OTHER_BRANCHES)) {
        const a = readAuthors(name);
        result.remoteBranches.push({ name, authors: a.names });
        if (!a.known) notes.push(`could not read the authors of ${name} (${a.why})`);
        else if (a.others.length) branchTaken.push(`remote branch ${name} has commits by ${list(a.others)}`);
        else if (a.mine) branchMine.push(`remote branch ${name} has your commits`);
      }
      const skipped = names.length - MAX_OTHER_BRANCHES;
      if (skipped > 0) notes.push(`${skipped} more remote branches carry #${n} in their name and were not read`);
    }
  }

  const taken = [];
  if (result.otherAssignees.length) taken.push(`assigned to ${list(result.otherAssignees)}`);
  if (theirPRs.length) taken.push(`open PR ${list(theirPRs.map((p) => `#${p.number} by ${p.author} (${p.why})`))}`);
  if (otherAuthors.length) taken.push(`remote branch ${branchName} has commits by ${list(otherAuthors)}`);
  taken.push(...branchTaken);
  const ours = [];
  if (myPRs.length) ours.push(`your open PR ${list(myPRs.map((p) => `#${p.number} (${p.why})`))}`);
  if (myCommits && !otherAuthors.length) ours.push(`remote branch ${branchName} has your commits`);
  ours.push(...branchMine);
  const tail = notes.length ? `; ${notes.join('; ')}` : '';

  if (taken.length) {
    result.verdict = 'taken';
    result.reason = `taken: ${taken.join('; ')}${tail}`;
  } else if (ours.length && notes.length) {
    // mine, but a branch or list could not be read: someone else may hold part of it, so ask rather than go on.
    result.verdict = 'unknown';
    result.reason = `unknown: ${ours.join('; ')}, but ${notes.join('; ')}`;
  } else if (ours.length) {
    result.verdict = 'ours';
    result.reason = `ours: ${ours.join('; ')}`;
  } else if (notes.length) {
    // gh found no owner, but something unchecked (a branch, a cut-off list) may still hold someone's work: never "free".
    result.verdict = 'unknown';
    result.reason = `unknown: no other assignee and no open PR found, but ${notes.join('; ')}`;
  } else {
    result.verdict = 'free';
    const seen = result.remoteBranch.exists === true ? `remote branch ${branchName} has no commits of its own` : 'no remote branch';
    const others = result.remoteBranches.length ? `, ${result.remoteBranches.length} other remote branch(es) with #${n} in the name have no commits of their own` : '';
    result.reason = `free: no other assignee, no open PR, ${seen}${others}`;
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
  const cwd = findProjectRoot(process.cwd()); // the nearest folder with a nauraiz-dev config, like the gate
  let out;
  try {
    out = await checkCollision({ issue, branch, cwd });
  } catch (e) {
    out = {
      me: null, assignees: [], otherAssignees: [], openPRs: [],
      remoteBranch: { name: null, exists: false, authors: [] }, remoteBranches: [],
      verdict: 'unknown', reason: `unknown: collision check crashed (${e.message})`,
    };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
