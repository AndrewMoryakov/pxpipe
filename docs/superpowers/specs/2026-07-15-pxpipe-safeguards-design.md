# pxpipe safeguards & self-diagnosis — design

**Date:** 2026-07-15
**Status:** Draft for review
**Author:** brainstormed with Claude Code

## 1. Motivation

On 2026-07-15 Codex broke with a bare `404 Not Found` on
`POST /backend-api/codex/responses` (cf-ray header from Cloudflare). Root
cause: the running pxpipe process had been started **without**
`OPENAI_UPSTREAM=https://chatgpt.com`, so it resolved the OpenAI upstream to
the default `https://api.openai.com`. The ChatGPT-Codex path
`/backend-api/codex/*` only exists on `chatgpt.com`; on `api.openai.com` it
404s. pxpipe faithfully forwarded the request and returned the upstream's 404
with no indication that *it* was the misconfigured link in the chain.

The incident exposed four distinct weaknesses:

1. **Config footgun** — a single missing env var silently routes a whole
   provider to the wrong host.
2. **No self-detection** — the proxy could not tell it was misconfigured; it
   forwarded and relayed someone else's 404.
3. **Fragile restart** — a corrective restart failed with `EADDRINUSE`
   (the bad instance still held the port); the failure landed only in
   `pxpipe-debug.err` and the bad instance kept running.
4. **Single point of failure** — Claude Code itself routes through pxpipe
   (`ANTHROPIC_BASE_URL → 127.0.0.1:47821`), so a broken/misconfigured pxpipe
   takes the user's agent down with it.

## 2. Goal

Build into pxpipe a **self-diagnosis and safe-remediation subsystem** so this
class of failure is **detected by the proxy itself**, **surfaced loudly**
(startup banner, dashboard health panel, `/healthz` for the launcher), and
**fixable in one click** (live in-runtime upstream swap plus a durable-command
hint) — with **no automatic magic** and **no new security hole**.

### Priorities (chosen by the user)

- Detection + loud warnings.
- Preventive config validation.
- Resilience as a dependency (pxpipe must not silently take down Claude Code).
- A manual **Fix** button (user-triggered), not silent auto-heal.

### Non-goals (explicitly out of scope for now)

- Automatic runtime self-healing (silently rewriting config on error).
- `pxpipe doctor` headless CLI (deferred — Phase C).
- Automatic port takeover of another instance (deferred — Phase C, and only
  ever behind an explicit flag).
- Reading `~/.codex` or any external tool's config to infer intent.

## 3. Design principles

- **Detection is traffic-driven, not guessed.** The definitive
  "you are misconfigured" signal is a real observed `/backend-api/codex/*`
  request returning 404 while the OpenAI upstream host is not `chatgpt.com`.
  We do **not** raise an error at cold start merely because the default
  upstream is `api.openai.com` — many users legitimately use `api.openai.com`
  for `/v1/responses` and never touch codex. No false positives.
- **Fixed remediations, not free-form input.** The Fix action performs a
  *specific, hard-coded* remediation (set OpenAI upstream to the known-good
  `https://chatgpt.com`). The unauthenticated dashboard never accepts an
  arbitrary upstream URL — that would turn a local panel into an SSRF /
  upstream-substitution vector.
- **Pure core, impure host.** Health evaluation is a pure function over a state
  snapshot (no fs, no network), so it is trivially testable and runs on
  Workers too. The Node host collects state, prints banners, serves JSON, and
  owns any persistence.
- **Best-effort, fail-open.** Nothing in the safeguard path may throw into a
  request. A health check that errors is dropped; the proxy keeps forwarding.

## 4. Architecture & components

### 4.1 `src/core/health.ts` — pure invariant core

```ts
type Severity = 'error' | 'warn' | 'info';

interface Remediation {
  kind: 'set-openai-upstream';
  target: 'https://chatgpt.com';   // fixed known-good host
  durableHint: string;             // e.g. the OPENAI_UPSTREAM / launcher command
}

interface HealthFinding {
  id: string;                      // stable slug, e.g. 'codex-upstream-mismatch'
  severity: Severity;
  title: string;
  detail: string;
  remediation?: Remediation;
}

interface HealthState {
  anthropicUpstream: string;
  openaiUpstream: string;          // the EFFECTIVE upstream (override or env)
  openaiUpstreamOverridden: boolean;
  modelScope: string[];
  compressionEnabled: boolean;
  // Recent-traffic aggregate, supplied by the host from the dashboard ring:
  recent: {
    codexResponses404: number;     // count of /backend-api/codex/* → 404
    codexResponsesTotal: number;
    windowSeconds: number;
  };
}

export function evaluateHealth(state: HealthState): HealthFinding[];
```

Initial checks:

| id | severity | fires when | remediation |
|----|----------|------------|-------------|
| `codex-upstream-mismatch` | error | `recent.codexResponses404 > 0` **and** `host(openaiUpstream) !== 'chatgpt.com'` | `set-openai-upstream` → chatgpt.com |
| `compression-passthrough` | info | `!compressionEnabled` **or** `modelScope` empty | none (informational) |
| `openai-upstream-overridden` | info | `openaiUpstreamOverridden` | none (shows a live hot-swap is active + how to make it durable) |

The design keeps the check set intentionally small; new invariants are added as
data-driven table rows, not scattered conditionals.

Note: `openaiUpstreamOverridden` and the `openai-upstream-overridden` info
finding are inert in Phase A (no override mechanism exists yet, so the field is
always `false`); they light up only once Phase B ships the live hot-swap.

### 4.2 `src/core/upstream-override.ts` — live OpenAI-upstream hot-swap

Mirrors the model-scope runtime-override pattern already shipped in
`applicability.ts`:

```ts
const ALLOWED_OPENAI_HOSTS = ['chatgpt.com', 'api.openai.com'];

let openAIUpstreamOverride: string | null = null;   // in-memory only

/** Reject anything outside the allowlist (defense in depth: the dashboard only
 *  ever sends the fixed remediation, but the setter must never accept an
 *  arbitrary host from any caller). Returns whether it was applied. */
export function setOpenAIUpstreamOverride(url: string | null): boolean;

/** Effective upstream: override (if set + allowlisted) else the env-resolved
 *  value. Read live per request. */
export function effectiveOpenAIUpstream(envResolved: string): string;

export function isOpenAIUpstreamOverridden(): boolean;
```

`createProxy` (proxy.ts) currently captures `openAIUpstream` once in its
closure (line ~710). Change: compute `effectiveOpenAIUpstream(routes.openai)`
**per request** where `upstreamBase` is chosen, so a hot-swap takes effect on
the next request with no restart.

**Persistence decision — DECIDED: session-only (in-memory), not persisted.**
The hot-swap fixes the *running* process; the *durable* fix is a visible,
standard config source — `OPENAI_UPSTREAM` at the User env level
(`setx OPENAI_UPSTREAM "https://chatgpt.com"`) or in the launcher — surfaced as
the `durableHint` alongside the button. Rationale: a persisted routing override
would be a bespoke, invisible config source that silently outranks the explicit
`OPENAI_UPSTREAM` on the next boot — the *same* invisible-config failure class
that caused the original incident, and it would bite a future intentional
upstream change (e.g. switching to a gateway). Model-scope persistence (a user
*preference*) is a different risk class than upstream routing (ops config), so
the two intentionally differ. `setx` is registry-backed, inspectable
(`reg query "HKCU\Environment"`, the System Properties GUI, any new shell), and
a launcher `set` still overrides it for launcher-started instances — a visible
baseline, not a hidden trap. The launcher `/healthz` check (below) makes a lost
hot-swap after restart loud rather than silent, so nothing fails quietly.

### 4.3 `src/node.ts` — host wiring

- **Startup banner:** after constructing the dashboard, build a `HealthState`
  and print any `error` findings as a prominent multi-line banner (alongside
  the existing `anthropic/openai upstream →` lines), each with its
  `durableHint`. `warn`/`info` are dashboard-only to keep the banner signal
  high.
- **`GET /api/health.json`**: returns
  `{ findings, state, ok: findings.every(f => f.severity !== 'error') }`.
- **`GET /healthz`**: same evaluation but returns **HTTP 200 when `ok`, HTTP 503
  when any `error` finding is present** (with a short text/JSON body). This lets
  the launcher check a *status code* (`curl -f`) rather than parse JSON in a
  `.cmd` — matching conventional healthz semantics.
- **`EADDRINUSE` handler:** `server.on('error', …)` catches the bind failure,
  prints an actionable message — which PID holds `:47821` and the exact stop
  command — instead of a raw stack trace to `.err`, and **exits non-zero** so
  the launcher can detect the failed start via exit code.
- **Launcher (`pxpipe-run.cmd`) verification:** after starting node, poll
  `curl -f http://127.0.0.1:47821/healthz` (short retry for bind) and check
  node's exit code; print a red `✗` line with the diagnosis on failure, a green
  `✓ upstream <host>` on success. `/healthz` confirms the *config* of whatever
  is live on the port; the exit code catches "my instance never started"
  (EADDRINUSE, old bad instance still holding the port). Together they close
  failure mode #3.

### 4.4 Dashboard (Phase B) — `/fragments/health` + Fix button

- New fragment `/fragments/health`, refreshed `every 2s` like the others,
  rendered inside the existing settings shell.
- Shows: effective anthropic/openai upstreams, model scope, compression state,
  and findings with a severity light (red/amber/grey).
- A finding with a `remediation` renders a **Fix** button
  (`POST /fragments/health/fix`, loopback-guarded, no body input — the action
  is fully determined by the finding id: body is `{ id: <finding-id> }` drawn
  from the fixed set of remediable findings, mapped server-side to its
  hard-coded `Remediation` — never a URL from the client) plus an inline,
  copy-friendly rendering of `durableHint` so the user can also make it durable.

## 5. Data flow

**Detection (continuous):**
`request → proxy forwards → onRequest records RecentRow (route, status) →
dashboard ring buffer → host aggregates codex-404 counts → evaluateHealth →
findings → banner (startup) / health panel (live) / /healthz (on demand).`

**Remediation (user-triggered, Phase B):**
`user clicks Fix → POST /fragments/health/fix → host validates loopback →
setOpenAIUpstreamOverride('https://chatgpt.com') → next codex request reads
effectiveOpenAIUpstream() → routes to chatgpt.com → 404s stop → next
evaluateHealth clears the finding → panel goes green.` The panel keeps showing
`durableHint` until the user also sets the env/launcher value.

## 6. Error handling

- `evaluateHealth` is pure and total; the host wraps its call in try/catch and
  treats a throw as "no findings" (never blocks startup or a request).
- `setOpenAIUpstreamOverride` rejects non-allowlisted hosts (returns `false`),
  leaving the current value unchanged; the Fix route reports the outcome.
- The Fix route is idempotent (re-clicking is harmless) and loopback-guarded;
  off-loopback it is refused (consistent with the existing kill-switch
  exposure warning in node.ts).
- All health/aggregate reads degrade cleanly to zero/empty on missing data.

## 7. Testing strategy

- **`health.ts` (unit, table-driven):** state → findings.
  - mismatch fires only when `codexResponses404 > 0` **and** host ≠ chatgpt.com;
  - mismatch does **not** fire when host is chatgpt.com even with 404s;
  - mismatch does **not** fire at cold start (zero codex traffic) — no false
    positive on the default `api.openai.com`;
  - info findings for passthrough / override.
- **`upstream-override.ts` (unit):** allowlist accepts chatgpt.com /
  api.openai.com, rejects others (returns false, no mutation);
  `effectiveOpenAIUpstream` returns override when set else env value.
- **proxy integration:** a codex-path request routes to the *effective*
  upstream; flipping the override mid-test changes the target on the next
  request (proves live read, not closure capture).
- **host:** `/api/health.json` shape + `ok` flag; EADDRINUSE message content
  (focused test or documented manual check).
- Full suite (`vitest run`) stays green; two pre-existing environment-dependent
  failures (`reflow` corpus timeout, `proxy-usage` flaky under full-suite load)
  are unrelated and out of scope.

## 8. Phasing

- **Phase A (first standalone release):** `health.ts` + `codex-upstream-mismatch`
  (traffic-driven) + startup banner + `/api/health.json` + `/healthz` (200/503) +
  actionable `EADDRINUSE` (non-zero exit) + `pxpipe-run.cmd` verification
  (`curl -f /healthz` + exit-code check). Pure logic + host wiring; no UI, no
  live swap, nothing that mutates routing. Immediately makes the incident
  self-evident and gives the launcher a verification hook.
- **Phase B (next):** `upstream-override.ts` (live hot-swap) + `/fragments/health`
  panel + **Fix** button + durable-command hint.
- **Phase C (deferred):** `pxpipe doctor` CLI, generalized invariant framework,
  explicit-flag port takeover.

## 9. Resolved decisions

1. **Upstream-override persistence — DECIDED: session-only** (in-memory), not
   persisted. The durable path is `OPENAI_UPSTREAM` at User env level
   (`setx`) or the launcher — a visible, standard, inspectable config source —
   not a bespoke override file that would silently outrank explicit env. See
   §4.2 for the full rationale. `setx` caveats to carry into the plan/docs:
   it applies to the auto-launcher only after next logon/reboot, and true
   removal is `reg delete "HKCU\Environment" /v OPENAI_UPSTREAM /f` (never
   `setx ""`, which leaves an empty value that resolves to a broken upstream).
2. **Launcher integration — DECIDED: yes, in Phase A.** `pxpipe-run.cmd` polls
   `curl -f /healthz` (200/503) and checks node's exit code, printing a red
   diagnosis on failure / green `✓ upstream <host>` on success. See §4.3 / §8.

## 10. Relationship to the live incident

This design does **not** fix the currently-running misconfigured process
(PID 17216, `openai upstream → https://api.openai.com`). Codex stays 404 until
pxpipe is restarted via `pxpipe-run.cmd` (which sets
`OPENAI_UPSTREAM=https://chatgpt.com` and also loads the already-built
model-scope persistence + Terra/Sol/Lun chips). The restart remains a manual
user action because pxpipe is this session's own upstream. The safeguards above
are what make the *next* occurrence self-evident and one-click, not a
multi-step investigation.
