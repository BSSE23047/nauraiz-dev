#!/usr/bin/env node
import path from 'node:path';
import { isMain } from '../lib/main.mjs';
import { loadConfig } from '../lib/config.mjs';
import { resolveBase } from '../lib/base.mjs';
import { findProjectRoot } from '../lib/root.mjs';
import { checkCollision, spawnRunner } from './collision.mjs';

const MAX_TEXT = 4000;
const MARK = '…[truncated]';
const ISSUE_FIELDS = 'title,body,labels,state,comments,assignees';

const cut = (v) => {
  const s = String(v ?? '');
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + MARK : s;
};

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

/** The slice of a parsed `gh issue view` the skill reads: body and comments truncated. */
function shapeIssue(n, data) {
  const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  const comments = (data.comments ?? []).map((c) => ({ author: c?.author?.login ?? null, body: cut(c?.body) }));
  return { number: n, title: String(data.title ?? ''), body: cut(data.body), labels, state: String(data.state ?? ''), comments };
}

/** `git fetch origin <base>` once, then how far HEAD is behind (and, if behind, ahead of) origin/<base>. */
function baseStatus(git, cwd, name) {
  const out = { name, ref: name, behind: null, ahead: null, fetched: false, reason: '' };
  const fetched = attempt(git, ['fetch', 'origin', name]);
  if (!fetched.ok) {
    out.reason = `git fetch origin ${name} failed (${fetched.why}); behind-count not checked`;
    return out;
  }
  out.fetched = true;
  const remote = `origin/${name}`;
  const behind = attempt(git, ['rev-list', '--count', `HEAD..${remote}`]);
  const count = Number.parseInt(behind.stdout.trim(), 10);
  if (!behind.ok || !Number.isInteger(count)) {
    out.reason = `could not count commits behind ${remote} (${behind.ok ? 'unreadable output' : behind.why})`;
    return out;
  }
  out.behind = count;
  try {
    out.ref = resolveBase(cwd, name, git);
  } catch { /* keep the name */ }
  if (count === 0) {
    out.reason = `up to date with ${remote}`;
    return out;
  }
  const ahead = attempt(git, ['rev-list', '--count', `${remote}..HEAD`]);
  const own = Number.parseInt(ahead.stdout.trim(), 10);
  if (ahead.ok && Number.isInteger(own)) out.ahead = own;
  out.reason = `${count} commit${count === 1 ? '' : 's'} behind ${remote}`
    + (out.ahead === 0 ? '; the branch has no commits of its own' : '');
  return out;
}

/**
 * Everything start-task needs before it plans, in one result: the issue (null when it cannot be read),
 * the collision verdict (exactly checkCollision's result) and the base-branch status. `gh` and `git` are
 * runners returning { code, stdout, stderr }; the defaults spawn the real CLIs. gh is asked for the issue
 * once and the answer, failure included, is shared with the collision check. Never throws.
 */
export async function preflight({ issue, branch, cwd = process.cwd(), config, gh, git } = {}) {
  const n = Number(String(issue ?? '').replace(/^#/, ''));
  const valid = Number.isInteger(n) && n > 0;
  let cfg = config;
  if (!cfg) {
    try { cfg = loadConfig(cwd).config; } catch { cfg = {}; }
  }
  const baseName = cfg?.branch?.base || 'main';
  const runGh = gh ?? spawnRunner('gh', [], cwd);
  const runGit = git ?? spawnRunner('git', ['-C', cwd], cwd);

  let shared; // the one `gh issue view` result, replayed if the collision check asks again
  const ghOnce = (args) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      if (shared === undefined) {
        try { shared = runGh(args); } catch (e) { shared = { code: null, stdout: '', stderr: String(e?.message ?? e) }; }
      }
      return shared;
    }
    return runGh(args);
  };

  let issueOut = null;
  let issueData;
  if (valid) {
    const res = attempt(ghOnce, ['issue', 'view', String(n), '--json', ISSUE_FIELDS]);
    if (res.ok) {
      try {
        const parsed = JSON.parse(res.stdout);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          issueData = parsed;
          issueOut = shapeIssue(n, parsed);
        }
      } catch { /* unreadable: the collision check reports it */ }
    }
  }

  let collision;
  try {
    collision = await checkCollision({ issue: valid ? n : issue, branch, cwd, config: cfg, gh: ghOnce, git: runGit, issueData });
  } catch (e) {
    collision = {
      me: null, assignees: [], otherAssignees: [], openPRs: [],
      remoteBranch: { name: null, exists: false, authors: [] }, remoteBranches: [],
      verdict: 'unknown', reason: `unknown: collision check crashed (${e?.message ?? e})`,
    };
  }

  let base;
  try {
    base = baseStatus(runGit, cwd, baseName);
  } catch (e) {
    base = { name: baseName, ref: baseName, behind: null, ahead: null, fetched: false, reason: `base check crashed (${e?.message ?? e})` };
  }
  return { issue: issueOut, collision, base };
}

function parseArgs(argv) {
  const opts = { issue: undefined, branch: undefined, cwd: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--branch') opts.branch = value();
    else if (flag === '--cwd') opts.cwd = path.resolve(value() ?? process.cwd());
    else rest.push(argv[i]);
  }
  opts.issue = rest[0]?.replace(/^#/, '');
  return opts;
}

if (isMain(import.meta.url)) {
  let out;
  try {
    const opts = parseArgs(process.argv.slice(2));
    // Without --cwd, run from the project root (the nearest folder with a nauraiz-dev config), like the gate.
    out = await preflight({ ...opts, cwd: opts.cwd ?? findProjectRoot(process.cwd()) });
  } catch (e) {
    out = {
      issue: null,
      collision: { verdict: 'unknown', reason: `unknown: preflight crashed (${e?.message ?? e})` },
      base: { name: null, ref: null, behind: null, ahead: null, fetched: false, reason: 'preflight crashed' },
    };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
