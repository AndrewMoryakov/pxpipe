/**
 * Node-host persistence for the dashboard's model-scope choice.
 *
 * The dashboard chips (renderModelsFragment) drive an in-memory runtime
 * override in core (setAllowedModelBases). Core stays filesystem-free so it
 * runs on Workers; this module is the Node-only sidecar that makes a chip
 * choice survive a restart.
 *
 * Variant A precedence: the persisted choice is seeded into the runtime
 * override at startup, so it OVERRIDES PXPIPE_MODELS until the user hits
 * Reset (which clears the file and the override). PXPIPE_MODELS is only the
 * default when no persist file exists.
 *
 * The file lives next to the events log, matching the `4xx-bodies` sidecar
 * convention (a single `rm -rf ~/.pxpipe` cleans everything up).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Path of the persisted model-scope file (sibling of the events log). */
export function modelScopeFile(eventsFile: string): string {
  return path.join(path.dirname(eventsFile), 'model-scope.json');
}

/**
 * Load the persisted scope.
 *  - absent OR unreadable OR malformed → `null` (fall back to PXPIPE_MODELS
 *    env / built-in default; a corrupt file must never block startup).
 *  - present + valid → the stored array VERBATIM, including `[]`, which is a
 *    real choice meaning "every model off / compress nothing".
 * Best-effort: never throws.
 */
export function loadPersistedModelScope(file: string): string[] | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { modelBases?: unknown };
    const bases = parsed?.modelBases;
    if (!Array.isArray(bases)) return null;
    return bases
      .filter((b): b is string => typeof b === 'string')
      .map((b) => b.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Persist the current scope. Best-effort; a failed write never breaks a chip
 * toggle. An empty list is persisted as-is (distinct from Reset/clear).
 */
export function savePersistedModelScope(file: string, bases: readonly string[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ modelBases: [...bases] }, null, 2)}\n`);
  } catch {
    /* best-effort: persistence is a convenience, not a correctness guarantee */
  }
}

/**
 * Clear the persisted scope (Reset → fall back to PXPIPE_MODELS env / default).
 * Best-effort; `force` makes an absent file a no-op rather than an error.
 */
export function clearPersistedModelScope(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best-effort */
  }
}
