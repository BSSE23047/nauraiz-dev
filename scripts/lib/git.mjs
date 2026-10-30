import { execFileSync } from 'node:child_process';

/** Current branch name, or null when not a repo, git fails, or HEAD is detached. */
export function currentBranch(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      encoding: 'utf8',
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}
