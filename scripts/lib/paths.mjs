// Cross-platform path helpers: no dependencies, same results for Windows
// inputs on any OS (the hook may be tested on macOS with D:\ strings).

const DRIVE = /^[A-Za-z]:\//;

/**
 * Backslashes to `/`, then resolve segments: collapse `//`, drop `.`, apply
 * `..` (never past a drive/root; kept at the front of a relative path), strip
 * trailing slashes. A `D:` prefix and a leading `/` are preserved.
 */
export function normalize(p) {
  let s = String(p).split(String.fromCharCode(92)).join('/');
  let prefix = '';
  const drive = /^[A-Za-z]:(?=[/]|$)/.exec(s);
  if (drive) { prefix = drive[0]; s = s.slice(2); }
  const abs = s.startsWith('/');
  const out = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  return prefix + (abs ? '/' : '') + out.join('/');
}

const isAbsolute = (p) => DRIVE.test(p) || p.startsWith('/');

/**
 * Normalized path of `file` relative to `cwd`. If `file` is outside `cwd`
 * (or not absolute), returns the normalized `file` unchanged.
 */
export function toRelative(cwd, file) {
  const f = normalize(file);
  const c = normalize(cwd).replace(/\/+$/, '');
  if (!isAbsolute(f)) return f;
  const fold = process.platform === 'win32' || DRIVE.test(f) || DRIVE.test(c);
  const fa = fold ? f.toLowerCase() : f;
  const ca = fold ? c.toLowerCase() : c;
  if (fa === ca) return '';
  if (fa.startsWith(ca + '/')) return f.slice(c.length + 1);
  return f;
}

const cache = new Map();

function globToRegExp(pattern, flags) {
  const key = flags + '\0' + pattern;
  let re = cache.get(key);
  if (re) return re;
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; src += '(?:.*/)?'; } // `**/` = zero or more dirs
        else src += '.*';
      } else src += '[^/]*';
    } else if (ch === '?') src += '[^/]';
    else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp('^' + src + '$', flags);
  cache.set(key, re);
  return re;
}

/** The path itself, then each ancestor directory (deepest first); a bare drive (`D:`) is not one. */
function withAncestors(p) {
  const out = [{ path: p, dir: false }];
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
    const ancestor = p.slice(0, i);
    if (/^[A-Za-z]:$/.test(ancestor)) break;
    out.push({ path: ancestor, dir: true });
  }
  return out;
}

/**
 * True if `relPath` matches any glob, with gitignore semantics: a pattern matches a path when it
 * matches the path itself or any of its ancestor directories, so `backend`, `/backend` and
 * `backend/` all cover `backend/x.js`. `**` crosses directories, `*` stays in a segment, `?` is one
 * char. A pattern without `/` (a trailing one aside) matches a name at any depth; one with `/` (or a
 * leading `/`) is anchored at the root. A trailing `/` matches directories only. Case-insensitive on win32.
 */
export function matchesAny(relPath, patterns) {
  const flags = process.platform === 'win32' ? 'i' : '';
  const candidates = withAncestors(normalize(relPath));
  return patterns.some((raw) => {
    const full = normalize(raw);
    const dirOnly = /[/\\]$/.test(String(raw)) && full !== '/'; // trailing `/` or `\`: directories only
    const anchored = full.startsWith('/'); // gitignore style: leading / = project root
    const pat = anchored ? full.slice(1) : full;
    return candidates.some(({ path: c, dir }) => {
      if (dirOnly && !dir) return false;
      if (anchored && globToRegExp(full, flags).test(c)) return true; // literal absolute path outside the project
      return globToRegExp(pat, flags).test(anchored || pat.includes('/') ? c : c.slice(c.lastIndexOf('/') + 1));
    });
  });
}
