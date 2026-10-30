import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_CONTEXT_CHARS = 6000;

export const DEFAULTS = Object.freeze({
  enforcement: 'advisory',
  state: 'none',
  gate: {},
  protectedPaths: [],
  models: { small: 'sonnet', normal: 'opus', large: 'opus', review: 'opus', 'fix-round': 'sonnet' },
  branch: { base: 'main', pattern: 'feature/${issue}-${slug}', merge: 'merge' },
  plan: { dir: '.work/tasks', template: null },
  pr: { sections: ['Summary', 'Steps ↔ commits', 'Gate output', 'Decisions to confirm', 'Risks', 'Unverified'] },
});

const CONTAINER_KEYS = ['plan', 'models', 'branch', 'pr', 'gate'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Plain objects merge recursively; arrays and scalars from `over` replace `base`. Inputs are not mutated. */
function deepMerge(base, over) {
  const out = {};
  for (const key of Object.keys(base)) out[key] = clone(base[key]);
  for (const key of Object.keys(over)) {
    out[key] = isPlainObject(out[key]) && isPlainObject(over[key])
      ? deepMerge(out[key], over[key])
      : clone(over[key]);
  }
  return out;
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) return deepMerge({}, v);
  return v;
}

/** Returns { value } on success, { value: null } if absent, { error } if unparsable or not an object. */
function readJson(file) {
  if (!existsSync(file)) return { value: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) return { error: `${file}: JSON must be an object` };
    return { value: parsed };
  } catch (e) {
    return { error: `${file}: invalid JSON (${e.message})` };
  }
}

/**
 * Drop wrong-shaped values from one config layer, before it is merged, so the layer below keeps its
 * value: container keys must be plain objects, protectedPaths an array. Returns a shallow copy.
 */
function validLayer(layer, name, errors) {
  const out = { ...layer };
  for (const key of CONTAINER_KEYS) {
    if (key in out && !isPlainObject(out[key])) {
      errors.push(`${name}: ${key} must be an object`);
      delete out[key];
    }
  }
  if ('protectedPaths' in out && !Array.isArray(out.protectedPaths)) {
    errors.push(`${name}: protectedPaths must be an array`);
    delete out.protectedPaths;
  }
  return out;
}

/**
 * Load DEFAULTS <- <cwd>/.claude/nauraiz-dev.json <- <cwd>/.claude/nauraiz-dev.local.json.
 * Only <cwd>/.claude is read (no upward walk). A missing or unparsable project file
 * yields defaults (advisory) with found=false; error is set only for unparsable files.
 * `present` is true whenever the project file exists, so callers can tell "no config" from
 * "config unreadable". A wrong-shaped value in a layer is skipped (with an error) and the layer
 * below keeps its value. A found config that sets no enforcement is guided.
 */
export function loadConfig(cwd) {
  const dir = path.join(cwd, '.claude');
  const project = readJson(path.join(dir, 'nauraiz-dev.json'));
  if (project.error || project.value === null) {
    // A missing file gives { value: null } with no error, so an error here means the file exists.
    return { config: clone(DEFAULTS), found: false, present: Boolean(project.error), error: project.error ?? null };
  }

  const errors = [];
  let merged = deepMerge(DEFAULTS, validLayer(project.value, 'nauraiz-dev.json', errors));
  const local = readJson(path.join(dir, 'nauraiz-dev.local.json'));
  if (local.error) errors.push(local.error);
  else if (local.value) merged = deepMerge(merged, validLayer(local.value, 'nauraiz-dev.local.json', errors));

  // A project that adopted nauraiz-dev and never chose a level is guided; advisory is for 'no config'.
  if (![project.value, local.value].some((layer) => layer?.enforcement !== undefined)) merged.enforcement = 'guided';

  const explicitPlanDir = [project.value, local.value].some((layer) => layer?.plan?.dir !== undefined);
  if (merged.state === 'scaffold' && !explicitPlanDir) merged.plan.dir = 'docs/superpowers/plans';

  if (!merged.protectedPaths.includes('.env*')) merged.protectedPaths.push('.env*');

  return { config: merged, found: true, present: true, error: errors.length ? errors.join('; ') : null };
}

/** Persistent plugin state dir: CLAUDE_PLUGIN_DATA, else os.tmpdir()/nauraiz-dev. Created if missing. */
export function dataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'nauraiz-dev');
  mkdirSync(dir, { recursive: true });
  return dir;
}
