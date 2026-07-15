# pxpipe Safeguards — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pxpipe detect and loudly surface the "OpenAI upstream is not chatgpt.com → Codex 404" class of misconfiguration itself (startup banner, `/healthz`, `/api/health.json`), and fail a bad restart legibly — with no UI and no routing mutation.

**Architecture:** A pure core evaluator (`src/core/health.ts`) turns a state snapshot into findings. A small host-side counter (`src/health-counters.ts`) tracks recent `/backend-api/codex/*` traffic so the codex check is evidence-driven. A host builder (`src/health-state.ts`) assembles the snapshot from the resolved upstreams, model scope, compression state, and counter. `src/node.ts` wires the counter into `onRequest`, serves `/healthz` (200/503) + `/api/health.json`, prints warn/error findings at startup, and handles `EADDRINUSE` with an actionable message + non-zero exit. A standalone `scripts/pxpipe-healthcheck.ps1` lets a launcher verify a running instance.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:http`, Vitest, built via `node scripts/build.mjs` to `dist/`.

## Global Constraints

- **Language:** TypeScript, ESM. Import specifiers use `.js` extensions (e.g. `./core/health.js`), matching the repo.
- **Core purity:** `src/core/*` must not touch the filesystem or network and must not call `Date.now()`/`new Date()` internally — any "now" is passed in as a parameter. (`src/health-*.ts` are host modules and MAY use `Date.now()`.)
- **Fail-open:** nothing added here may throw into the request path or block startup. Wrap host-side health calls in try/catch and treat a throw as "no findings".
- **Build/verify:** after code changes run `npm run typecheck`, `npx vitest run <files>`, then `npm run build`. `bin/cli.js` runs `dist/`, so nothing is live until `npm run build` succeeds.
- **Known-good OpenAI host for Codex:** `chatgpt.com` (hostname `chatgpt.com` or `*.chatgpt.com`). The default/footgun host is `api.openai.com`.
- **Durable-fix hint string (verbatim, reused):**
  `Set OPENAI_UPSTREAM=https://chatgpt.com (User env: setx OPENAI_UPSTREAM "https://chatgpt.com" then re-login, or in pxpipe-run.cmd) and restart pxpipe.`
- **Pre-existing test noise:** the full `vitest run` has two environment-dependent failures unrelated to this work (`reflow` corpus timeout, `proxy-usage` flaky under full-suite parallel load; both pass in isolation). Do not treat these as regressions; verify your new files in isolation.

---

### Task 1: Pure health evaluator (`src/core/health.ts`)

**Files:**
- Create: `src/core/health.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Consumes: nothing (pure; uses global `URL`).
- Produces:
  - `type Severity = 'error' | 'warn' | 'info'`
  - `interface Remediation { kind: 'set-openai-upstream'; target: 'https://chatgpt.com'; durableHint: string }`
  - `interface HealthFinding { id: string; severity: Severity; title: string; detail: string; remediation?: Remediation }`
  - `interface HealthRecentTraffic { codexResponses404: number; codexResponsesTotal: number; windowSeconds: number }`
  - `interface HealthState { anthropicUpstream: string; openaiUpstream: string; openaiUpstreamOverridden: boolean; modelScope: string[]; compressionEnabled: boolean; recent: HealthRecentTraffic }`
  - `function evaluateHealth(state: HealthState): HealthFinding[]`
  - `function summarizeHealth(findings: HealthFinding[]): { ok: boolean; httpStatus: 200 | 503 }`

Note (refines spec §4.1): the codex check emits a **single** finding `codex-upstream-mismatch` whose severity **escalates** — `warn` when the upstream host is wrong but no codex 404 has been observed yet (knowable at cold start, so the launcher/banner can warn proactively), `error` once a real codex 404 confirms it (drives `/healthz` 503). This keeps zero false-positive *errors* while still warning up front.

- [ ] **Step 1: Write the failing test**

```ts
// tests/health.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateHealth, summarizeHealth, type HealthState } from '../src/core/health.js';

function state(over: Partial<HealthState> = {}): HealthState {
  return {
    anthropicUpstream: 'https://api.anthropic.com',
    openaiUpstream: 'https://chatgpt.com',
    openaiUpstreamOverridden: false,
    modelScope: ['claude-fable-5'],
    compressionEnabled: true,
    recent: { codexResponses404: 0, codexResponsesTotal: 0, windowSeconds: 300 },
    ...over,
  };
}
const ids = (s: HealthState) => evaluateHealth(s).map((f) => f.id);
const find = (s: HealthState, id: string) => evaluateHealth(s).find((f) => f.id === id);

describe('evaluateHealth — codex upstream', () => {
  it('no finding when upstream is chatgpt.com', () => {
    expect(ids(state())).not.toContain('codex-upstream-mismatch');
  });
  it('no finding when upstream is a chatgpt.com subdomain', () => {
    expect(ids(state({ openaiUpstream: 'https://api.chatgpt.com' }))).not.toContain('codex-upstream-mismatch');
  });
  it('warns (not errors) when host is wrong but no codex 404 seen yet', () => {
    const f = find(state({ openaiUpstream: 'https://api.openai.com' }), 'codex-upstream-mismatch');
    expect(f?.severity).toBe('warn');
    expect(f?.remediation?.target).toBe('https://chatgpt.com');
  });
  it('escalates to error once a codex 404 is observed', () => {
    const f = find(
      state({ openaiUpstream: 'https://api.openai.com', recent: { codexResponses404: 3, codexResponsesTotal: 3, windowSeconds: 300 } }),
      'codex-upstream-mismatch',
    );
    expect(f?.severity).toBe('error');
  });
  it('does not error when host is chatgpt.com even with 404s (not our fault)', () => {
    const f = find(
      state({ recent: { codexResponses404: 5, codexResponsesTotal: 5, windowSeconds: 300 } }),
      'codex-upstream-mismatch',
    );
    expect(f).toBeUndefined();
  });
  it('treats an unparseable upstream as wrong host (warns)', () => {
    expect(find(state({ openaiUpstream: 'not a url' }), 'codex-upstream-mismatch')?.severity).toBe('warn');
  });
});

describe('evaluateHealth — info findings', () => {
  it('flags passthrough when compression is off', () => {
    expect(ids(state({ compressionEnabled: false }))).toContain('compression-passthrough');
  });
  it('flags passthrough when model scope is empty', () => {
    expect(ids(state({ modelScope: [] }))).toContain('compression-passthrough');
  });
  it('flags an active runtime override', () => {
    expect(ids(state({ openaiUpstreamOverridden: true }))).toContain('openai-upstream-overridden');
  });
});

describe('summarizeHealth', () => {
  it('ok + 200 when no error findings', () => {
    expect(summarizeHealth(evaluateHealth(state()))).toEqual({ ok: true, httpStatus: 200 });
  });
  it('not ok + 503 when an error finding is present', () => {
    const findings = evaluateHealth(state({ openaiUpstream: 'https://api.openai.com', recent: { codexResponses404: 1, codexResponsesTotal: 1, windowSeconds: 300 } }));
    expect(summarizeHealth(findings)).toEqual({ ok: false, httpStatus: 503 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/health.test.ts`
Expected: FAIL — cannot resolve `../src/core/health.js` / `evaluateHealth is not a function`.

- [ ] **Step 3: Write the implementation**

```ts
// src/core/health.ts
/** Pure self-diagnosis for pxpipe. No fs, no network, no clock — the caller
 *  passes a state snapshot (including any "recent traffic" aggregate) and gets
 *  back findings. Runs anywhere core runs. */

export type Severity = 'error' | 'warn' | 'info';

export interface Remediation {
  kind: 'set-openai-upstream';
  target: 'https://chatgpt.com';
  durableHint: string;
}

export interface HealthFinding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  remediation?: Remediation;
}

export interface HealthRecentTraffic {
  codexResponses404: number;
  codexResponsesTotal: number;
  windowSeconds: number;
}

export interface HealthState {
  anthropicUpstream: string;
  openaiUpstream: string;
  openaiUpstreamOverridden: boolean;
  modelScope: string[];
  compressionEnabled: boolean;
  recent: HealthRecentTraffic;
}

const CHATGPT_DURABLE_HINT =
  'Set OPENAI_UPSTREAM=https://chatgpt.com (User env: setx OPENAI_UPSTREAM "https://chatgpt.com" then re-login, or in pxpipe-run.cmd) and restart pxpipe.';

/** Lower-cased hostname, or null when the URL cannot be parsed. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True only for chatgpt.com or a *.chatgpt.com subdomain. An unparseable URL
 *  is NOT chatgpt.com (so it surfaces as a mismatch rather than passing). */
function isChatGPTHost(url: string): boolean {
  const h = hostOf(url);
  return h === 'chatgpt.com' || (h !== null && h.endsWith('.chatgpt.com'));
}

export function evaluateHealth(state: HealthState): HealthFinding[] {
  const findings: HealthFinding[] = [];

  if (!isChatGPTHost(state.openaiUpstream)) {
    const confirmed = state.recent.codexResponses404 > 0;
    findings.push({
      id: 'codex-upstream-mismatch',
      severity: confirmed ? 'error' : 'warn',
      title: confirmed
        ? 'Codex requests are 404ing: OpenAI upstream is not chatgpt.com'
        : 'OpenAI upstream is not chatgpt.com — Codex paths will 404',
      detail: confirmed
        ? `${state.recent.codexResponses404}/${state.recent.codexResponsesTotal} recent /backend-api/codex/* requests returned 404 while the OpenAI upstream is ${state.openaiUpstream}. That path only exists on chatgpt.com.`
        : `The OpenAI upstream is ${state.openaiUpstream}. Codex uses /backend-api/codex/*, which exists only on chatgpt.com and 404s here. (No codex traffic seen yet.)`,
      remediation: {
        kind: 'set-openai-upstream',
        target: 'https://chatgpt.com',
        durableHint: CHATGPT_DURABLE_HINT,
      },
    });
  }

  if (!state.compressionEnabled || state.modelScope.length === 0) {
    findings.push({
      id: 'compression-passthrough',
      severity: 'info',
      title: 'Compression is not active — traffic passes through untransformed',
      detail: !state.compressionEnabled
        ? 'The dashboard compression kill-switch is off; every request forwards unchanged.'
        : 'The model scope is empty, so no model is eligible for imaging; every request forwards unchanged.',
    });
  }

  if (state.openaiUpstreamOverridden) {
    findings.push({
      id: 'openai-upstream-overridden',
      severity: 'info',
      title: 'OpenAI upstream is overridden at runtime',
      detail: `A runtime hot-swap is routing OpenAI traffic to ${state.openaiUpstream}. This is in-memory only; set OPENAI_UPSTREAM to make it durable.`,
    });
  }

  return findings;
}

/** ok = no error-severity findings. Maps to the /healthz status code. */
export function summarizeHealth(findings: HealthFinding[]): { ok: boolean; httpStatus: 200 | 503 } {
  const ok = !findings.some((f) => f.severity === 'error');
  return { ok, httpStatus: ok ? 200 : 503 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/health.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/core/health.ts tests/health.test.ts
git commit -m "feat(health): pure evaluateHealth + summarizeHealth (codex-upstream check)"
```

---

### Task 2: Recent-traffic counter (`src/health-counters.ts`)

**Files:**
- Create: `src/health-counters.ts`
- Test: `tests/health-counters.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class HealthCounters` with:
    - `constructor(windowMs?: number)` (default 300000)
    - `record(path: string, status: number, nowMs: number): void`
    - `snapshot(nowMs: number): { codexResponses404: number; codexResponsesTotal: number; windowSeconds: number }`
  - Only `/backend-api/codex/*` paths are counted; the return shape matches `HealthRecentTraffic` from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
// tests/health-counters.test.ts
import { describe, it, expect } from 'vitest';
import { HealthCounters } from '../src/health-counters.js';

describe('HealthCounters', () => {
  it('ignores non-codex paths', () => {
    const c = new HealthCounters();
    c.record('/v1/messages', 200, 1000);
    c.record('/v1/messages', 404, 1000);
    expect(c.snapshot(1000)).toEqual({ codexResponses404: 0, codexResponsesTotal: 0, windowSeconds: 300 });
  });

  it('counts codex requests and 404s within the window', () => {
    const c = new HealthCounters();
    c.record('/backend-api/codex/responses', 404, 1000);
    c.record('/backend-api/codex/responses', 404, 1500);
    c.record('/backend-api/codex/models', 200, 2000);
    expect(c.snapshot(2000)).toEqual({ codexResponses404: 2, codexResponsesTotal: 3, windowSeconds: 300 });
  });

  it('drops entries older than the window', () => {
    const c = new HealthCounters(10_000); // 10s window
    c.record('/backend-api/codex/responses', 404, 1_000);
    c.record('/backend-api/codex/responses', 404, 20_000);
    // at t=20s, the first entry (t=1s) is >10s old and must be dropped
    expect(c.snapshot(20_000)).toEqual({ codexResponses404: 1, codexResponsesTotal: 1, windowSeconds: 10 });
  });

  it('snapshot alone (no new record) still trims stale entries', () => {
    const c = new HealthCounters(10_000);
    c.record('/backend-api/codex/responses', 404, 1_000);
    expect(c.snapshot(50_000)).toEqual({ codexResponses404: 0, codexResponsesTotal: 0, windowSeconds: 10 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/health-counters.test.ts`
Expected: FAIL — cannot resolve `../src/health-counters.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/health-counters.ts
/** Host-side rolling counter of recent /backend-api/codex/* traffic. Feeds the
 *  evidence-driven codex-upstream check. Time is passed in (Date.now() from the
 *  host) so it is deterministically testable. Not in core: it holds state and
 *  reads the clock via its caller. */

const DEFAULT_WINDOW_MS = 300_000; // 5 minutes

interface Entry {
  ts: number;
  is404: boolean;
}

export class HealthCounters {
  private codex: Entry[] = [];

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  private isCodexPath(path: string): boolean {
    return path.startsWith('/backend-api/codex/');
  }

  record(path: string, status: number, nowMs: number): void {
    if (!this.isCodexPath(path)) return;
    this.codex.push({ ts: nowMs, is404: status === 404 });
    this.trim(nowMs);
  }

  /** Entries are appended in time order, so stale ones are a prefix. */
  private trim(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let i = 0;
    while (i < this.codex.length && this.codex[i]!.ts < cutoff) i++;
    if (i > 0) this.codex.splice(0, i);
  }

  snapshot(nowMs: number): { codexResponses404: number; codexResponsesTotal: number; windowSeconds: number } {
    this.trim(nowMs);
    let c404 = 0;
    for (const e of this.codex) if (e.is404) c404++;
    return {
      codexResponses404: c404,
      codexResponsesTotal: this.codex.length,
      windowSeconds: Math.round(this.windowMs / 1000),
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/health-counters.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/health-counters.ts tests/health-counters.test.ts
git commit -m "feat(health): rolling codex-traffic counter"
```

---

### Task 3: State builder + compression accessor (`src/health-state.ts`, `src/dashboard.ts`)

**Files:**
- Create: `src/health-state.ts`
- Modify: `src/dashboard.ts` (add a public `isCompressionEnabled()` getter to `DashboardState`)
- Test: `tests/health-state.test.ts`

**Interfaces:**
- Consumes: `resolveUpstreams` + `type ProxyConfig` from `./core/proxy.js`; `getAllowedModelBases` from `./core/applicability.js`; `type HealthState` from `./core/health.js`; `HealthCounters` from `./health-counters.js`.
- Produces:
  - `DashboardState.isCompressionEnabled(): boolean`
  - `function buildHealthState(config: ProxyConfig, compression: { isCompressionEnabled(): boolean }, counters: HealthCounters, nowMs: number): HealthState`
  - Phase A always sets `openaiUpstreamOverridden: false` (no runtime override exists yet).

- [ ] **Step 1: Add the `isCompressionEnabled` getter to `DashboardState`**

In `src/dashboard.ts`, find the `handleCompressionToggle` method (search for `handleCompressionToggle`). Immediately above it, add:

```ts
  /** Whether the compression kill-switch is currently on. Read by the health
   *  subsystem to report passthrough state. */
  isCompressionEnabled(): boolean {
    return this.compressionEnabled;
  }
```

(`compressionEnabled` is the existing `private compressionEnabled = true;` field.)

- [ ] **Step 2: Write the failing test**

```ts
// tests/health-state.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildHealthState } from '../src/health-state.js';
import { HealthCounters } from '../src/health-counters.js';
import { evaluateHealth } from '../src/core/health.js';
import { setAllowedModelBases } from '../src/core/applicability.js';

const compressionOn = { isCompressionEnabled: () => true };

describe('buildHealthState', () => {
  beforeEach(() => setAllowedModelBases(null)); // reset runtime override between tests

  it('reads the resolved OpenAI upstream from config', () => {
    const s = buildHealthState({ openAIUpstream: 'https://api.openai.com' }, compressionOn, new HealthCounters(), 1000);
    expect(s.openaiUpstream).toBe('https://api.openai.com');
    expect(s.openaiUpstreamOverridden).toBe(false);
  });

  it('surfaces a codex 404 recorded in the counter as an error finding', () => {
    const counters = new HealthCounters();
    counters.record('/backend-api/codex/responses', 404, 1000);
    const s = buildHealthState({ openAIUpstream: 'https://api.openai.com' }, compressionOn, counters, 1000);
    const f = evaluateHealth(s).find((x) => x.id === 'codex-upstream-mismatch');
    expect(f?.severity).toBe('error');
  });

  it('reflects the live model scope and compression state', () => {
    setAllowedModelBases(['gpt-5.6-terra']);
    const s = buildHealthState({}, { isCompressionEnabled: () => false }, new HealthCounters(), 1000);
    expect(s.modelScope).toEqual(['gpt-5.6-terra']);
    expect(s.compressionEnabled).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/health-state.test.ts`
Expected: FAIL — cannot resolve `../src/health-state.js`.

- [ ] **Step 4: Write the implementation**

```ts
// src/health-state.ts
/** Host-side assembler: turns pxpipe's live config + runtime state into the
 *  HealthState snapshot the pure evaluator consumes. Kept out of node.ts so it
 *  is importable in tests without starting a server. */

import { resolveUpstreams, type ProxyConfig } from './core/proxy.js';
import { getAllowedModelBases } from './core/applicability.js';
import type { HealthState } from './core/health.js';
import type { HealthCounters } from './health-counters.js';

export function buildHealthState(
  config: ProxyConfig,
  compression: { isCompressionEnabled(): boolean },
  counters: HealthCounters,
  nowMs: number,
): HealthState {
  const routes = resolveUpstreams(config);
  return {
    anthropicUpstream: routes.anthropic,
    openaiUpstream: routes.openai,
    // Phase A: no runtime upstream override exists yet — always false.
    openaiUpstreamOverridden: false,
    modelScope: getAllowedModelBases(),
    compressionEnabled: compression.isCompressionEnabled(),
    recent: counters.snapshot(nowMs),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/health-state.test.ts`
Expected: PASS.

- [ ] **Step 6: Guard against regressions in the dashboard getter**

Run: `npx vitest run tests/dashboard-api.test.ts`
Expected: PASS (the new getter is additive; existing dashboard tests stay green).

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add src/health-state.ts src/dashboard.ts tests/health-state.test.ts
git commit -m "feat(health): buildHealthState + DashboardState.isCompressionEnabled"
```

---

### Task 4: Serve `/healthz` + `/api/health.json` and feed the counter (`src/node.ts`)

**Files:**
- Modify: `src/node.ts` (imports; `HealthCounters` instance; `onRequest` record; two health routes in the server callback)

**Interfaces:**
- Consumes: `evaluateHealth`, `summarizeHealth` from `./core/health.js`; `HealthCounters` from `./health-counters.js`; `buildHealthState` from `./health-state.js`.
- Produces: HTTP `GET /healthz` (200 when ok / 503 when any error) and `GET /api/health.json` (always 200, `{ ok, findings, state }`). These are host routes handled before the dashboard dispatch.

This task is integration glue over a live `node:http` server, so it is verified by a documented manual run rather than a unit test (the pure logic it composes is already covered by Tasks 1–3).

- [ ] **Step 1: Add imports**

In `src/node.ts`, next to the existing `import { getAllowedModelBases, setAllowedModelBases } from './core/applicability.js';` line, add:

```ts
import { evaluateHealth, summarizeHealth } from './core/health.js';
import { HealthCounters } from './health-counters.js';
import { buildHealthState } from './health-state.js';
```

- [ ] **Step 2: Create the counter instance**

Find where the dashboard is constructed (search for `const dashboard = new DashboardState(`). Immediately after that statement, add:

```ts
  const healthCounters = new HealthCounters();
```

- [ ] **Step 3: Record every request into the counter**

In the `onRequest: async (e) => {` handler, as its first statement (before `dashboard.update(e);`), add:

```ts
      // Feed the health counter first — cheap and must never be skipped by an
      // early return further down. Best-effort; never throw into onRequest.
      try {
        healthCounters.record(e.path, e.status, Date.now());
      } catch {
        /* ignore */
      }
```

- [ ] **Step 4: Serve the health routes**

Find the server request callback (search for `const route = dashboardPath(url.pathname);`). Immediately **before** that line, insert:

```ts
        // Health endpoints — host-level (compose config + counters + dashboard),
        // handled before the dashboard router. Fail-open: any throw → 200 with
        // an empty report rather than a 500.
        if (url.pathname === '/healthz' || url.pathname === '/api/health.json') {
          let ok = true;
          let payload = '{"ok":true,"findings":[],"state":null}';
          try {
            const state = buildHealthState(config, dashboard, healthCounters, Date.now());
            const findings = evaluateHealth(state);
            ok = summarizeHealth(findings).ok;
            payload = JSON.stringify({ ok, findings, state }, null, 2);
          } catch {
            /* fail-open: keep ok=true, empty report */
          }
          const status = url.pathname === '/healthz' ? (ok ? 200 : 503) : 200;
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(payload);
          return;
        }
```

(`config` is the `ProxyConfig` built earlier in this function and is in the closure; `dashboard` satisfies `{ isCompressionEnabled(): boolean }` after Task 3.)

- [ ] **Step 5: Typecheck + build**

```bash
npm run typecheck
npm run build
```
Expected: typecheck clean; build prints `✓ built dist/node.js`.

- [ ] **Step 6: Manual verification (documented)**

In one shell, start a throwaway instance on a spare port pointed at the footgun host:
```bash
OPENAI_UPSTREAM=https://api.openai.com PORT=47899 node bin/cli.js
```
In another shell:
```bash
# no codex traffic yet → warn only → /healthz stays 200
curl.exe -s -o NUL -w "healthz=%{http_code}\n" http://127.0.0.1:47899/healthz
curl.exe -s http://127.0.0.1:47899/api/health.json
```
Expected: `healthz=200`; the JSON `findings` contains `codex-upstream-mismatch` with `"severity":"warn"`.
Then simulate a codex hit (it will 404 upstream) and re-check:
```bash
curl.exe -s -o NUL http://127.0.0.1:47899/backend-api/codex/models
curl.exe -s -o NUL -w "healthz=%{http_code}\n" http://127.0.0.1:47899/healthz
```
Expected: `healthz=503`; the finding severity is now `"error"`. Stop the throwaway instance (Ctrl-C).

- [ ] **Step 7: Commit**

```bash
git add src/node.ts
git commit -m "feat(health): serve /healthz (200/503) + /api/health.json; feed counter"
```

---

### Task 5: Startup banner + actionable `EADDRINUSE` (`src/node.ts`)

**Files:**
- Modify: `src/node.ts` (server `error` handler; warn/error findings printed on `listen`)

**Interfaces:**
- Consumes: `buildHealthState`, `evaluateHealth` (already imported in Task 4); `healthCounters`, `config`, `dashboard`, `opts` from the closure.
- Produces: no exports — startup-time console output + a non-zero process exit on bind failure.

Integration glue; verified by documented manual run.

- [ ] **Step 1: Add the `EADDRINUSE` handler**

Find `const server = createServer((req, res) => {`. Immediately **after** the full `createServer(...)` statement (i.e. after the closing `});` of that call), add:

```ts
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[pxpipe] ⛔ port ${opts.port} is already in use — another pxpipe (or process) is bound to ${opts.host}:${opts.port}.`);
      console.error(`[pxpipe]    Find it:  Get-NetTCPConnection -LocalPort ${opts.port} -State Listen | Select-Object OwningProcess`);
      console.error(`[pxpipe]    Stop it:  Stop-Process -Id <PID> -Force`);
      console.error(`[pxpipe]    Then re-run the launcher.`);
    } else {
      console.error(`[pxpipe] server error: ${err.message}`);
    }
    process.exit(1);
  });
```

- [ ] **Step 2: Print warn/error findings at startup**

Find the `server.listen(opts.port, opts.host, () => {` callback. Inside it, **after** the existing `console.log(\`[pxpipe] dashboard → ...\`)` line, add:

```ts
    try {
      const findings = evaluateHealth(buildHealthState(config, dashboard, healthCounters, Date.now()));
      for (const f of findings) {
        if (f.severity !== 'error' && f.severity !== 'warn') continue;
        const mark = f.severity === 'error' ? '⛔' : '⚠️';
        console.warn(`[pxpipe] ${mark} ${f.title}`);
        console.warn(`[pxpipe]    ${f.detail}`);
        if (f.remediation) console.warn(`[pxpipe]    fix: ${f.remediation.durableHint}`);
      }
    } catch {
      /* never block startup on a health-print failure */
    }
```

- [ ] **Step 3: Typecheck + build**

```bash
npm run typecheck
npm run build
```
Expected: clean typecheck; `✓ built dist/node.js`.

- [ ] **Step 4: Manual verification — startup banner**

```bash
OPENAI_UPSTREAM=https://api.openai.com PORT=47899 node bin/cli.js
```
Expected: alongside the usual banner lines, a `⚠️ OpenAI upstream is not chatgpt.com — Codex paths will 404` block with a `fix:` line. Stop it (Ctrl-C). Re-run with `OPENAI_UPSTREAM=https://chatgpt.com PORT=47899` and confirm **no** warning appears.

- [ ] **Step 5: Manual verification — EADDRINUSE**

Start one instance on 47899, then start a second on the same port:
```bash
OPENAI_UPSTREAM=https://chatgpt.com PORT=47899 node bin/cli.js   # shell A
OPENAI_UPSTREAM=https://chatgpt.com PORT=47899 node bin/cli.js   # shell B
```
Expected in shell B: the `⛔ port 47899 is already in use …` block with the `Get-NetTCPConnection` / `Stop-Process` hints, and the process exits with a non-zero code (check `echo $?` in bash → non-zero). Stop shell A.

- [ ] **Step 6: Commit**

```bash
git add src/node.ts
git commit -m "feat(health): loud startup findings banner + actionable EADDRINUSE exit"
```

---

### Task 6: Launcher health-check helper (`scripts/pxpipe-healthcheck.ps1`)

**Files:**
- Create: `scripts/pxpipe-healthcheck.ps1`
- Modify: `README.md` (short "Verifying a running instance" note)

**Interfaces:**
- Consumes: a running pxpipe's `GET /healthz`.
- Produces: a script that exits `0` when healthy, `1` otherwise, printing a green/red line. Callable by the desktop launcher or the user after starting pxpipe.

Rationale (refines spec §8): `pxpipe-run.cmd` runs `node bin\cli.js` in the **foreground** (it *is* the service window), so an in-script `curl` after it would only run once node exits. A standalone check the launcher/user calls after start is the clean fit; the startup banner (Task 5) already surfaces the same diagnosis in node's own console/log.

- [ ] **Step 1: Create the script**

```powershell
# scripts/pxpipe-healthcheck.ps1
# Verify a running pxpipe instance. Exit 0 = healthy, 1 = unhealthy/unreachable.
param(
  [int]$Port = 47821,
  [int]$Retries = 20
)
$ErrorActionPreference = 'SilentlyContinue'
$url = "http://127.0.0.1:$Port/healthz"
for ($i = 0; $i -lt $Retries; $i++) {
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) {
      $body = $resp.Content | ConvertFrom-Json
      Write-Host "[pxpipe] OK  healthz 200  openai upstream -> $($body.state.openaiUpstream)" -ForegroundColor Green
      exit 0
    }
  } catch {
    $r = $_.Exception.Response
    if ($r -and [int]$r.StatusCode -eq 503) {
      $reader = New-Object System.IO.StreamReader($r.GetResponseStream())
      $body = $reader.ReadToEnd() | ConvertFrom-Json
      $err = ($body.findings | Where-Object { $_.severity -eq 'error' } | Select-Object -First 1)
      Write-Host "[pxpipe] FAIL healthz 503  $($err.title)" -ForegroundColor Red
      if ($err.remediation) { Write-Host "[pxpipe]      fix: $($err.remediation.durableHint)" -ForegroundColor Yellow }
      exit 1
    }
  }
  Start-Sleep -Milliseconds 500
}
Write-Host "[pxpipe] FAIL healthz unreachable on port $Port (is pxpipe running?)" -ForegroundColor Red
exit 1
```

- [ ] **Step 2: Manual verification**

With a healthy instance running (`OPENAI_UPSTREAM=https://chatgpt.com PORT=47821 node bin/cli.js`):
```powershell
pwsh -File scripts/pxpipe-healthcheck.ps1 -Port 47821 ; echo "exit=$LASTEXITCODE"
```
Expected: green `OK healthz 200` line, `exit=0`.

Then with the footgun host **and** after one codex 404 (so the finding is `error`/503):
```powershell
# start: OPENAI_UPSTREAM=https://api.openai.com PORT=47821 node bin/cli.js
# then: curl.exe -s -o NUL http://127.0.0.1:47821/backend-api/codex/models
pwsh -File scripts/pxpipe-healthcheck.ps1 -Port 47821 ; echo "exit=$LASTEXITCODE"
```
Expected: red `FAIL healthz 503` + yellow `fix:` line, `exit=1`.

- [ ] **Step 3: Document it in the README**

Add a short subsection (near the existing run/launch docs) titled **"Verifying a running instance"**:

```markdown
### Verifying a running instance

After starting pxpipe, confirm it is healthy and correctly routed:

    pwsh -File scripts/pxpipe-healthcheck.ps1        # exit 0 = healthy, 1 = problem

It checks `GET /healthz` (200 = ok, 503 = a real problem such as Codex traffic
404ing because the OpenAI upstream is not chatgpt.com) and prints the fix. A
launcher can gate on its exit code. The same diagnosis is printed by pxpipe at
startup and shown at `/api/health.json`.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/pxpipe-healthcheck.ps1 README.md
git commit -m "feat(health): launcher healthcheck script + docs"
```

---

### Task 7: Full-suite gate + Phase A wrap-up

**Files:** none (verification only).

- [ ] **Step 1: Run the new tests together**

Run: `npx vitest run tests/health.test.ts tests/health-counters.test.ts tests/health-state.test.ts tests/dashboard-api.test.ts`
Expected: all PASS.

- [ ] **Step 2: Typecheck + build once more**

```bash
npm run typecheck && npm run build
```
Expected: clean; `✓ built dist/node.js`.

- [ ] **Step 3: Full suite (informational)**

Run: `npx vitest run`
Expected: only the two known pre-existing failures (`reflow` corpus timeout, `proxy-usage` under full-suite load) may fail — everything else green. If any *other* test fails, investigate before declaring Phase A done.

- [ ] **Step 4: Confirm Phase A scope is complete**

Checklist (all must be true): `health.ts` codex check (warn→error escalation) ✓; recent-traffic counter ✓; `/healthz` 200/503 + `/api/health.json` ✓; startup warn/error banner ✓; actionable `EADDRINUSE` + non-zero exit ✓; `pxpipe-healthcheck.ps1` + README ✓. No UI, no routing mutation (those are Phase B).

---

## Notes for the implementer

- **Do not** add the runtime upstream override, the dashboard health panel, or the Fix button — those are **Phase B** and out of scope here.
- The live production process is a separate concern: this plan does not restart or reconfigure the running pxpipe. Landing Phase A changes `dist/` but only takes effect on the next restart, which remains a manual user action (pxpipe is this session's own upstream).
- Keep `src/core/*` free of fs/network/clock. If a check ever needs "now", pass it in — never call `Date.now()` inside core.
