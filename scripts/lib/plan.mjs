import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const unquote = (v) => {
  const m = /^(["'])(.*)\1$/.exec(v);
  return m ? m[2] : v;
};

/**
 * Parse a plan file. Frontmatter counts only when line 1 is `---`; only `branch` is read.
 * `allowed` = `- ` items under `### Allowed` (until the next heading), backticks stripped,
 * first whitespace-delimited token kept. `handoff` = text under `## Handoff` until the next `## `.
 */
export function parsePlan(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  let branch = null;
  let i = 0;

  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const m = /^branch:\s*(.*?)\s*$/.exec(line);
        if (m) branch = unquote(m[1]) || null;
      }
      i = end + 1;
    }
  }

  const allowed = [];
  const handoffLines = [];
  let inAllowed = false;
  let inHandoff = false;
  let sawHandoff = false;

  for (; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].toLowerCase();
      inAllowed = level === 3 && title === 'allowed';
      if (level <= 2) {
        inHandoff = level === 2 && title === 'handoff';
        if (inHandoff) sawHandoff = true;
      } else if (inHandoff) handoffLines.push(line);
      continue;
    }
    if (inAllowed && line.startsWith('- ')) {
      const token = line.slice(2).replace(/`/g, '').trim().split(/\s+/)[0];
      if (token) allowed.push(token);
    } else if (inHandoff) {
      handoffLines.push(line);
    }
  }

  return { branch, allowed, handoff: sawHandoff ? handoffLines.join('\n') : null };
}

/** First plan in `<cwd>/<planDir>/*.md` (non-recursive, name order) whose frontmatter branch matches. */
export function findPlanForBranch(cwd, planDir, branch) {
  if (!branch) return null;
  const dir = path.resolve(cwd, planDir);
  if (!existsSync(dir)) return null;
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const plan = parsePlan(text);
    if (plan.branch === branch) return { path: file, ...plan };
  }
  return null;
}
