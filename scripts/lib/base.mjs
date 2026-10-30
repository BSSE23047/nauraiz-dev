import { spawnSync } from 'node:child_process';

/** Run `git -C cwd <args>`; throws when git cannot be started so callers can fall back. */
function gitRunner(cwd) {
  return (args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.status === null) throw r.error ?? new Error('git did not exit');
    return { code: r.status, stdout: r.stdout ?? '' };
  };
}

/**
 * The ref to diff against for a configured base branch. A local base that is missing, or strictly
 * behind `origin/<base>`, is stale: use `origin/<base>`. Otherwise (ahead, equal, diverged) keep the
 * local branch. A base that already starts with `origin/`, or any git failure, returns `base` unchanged.
 * `run(args)` returns `{ code, stdout }`; the default shells out to `git -C cwd`.
 */
export function resolveBase(cwd, base, run = gitRunner(cwd)) {
  if (typeof base !== 'string' || base === '' || base.startsWith('origin/')) return base;
  try {
    const local = `refs/heads/${base}`;
    const remote = `refs/remotes/origin/${base}`;
    const localSha = run(['rev-parse', '--verify', '--quiet', local]);
    if (localSha.code > 1) return base; // git itself failed (not a repo, ...), not just "no such ref"
    if (localSha.code === 1) return `origin/${base}`;
    const remoteSha = run(['rev-parse', '--verify', '--quiet', remote]);
    if (remoteSha.code !== 0) return base; // no remote-tracking branch to prefer
    const a = localSha.stdout.trim();
    const b = remoteSha.stdout.trim();
    if (a && a === b) return base;
    const behind = run(['merge-base', '--is-ancestor', local, remote]);
    return behind.code === 0 ? `origin/${base}` : base;
  } catch {
    return base;
  }
}
