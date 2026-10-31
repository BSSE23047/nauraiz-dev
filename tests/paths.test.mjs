import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, toRelative, matchesAny, realPath } from '../scripts/lib/paths.mjs';
import { shortPath } from './helpers.mjs';

function withPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try { fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

test('env patterns match at any depth', () => {
  assert.ok(matchesAny('.env', ['.env*'])); assert.ok(matchesAny('src/.env.local', ['.env*']));
  assert.ok(!matchesAny('src/env.js', ['.env*']));
});
test('double star and generated dirs', () => {
  assert.ok(matchesAny('src/app/GeneratedApi/a.json', ['**/Generated*/**']));
  assert.ok(!matchesAny('src/app/custom/a.json', ['**/Generated*/**']));
});
test('windows paths normalize', () => {
  assert.equal(toRelative('D:\\repo', 'D:\\repo\\src\\a.js'), 'src/a.js');
  assert.ok(matchesAny(toRelative('D:\\repo', 'D:\\repo\\backend\\x.js'), ['backend/**']));
});
test('outside cwd stays absolute', () => {
  assert.equal(toRelative('D:/repo', 'D:/other/a.js'), 'D:/other/a.js');
});

test('normalize: backslashes and leading ./', () => {
  assert.equal(normalize('.\\src\\a.js'), 'src/a.js');
  assert.equal(normalize('./src/a.js'), 'src/a.js');
  assert.equal(normalize('src/a.js'), 'src/a.js');
});
test('sibling directory sharing a prefix stays absolute', () => {
  assert.equal(toRelative('D:/repo', 'D:/repo2/a.js'), 'D:/repo2/a.js');
  assert.equal(toRelative('D:\\repo', 'D:\\repo2\\a.js'), 'D:/repo2/a.js');
});
test('drive paths compare case-insensitively; cwd trailing slash tolerated', () => {
  assert.equal(toRelative('d:\\Repo\\', 'D:\\repo\\Src\\a.js'), 'Src/a.js');
});
test('posix paths are case-sensitive off win32', () => {
  withPlatform('darwin', () => {
    assert.equal(toRelative('/Users/me/Repo', '/Users/me/repo/a.js'), '/Users/me/repo/a.js');
    assert.equal(toRelative('/Users/me/repo', '/Users/me/repo/a.js'), 'a.js');
  });
});
test('file equal to cwd', () => {
  assert.equal(toRelative('D:/repo', 'D:/repo'), '');
});
test('already-relative file is just normalized', () => {
  assert.equal(toRelative('D:/repo', 'src\\a.js'), 'src/a.js');
});
test('double star matches zero directories', () => {
  assert.ok(matchesAny('Generated/a.js', ['**/Generated*/**']));
  assert.ok(matchesAny('a.js', ['**/a.js']));
});
test('dir/** matches children, not the dir itself', () => {
  assert.ok(matchesAny('backend/x.js', ['backend/**']));
  assert.ok(matchesAny('backend/deep/x.js', ['backend/**']));
  assert.ok(!matchesAny('backend', ['backend/**']));
  assert.ok(!matchesAny('other/backend/x.js', ['backend/**']));
});
test('regex metacharacters in patterns are literal', () => {
  assert.ok(!matchesAny('xenv', ['.env*']));
  assert.ok(!matchesAny('src/xenv', ['.env*']));
  assert.ok(matchesAny('a+b.js', ['a+b.js']));
  assert.ok(!matchesAny('aab.js', ['a+b.js']));
  assert.ok(matchesAny('f(1).js', ['f(1).js']));
  assert.ok(matchesAny('a[1].js', ['a[1].js']));
});
test('single star stays within a segment; ? is one char', () => {
  assert.ok(matchesAny('src/a.js', ['src/*.js']));
  assert.ok(!matchesAny('src/deep/a.js', ['src/*.js']));
  assert.ok(matchesAny('src/a1.js', ['src/a?.js']));
  assert.ok(!matchesAny('src/a12.js', ['src/a?.js']));
  assert.ok(!matchesAny('src/a/.js', ['src/a?.js']));
});
test('pattern without slash matches basename at any depth, but not a name prefix', () => {
  assert.ok(matchesAny('a/b/package.json', ['package.json']));
  // gitignore semantics (I3): a directory named package.json would cover its contents.
  assert.ok(matchesAny('package.json/x', ['package.json']));
  assert.ok(!matchesAny('package.jsonx/a', ['package.json']));
});
test('pattern with slash is anchored at the root', () => {
  assert.ok(matchesAny('src/a.js', ['src/*.js']));
  assert.ok(!matchesAny('lib/src/a.js', ['src/*.js']));
});
test('pattern backslashes and leading ./ are normalized', () => {
  assert.ok(matchesAny('backend/x.js', ['.\\backend\\**']));
  assert.ok(matchesAny('backend/x.js', ['./backend/**']));
});
test('any of several patterns; empty list matches nothing', () => {
  assert.ok(matchesAny('a.js', ['b.js', 'a.js']));
  assert.ok(!matchesAny('a.js', []));
});
test('matching is case-insensitive only on win32', () => {
  withPlatform('win32', () => assert.ok(matchesAny('src/APP.JS', ['src/app.js'])));
  withPlatform('darwin', () => assert.ok(!matchesAny('src/APP.JS', ['src/app.js'])));
});

test('dot-dot segments are resolved (no bypass of anchored patterns)', () => {
  assert.equal(normalize('src/../backend/x.js'), 'backend/x.js');
  assert.ok(matchesAny('src/../backend/x.js', ['backend/**']));
  assert.equal(toRelative('D:/repo', 'D:/repo/src/../backend/x.js'), 'backend/x.js');
  assert.ok(matchesAny(toRelative('D:/repo', 'D:/repo/src/../backend/x.js'), ['backend/**']));
});
test('double slashes collapse', () => {
  assert.equal(toRelative('D:/repo', 'D:/repo//backend/x.js'), 'backend/x.js');
  assert.ok(matchesAny(toRelative('D:/repo', 'D:/repo//backend/x.js'), ['backend/**']));
});
test('dot-dot escaping cwd yields an absolute outside path', () => {
  assert.equal(toRelative('D:/repo', 'D:/repo/src/../../etc/x'), 'D:/etc/x');
  assert.equal(normalize('D:/../x'), 'D:/x');
  assert.equal(normalize('/../x'), '/x');
});
test('leading dot-dot is kept on relative paths', () => {
  assert.equal(normalize('../a/../../b'), '../../b');
  assert.equal(normalize('a/..'), '');
});
test('dot segments are dropped', () => {
  assert.ok(matchesAny('backend/./x.js', ['backend/**']));
  assert.equal(normalize('backend/./x.js'), 'backend/x.js');
});
test('trailing slash is stripped', () => {
  assert.ok(matchesAny('.env/', ['.env*']));
  assert.equal(normalize('src/'), 'src');
});
test('drive and root prefixes survive', () => {
  assert.equal(normalize('D:\\repo\\a'), 'D:/repo/a');
  assert.equal(normalize('/'), '/');
  assert.equal(toRelative('D:/', 'D:/a.js'), 'a.js');
  assert.equal(toRelative('/', '/a.js'), 'a.js');
});
test('leading slash anchors a pattern at the project root', () => {
  assert.ok(matchesAny('backend/x.js', ['/backend/**']));
  assert.ok(!matchesAny('src/backend/x.js', ['/backend/**']));
});

// I3: gitignore directory semantics: a pattern that matches an ancestor directory protects its contents.
test('dir/ (trailing slash) matches the contents of that directory at any depth', () => {
  assert.ok(matchesAny('backend/x.js', ['backend/']));
  assert.ok(matchesAny('backend/deep/x.js', ['backend/']));
  assert.ok(matchesAny('src/backend/x.js', ['backend/']));
  assert.ok(matchesAny('dist/a.js', ['dist/']));
  assert.ok(!matchesAny('dist', ['dist/']), 'dir-only pattern does not match a file of that name');
  assert.ok(!matchesAny('distx/a.js', ['dist/']));
});
test('/dir (anchored) matches the directory and its contents, only at the root', () => {
  assert.ok(matchesAny('backend/x.js', ['/backend']));
  assert.ok(matchesAny('backend/deep/x.js', ['/backend']));
  assert.ok(matchesAny('backend', ['/backend']));
  assert.ok(!matchesAny('src/backend/x.js', ['/backend']));
  assert.ok(matchesAny('backend/x.js', ['/backend/']));
});
test('dir (no slash) matches that name at any depth, and everything under it', () => {
  assert.ok(matchesAny('backend/x.js', ['backend']));
  assert.ok(matchesAny('src/backend/x.js', ['backend']));
  assert.ok(matchesAny('backend', ['backend']));
  assert.ok(!matchesAny('backends/x.js', ['backend']));
  assert.ok(matchesAny('src/secrets/deep/k.pem', ['secrets']));
});
test('anchored dir path with slashes protects its contents', () => {
  assert.ok(matchesAny('src/generated/a/b.js', ['src/generated']));
  assert.ok(!matchesAny('lib/src/generated/a.js', ['src/generated']));
});
test('directory semantics keep the old guarantees', () => {
  assert.ok(!matchesAny('xenv', ['.env*']));
  assert.ok(!matchesAny('src/xenv/a.js', ['.env*']));
  assert.ok(matchesAny('.env.d/key', ['.env*']), 'a .env* directory is protected too');
  assert.ok(matchesAny('src/app/GeneratedApi/a.json', ['**/Generated*/**']));
  assert.ok(matchesAny('Generated/a.js', ['**/Generated*/**']));
  assert.ok(!matchesAny('src/app/custom/a.json', ['**/Generated*/**']));
  assert.ok(!matchesAny('backend', ['backend/**']));
});

test('realPath expands an 8.3 short name to the long form and gives null for a missing path', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-paths-shortname-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(realPath(path.join(dir, 'missing')), null);
  const short = shortPath(dir);
  if (!short) { t.skip('no 8.3 short name here (not win32, or 8.3 names disabled)'); return; }
  assert.equal(realPath(short).toLowerCase(), realPath(dir).toLowerCase());
  assert.doesNotMatch(realPath(short), /~\d/);
});
