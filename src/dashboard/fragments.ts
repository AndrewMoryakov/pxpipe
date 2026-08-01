// Server-rendered HTML dashboard — htmx polls fragments, Alpine drives the toast tray.
// Presentation only; server code (src/dashboard.ts, src/node.ts) needs no edits.

import { HTMX_JS, ALPINE_JS } from './vendor.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from '../core/baseline.js';
import { isModelScopeEnabled } from '../core/applicability.js';
import { groupCodexQuotaWindows } from '../codex-usage.js';
import type {
  StatsPayload,
  RecentPayload,
  RecentRow,
  SessionsPayload,
  SessionRow,
  FullStatsPayload,
  CurrentSessionPayload,
} from './types.js';

// ---- helpers --------------------------------------------------------

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function numFmt(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/** "12.3k" / "1.2M" compact formatter for headline numbers. */
function kFmt(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1) + 'M';
  if (a >= 1000) return (v / 1000).toFixed(a >= 100_000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function formatDuration(s: number): string {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
}

function formatReset(epochSeconds: number | null | undefined): string {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return 'reset unknown';
  return `resets ${new Date(epochSeconds * 1000).toLocaleString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })}`;
}

function formatObservedAt(iso: string | null | undefined): string {
  if (!iso) return 'time unknown';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'time unknown';
  return d.toLocaleString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function shortPath(p: string | null | undefined): string {
  if (!p) return '-';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

/** Accessible, touch-friendly contextual help. Native <details> keeps the
 * explanation usable without hover and GLUE_JS preserves open state on HTMX refresh. */
function helpTip(id: string, title: string, what: string, why: string, read: string): string {
  return (
    `<details class="help-tip" id="help-${escapeHtml(id)}">` +
    `<summary aria-label="Help: ${escapeHtml(title)}" title="Explain this block">?</summary>` +
    `<div class="help-popover" role="note">` +
    `<strong>${escapeHtml(title)}</strong>` +
    `<p><b>What it is.</b> ${escapeHtml(what)}</p>` +
    `<p><b>Why it matters.</b> ${escapeHtml(why)}</p>` +
    `<p><b>How to read it.</b> ${escapeHtml(read)}</p>` +
    `</div></details>`
  );
}

// ---- compression toggle (kill switch + manual calibration) ----------------

/**
 * An operator-controlled A/B note. This deliberately is not a sampler: the
 * proxy never changes a request's path for calibration. It only records the
 * phase entered after the operator explicitly uses the kill switch.
 */
export interface ManualCalibrationStatus {
  active: boolean;
  /** `baseline` means the operator manually disabled compression. */
  phase: 'baseline' | 'imaged' | null;
  baselineRequests: number;
  imagedRequests: number;
  /** Locked by the first eligible baseline row; prevents mixed-model/session cohorts. */
  scopeModel: string | null;
  scopeSession: string | null;
  skippedMismatches: number;
}

export function renderToggleFragment(
  enabled: boolean,
  calibration: ManualCalibrationStatus = {
    active: false,
    phase: null,
    baselineRequests: 0,
    imagedRequests: 0,
    scopeModel: null,
    scopeSession: null,
    skippedMismatches: 0,
  },
): string {
  const toggleHelp = helpTip(
    'compression-switch', 'Compression switch',
    'The runtime kill switch that decides whether eligible requests are imaged or sent upstream unchanged.',
    'It gives you immediate control and is also the only way to start a manual calibration baseline. PXPIPE never disables compression automatically for sampling.',
    'Compression on applies the selected model scope. Compression off means passthrough for every request. The switch resets to on after a proxy restart.',
  );
  // NOTE: "PASSTHROUGH MODE", "Disable compression", "Enable compression" are asserted by tests.
  const banner = enabled
    ? ''
    : `<div class="banner"><strong>PASSTHROUGH MODE</strong> — compression is off. Eligible requests go unchanged to their configured upstream: no images, no attributed savings. This is the manual baseline phase; pxpipe did not select or reroute any request automatically.</div>`;
  // Button POSTs the OPPOSITE of current state; 2s poll keeps it fresh.
  const confirm = enabled
    ? ` hx-confirm="Start a MANUAL baseline phase?\n\nCompression will be turned off only because you explicitly approve it. Send comparable requests as normal text, then enable compression to collect the image phase. pxpipe never samples or switches requests automatically. Restarting the proxy turns compression back on and clears this in-memory calibration note."`
    : '';
  const scope = calibration.scopeModel && calibration.scopeSession
    ? `${escapeHtml(calibration.scopeModel)} · session ${escapeHtml(calibration.scopeSession.slice(0, 8))}`
    : 'waiting for the first Claude request to lock model + session';
  const skipped = calibration.skippedMismatches > 0
    ? ` · ${numFmt(calibration.skippedMismatches)} out-of-scope rows ignored`
    : '';
  const calibrationNote = !calibration.active
    ? `<span class="hint">manual calibration is idle · disable compression to explicitly start a normal-text baseline · no automatic passthrough sampling</span>`
    : calibration.phase === 'baseline'
      ? `<span class="hint"><strong>Manual comparison: baseline phase</strong> · ${numFmt(calibration.baselineRequests)} in-scope Claude request${calibration.baselineRequests === 1 ? '' : 's'} · ${scope}${skipped} · re-enable compression when ready</span>`
      : `<span class="hint"><strong>Manual comparison: image phase</strong> · ${numFmt(calibration.baselineRequests)} normal-text vs ${numFmt(calibration.imagedRequests)} imaged · ${scope}${skipped} · same model/session, but still sequential and observational</span>`;
  return (
    banner +
    `<div class="switch">` +
    `<span class="switch-state ${enabled ? 'on' : 'off'}"><span class="switch-dot"></span>${enabled ? 'Compression on' : 'Compression off'}</span>${toggleHelp}` +
    `<button class="switch-btn" type="button" hx-post="/fragments/toggle" hx-target="#frag-toggle" hx-vals='{"enabled": ${!enabled}}'${confirm}>` +
    (enabled ? 'Disable compression' : 'Enable compression') +
    `</button>` +
    `<span class="hint">kill switch · resets to on when you restart</span>` +
    `</div>`
    + `<div class="switch calibration-note">${calibrationNote}</div>`
  );
}

// ---- compress scope (which models get imaged) ----------------------------

/** Chip catalog — UNION with env scope + active set, so env-var models stay toggleable. Labels are cosmetic. */
const MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  // Retained as explicit opt-in chips so their benchmarked below-bar status
  // remains visible rather than silently becoming an unmeasured unknown.
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
];

const GPT_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  // Terra/Sol/Lun are the GPT 5.6 sibling variants (Terra is the local Codex
  // provider's model). Each is an explicit chip so it toggles independently,
  // rather than only being reachable via the broad `gpt-5.6` base. The broad
  // chip stays as a one-click "all 5.6 siblings" shortcut.
  { id: 'gpt-5.6', label: 'GPT 5.6' },
  { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra' },
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { id: 'gpt-5.6-lun', label: 'GPT 5.6 Lun' },
  { id: 'gpt-5.5', label: 'GPT 5.5' },
];

const GROK_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'grok-4.5', label: 'Grok 4.5' },
];

const GEMINI_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
];


/** Per-model readiness for pxpipe imaging, keyed to committed eval receipts —
 *  NOT opinion (see FINDINGS.md / applicability.ts). The dashboard derives its
 *  warning from `status`:
 *   - validated  → reads dense imaged content at/above the Fable bar
 *                  (≈13/15 verbatim + graceful failure). No warning.
 *   - below-bar  → benchmarked and measured under the bar. Blocking confirm on
 *                  enable + ⚠ marker (proven risk).
 *   - unmeasured → no committed benchmark. Non-blocking ⚠ marker + tooltip
 *                  (unknown, not proven-bad). This is also the default for any
 *                  model absent from the table.
 *  Promote to `validated` only by committing receipts that clear the bar. */
type Readiness = 'validated' | 'below-bar' | 'unmeasured';

const MODEL_READINESS: Readonly<Record<string, { status: Readiness; evidence?: string }>> = {
  // Validated — the only reader proven at the production density.
  'claude-fable-5': { status: 'validated' },
  // Below-bar — benchmarked, measured under the Fable bar.
  'claude-opus-4-8': {
    status: 'below-bar',
    evidence: 'Opus 4.8: 0/15 verbatim dense-hex, ~7% arithmetic read-tax, silent confabulation (fixable with abstention prompting).',
  },
  'claude-opus-4-7': {
    status: 'below-bar',
    evidence: 'Opus 4.7: below the Fable bar on imaged verbatim recall (0/15 dense-hex), silent confabulation.',
  },
  'gpt-5.5': {
    status: 'below-bar',
    evidence: 'GPT-5.5: degrades on imaged history/context; recall of older turns can suffer.',
  },
  'gpt-5.6-sol': {
    status: 'below-bar',
    evidence: 'GPT-5.6 Sol: 0/15 verbatim dense-hex, gist 79/93, 98/100 arithmetic — below the Fable bar.',
  },
  'grok-4.5': {
    status: 'below-bar',
    evidence: 'Grok 4.5: 82/100 arithmetic, 83/98 gist, 13/18 state tracking on imaged content.',
  },
  // Broad gpt-5.6 chip enables every 5.6 sibling incl. Sol → carry Sol's risk.
  'gpt-5.6': {
    status: 'below-bar',
    evidence: 'Enabling GPT-5.6 turns on all 5.6 siblings including Sol (0/15 verbatim dense-hex, below the Fable bar).',
  },
  // Unmeasured — no committed benchmark (explicit; unlisted ids default here too).
  'claude-sonnet-5': { status: 'unmeasured' },
  'claude-sonnet-4-6': { status: 'unmeasured' },
  'gpt-5.6-terra': { status: 'unmeasured' },
  'gpt-5.6-lun': { status: 'unmeasured' },
};

/** Shared risk statement for any non-validated model. */
const IMAGED_RISK =
  'pxpipe images older history at a density where exact recall of IDs/hashes/exact numbers is unsafe and can fail via silent confabulation.';
const UNMEASURED_NOTE = `No committed pxpipe reading benchmark for this model — its accuracy on imaged context is unmeasured. ${IMAGED_RISK}`;

function readinessOf(id: string): { status: Readiness; evidence?: string } {
  return MODEL_READINESS[id] ?? { status: 'unmeasured' };
}


export function renderModelsFragment(
  active: string[],
  configured: string[],
  enabled: boolean,
): string {
  const labelOf = new Map(
    [...MODEL_CATALOG, ...GPT_MODEL_CATALOG, ...GROK_MODEL_CATALOG, ...GEMINI_MODEL_CATALOG].map((m) => [m.id, m.label]),
  );
  // Union the catalog with env-configured + active ids so PXPIPE_MODELS-enabled
  // families always show as toggles, then split into chip rows (Claude /
  // OpenAI Responses / Gemini) plus the PXPIPE_MODELS CSV textbox that mirrors the scope.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...MODEL_CATALOG.map((m) => m.id),
    ...GPT_MODEL_CATALOG.map((m) => m.id),
    ...GROK_MODEL_CATALOG.map((m) => m.id),
    ...GEMINI_MODEL_CATALOG.map((m) => m.id),
    ...configured,
    ...active,
  ]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const chipFor = (id: string): string => {
    const lit = isModelScopeEnabled(id, active);
    const label = labelOf.get(id) ?? id;
    const r = readinessOf(id);
    const tip =
      r.status === 'below-bar' ? (r.evidence ?? `${label} reads pxpipe-imaged context below the Fable bar. ${IMAGED_RISK}`)
      : r.status === 'unmeasured' ? UNMEASURED_NOTE
      : '';
    // Persistent, hover-readable explanation for any flagged chip.
    const titleAttr = tip ? ` title="${escapeHtml(tip)}"` : '';
    // below-bar = proven risk → block on ENABLE (off → on). unmeasured never
    // blocks (unknown, not proven-bad); validated never flags. Disable never prompts.
    const confirmAttr = r.status === 'below-bar' && !lit ? ` hx-confirm="${escapeHtml(`${tip} Enable anyway?`)}"` : '';
    // ⚠ marker on any lit non-validated chip so the risk stays visible after enabling.
    const warnMark = r.status !== 'validated' && lit ? ' ⚠' : '';
    return (
      `<button class="chip${lit ? ' on' : ''}" type="button" ` +
      `aria-pressed="${lit}"${titleAttr}${confirmAttr} ` +
      `hx-post="/fragments/models" hx-target="#frag-models" ` +
      `hx-vals='${escapeHtml(JSON.stringify({ model: id, on: !lit }))}'>${escapeHtml(label)}${lit ? ' ✓' : ''}${warnMark}</button>`
    );
  };
  const claudeChips = ids.filter((id) => id.startsWith('claude')).map(chipFor).join('');
  const geminiChips = ids.filter((id) => id.includes('gemini')).map(chipFor).join('');
  const gptChips = ids.filter((id) => id.startsWith('gpt')).map(chipFor).join('');
  const grokChips = ids.filter((id) => id.startsWith('grok')).map(chipFor).join('');
  const otherChips = ids
    .filter((id) => !id.startsWith('claude') && !id.startsWith('gpt') && !id.startsWith('grok') && !id.includes('gemini'))
    .map(chipFor)
    .join('');

  const moot = enabled ? '' : ` <span class="hint">compression is off, so this has no effect right now</span>`;
  const claudeHelp = helpTip(
    'claude-model-scope', 'Image Claude models',
    'The Claude model families currently eligible for context imaging.',
    'Model scope prevents experimental or unsupported models from being transformed unintentionally.',
    'A highlighted chip with a check mark is enabled. Your choice is saved and survives restart until you press Reset (which falls back to PXPIPE_MODELS or the built-in default).',
  );
  const grokHelp = helpTip(
    'grok-model-scope', 'Image Grok models',
    'Opt-in model bases routed through the OpenAI Responses-compatible imaging path.',
    'These models do not use Anthropic count_tokens or cache_control accounting.',
    'Enable only models you intentionally want PXPIPE to image. Savings for this path are locally modeled, not provider-measured.',
  );
  const gptHelp = helpTip(
    'gpt-model-scope', 'Image OpenAI Responses models',
    'GPT model bases currently eligible for context imaging on the Responses path.',
    'It controls transformation only; it does not change the configured upstream model or provider.',
    'Checked chips are enabled. Their reduction is locally modeled and kept separate from Claude provider-measured savings.',
  );

  return (
    moot +
    `<div class="models">` +
    `<span class="models-label">Image Claude models</span>${claudeHelp}` +
    claudeChips +

    `<span class="hint">everything else is sent as normal text · your choice is saved until Reset</span>${moot}` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">Image Grok models</span>${grokHelp}` +
    grokChips +
    otherChips +
    `<span class="hint">opt-in only · OpenAI Responses path · your choice is saved until Reset</span>${moot}` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">Image OpenAI Responses models</span>${gptHelp}` +
    gptChips +
    `<span class="hint">imaging only, no Anthropic cache_control · one scope for all families · your choice is saved until Reset</span>${moot}` +
    `</div>` +
    `<div class="models models-reset">` +
    `<button class="chip" type="button" ` +
    `hx-post="/fragments/models/reset" hx-target="#frag-models">Reset to default</button>` +
    `<span class="hint">clears your saved choice · falls back to PXPIPE_MODELS or the built-in default</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">PXPIPE_MODELS</span>` +
    `<input class="models-csv" id="models-csv" type="text" name="list" value="${escapeHtml(active.join(','))}" spellcheck="false" autocomplete="off" hx-post="/fragments/models" hx-target="#frag-models" hx-trigger="change">` +
    `<span class="hint">CSV of bases, or off · applies on enter/blur</span>` +
    `</div>`
  );
}

// ---- session hero --------------------------------------------------------

// Must stay in lockstep with ASSUMED_INPUT_USD_PER_MTOK in src/dashboard.ts.
const INPUT_USD_PER_MTOK = 10.0;
void INPUT_USD_PER_MTOK; // suppress unused-var; renderHeaderFragment uses the server's pricing block.

// Compact, explicitly scoped summary for the most recently active session.
// The Overview above it owns the since-restart aggregate.
export function renderSessionSummaryFragment(s: CurrentSessionPayload): string {
  const help = helpTip(
    'current-session',
    'Current session',
    'A cache-aware comparison for the most recently active PXPIPE session only.',
    'It separates the work happening now from totals accumulated since the proxy restarted.',
    'Positive percentages mean less estimated input than the same context as text. Negative percentages mean imaging cost more. Output is excluded because PXPIPE does not change it.',
  );
  const percentHelp = helpTip(
    'current-session-percent', 'Current-session percentage',
    'The cache-aware input difference for the selected session’s comparable responses.',
    'It shows the direction and relative size of PXPIPE’s attributed input effect while you work.',
    'It changes only when a new comparable response enters this selected session. It is not a provider bill, and output is intentionally excluded.',
  );
  const effectiveInputHelp = helpTip(
    'current-session-effective-input', 'Effective input comparison',
    'Actual input sent through PXPIPE compared with the same context estimated as plain text.',
    'Both values apply the same cache-create and cache-read weights, so they are comparable.',
    'The first number is actual imaged-path input; the second is the text counterfactual. Smaller actual input produces a positive percentage.',
  );
  if (!s.sessionId) {
    return (

      `<div class="hero hero-empty" data-session-id="">` +
      `<div class="block-label-row"><div class="hero-eyebrow">Current session</div>${help}</div>` +
      `<div class="hero-headline">Waiting for session traffic…</div>` +
      `<div class="hero-sub">Send a request through PXPIPE. This panel will then show only the most recently active session.</div>` +
      `</div>`
    );
  }
  const baselineW = s.baselineInputWeighted ?? 0;
  const actualW = s.actualInputWeighted ?? 0;
  const measured = s.baselineMeasuredCount ?? 0;
  if (measured <= 0 || baselineW <= 0) {
    return (
      `<div class="hero hero-empty" data-session-id="${escapeHtml(s.sessionId)}">` +
      `<div class="block-label-row"><div class="hero-eyebrow">Current session · ${escapeHtml(s.sessionId.slice(0, 8))}</div>${help}</div>` +
      `<div class="hero-headline">Waiting for a comparable response…</div>` +
      `<div class="hero-sub">Traffic exists, but this session does not yet have both an actual input count and a text counterfactual.</div>` +
      `<div class="hero-meta"><span>Watching this session · no input-change claim yet</span><button class="session-follow" type="button" onclick="ppWatchLatest()">Follow latest activity</button></div>` +

      `</div>`
    );
  }
  const inputPct = baselineW > 0 ? (1 - actualW / baselineW) * 100 : 0;
  const positive = inputPct >= 0;
  const bigNum = `${Math.abs(inputPct).toFixed(0)}%`;
  const word = positive ? 'less estimated input' : 'more estimated input';
  const rawOutput = s.rawOutputTokens ?? 0;

  return (

    `<div class="hero${positive ? '' : ' hero-neg'}" data-session-id="${escapeHtml(s.sessionId)}">` +
    `<div class="block-label-row"><div class="hero-eyebrow">Current session · ${escapeHtml(s.sessionId.slice(0, 8))} · ${numFmt(measured)} comparable response${measured === 1 ? '' : 's'}</div>${help}</div>` +
    `<div class="hero-headline"><span class="hero-number-group"><span class="hero-num">${bigNum}</span>${percentHelp}</span> ${word} after caching</div>` +
    `<div class="hero-sub">` +
    `<strong>${kFmt(actualW)}</strong> effective tokens vs <strong>${kFmt(baselineW)}</strong> if this same context ` +
    `stayed plain text — both counted after normal cache discounts in this session. ${effectiveInputHelp} This is a counterfactual estimate, not an invoice.` +
    `</div>` +
    `<div class="hero-meta">` +
    `<span>Watching this session · output untouched (${kFmt(rawOutput)}) · no dollar assumptions</span>` +
    `<button class="session-follow" type="button" onclick="ppWatchLatest()">Follow latest activity</button>` +

    `</div>` +
    `</div>`
  );
}

// ---- stat strip + "Show the math" drawer ----------------------------------

function mathRow(key: string, val: number | string | undefined, note = ''): string {
  const v = typeof val === 'number' ? numFmt(val) : String(val ?? '-');
  return `<div><span class="k">${key}:</span> <span class="v">${escapeHtml(v)}</span> <span class="k">${note}</span></div>`;
}

function mathBlock(title: string, body: string, help: string): string {
  return `<section class="math-block"><div class="block-label-row"><h4>${title}</h4>${help}</div><div class="formula">${body}</div></section>`;
}

export function renderHeaderFragment(s: StatsPayload, port: number): string {
  const pa = s.pricing_assumptions;

  const pricedRows = s.priced_measured_savings_requests ?? 0;
  const unpricedRows = s.unpriced_measured_savings_requests ?? 0;
  const measuredClaudeRows = s.measured_anthropic_savings_requests ?? 0;
  const estimatedResponsesRows = s.estimated_openai_savings_requests ?? 0;
  const excludedProbeRows = s.baseline_probe_excluded_requests ?? 0;
  const cacheCreate5m = s.cache_create_5m_tokens ?? 0;
  const cacheCreate1h = s.cache_create_1h_tokens ?? 0;
  const cacheCreateUnknown = s.cache_create_tier_unknown_tokens ?? 0;
  const priceCoverageTotal = pricedRows + unpricedRows;
  const priceCoverage = priceCoverageTotal > 0
    ? `${pricedRows}/${priceCoverageTotal} rows`
    : 'No priced rows yet';
  const codex = s.codex_actual_usage ?? {
    source: '', loading: false, error: null, sessionFiles: 0, usageSnapshots: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    reasoningOutputTokens: 0, totalTokens: 0, modelContextWindow: null,
    earliestEventAt: null, latestEventAt: null, rateLimits: null, quotaWindows: [],
  };
  const codexCachePct = codex.inputTokens > 0
    ? ((codex.cachedInputTokens / codex.inputTokens) * 100).toFixed(1)
    : '0.0';
  const measuredClaudeSaved = s.measured_claude_saved_input_equivalents ?? 0;
  const modeledResponsesSaved = s.modeled_openai_saved_input_equivalents ?? 0;
  const usageBearingResponses = s.usage_bearing_responses ?? s.all_usage_requests ?? 0;
  const paidCompressed = s.compressed_paid_requests ?? 0;
  const paidPassthrough = s.passthrough_paid_requests ?? 0;
  const evidenceLabel = measuredClaudeRows > 0 && estimatedResponsesRows > 0
    ? 'Mixed evidence'
    : measuredClaudeRows > 0
      ? 'Provider-measured'
      : estimatedResponsesRows > 0
        ? 'Modeled only'
        : 'Collecting data';
  const evidenceClass = measuredClaudeRows > 0 && estimatedResponsesRows === 0 && excludedProbeRows === 0
    ? 'good'
    : measuredClaudeRows > 0 || estimatedResponsesRows > 0
      ? 'mixed'
      : 'waiting';
  const outcomeClass = (s.saved_input_tokens ?? 0) < 0 ? ' negative' : '';
  const overviewHelp = helpTip(
    'overview', 'Overview',
    'A since-restart summary of PXPIPE effect, paid response activity, and evidence quality.',
    'These values have different meanings. Keeping effect, activity, and confidence separate prevents token savings from being confused with provider usage.',
    'Start with input change, then check whether it is Claude measured or Responses modeled. Use Paid LLM responses for sample size and Reliability for limitations.',
  );
  const changeHelp = helpTip(
    'input-change', 'Estimated input change',
    'The cache-aware difference between the input PXPIPE sent and a counterfactual where the same imageable context stayed as text.',
    'It estimates the part PXPIPE can influence. It is not total provider usage and not an invoice.',
    'Positive is an estimated reduction; negative means imaging used more effective input. Claude rows use provider counts. Responses rows use a local tokenizer and vision model.',
  );
  const paidHelp = helpTip(
    'paid-responses', 'Paid LLM responses',
    'Responses with non-zero upstream usage that entered paid-traffic accounting since restart.',
    'Health checks, errors without usage, and other proxy traffic should not inflate the sample size used to judge savings.',
    'Imaged and passthrough are the two paths. “Uncredited” is a subset of imaged rows whose baseline could not be verified, so zero savings were assigned.',
  );
  const reliabilityHelp = helpTip(
    'reliability', 'Estimate reliability',
    'A summary of where the estimate came from and how much of the Claude value has an exact configured model price.',
    'Provider-measured Claude rows are stronger evidence than locally modeled Responses rows. Missing probes and missing prices reduce what can be claimed.',
    'Provider-measured is strongest. Mixed evidence combines measured and modeled rows. Modeled only should be treated as directional. Open Audit for formulas and exclusions.',
  );
  const claudeMeasuredHelp = helpTip(
    'claude-measured', 'Claude provider-measured reduction',
    'Claude input change calculated from an Anthropic text count for the baseline and upstream usage for the actual request.',
    'Both sides are provider measurements, making this the strongest savings evidence PXPIPE exposes.',
    'The token-equivalent value includes cache weights. Dollar value covers only rows whose exact model price is configured; the priced-row fraction is shown inline.',
  );
  const responsesModeledHelp = helpTip(
    'responses-modeled', 'Responses locally modeled reduction',
    'OpenAI Responses input change estimated locally with the matching text tokenizer and the vision-token model used for imaged content.',
    'Responses does not provide the same count endpoint as Claude, so PXPIPE cannot claim this part as provider-measured.',
    'Use it as a directional token-equivalent estimate. It is disclosed separately and deliberately excluded from dollar savings.',
  );
  const imagedHelp = helpTip(
    'paid-imaged', 'Imaged paid responses',
    'Paid responses whose eligible context PXPIPE rendered into images before sending upstream.',
    'They are the rows where PXPIPE can potentially change input usage.',
    'This is a path count, not a savings count: an imaged row can still be uncredited if no trustworthy baseline was available.',
  );
  const passthroughHelp = helpTip(
    'paid-passthrough', 'Passthrough paid responses',
    'Paid responses sent upstream without imaging.',
    'They show the real amount of traffic for which PXPIPE did not transform the context.',
    'They remain in paid-traffic totals but normally contribute zero attributed input change.',
  );
  const uncreditedHelp = helpTip(
    'paid-uncredited', 'Uncredited imaged rows',
    'Imaged paid responses that lacked a successful comparable text baseline.',
    'PXPIPE assigns them zero savings instead of guessing, which keeps the estimate conservative.',
    'This count is a subset of imaged responses, not a third traffic path to add to the total.',
  );
  const priceCoverageHelp = helpTip(
    'price-coverage', 'Exact model-price coverage',
    'The fraction of provider-measured Claude rows with a configured official input price.',
    'Only those rows can contribute to the model-priced dollar value without using a generic tariff.',
    'A lower fraction means the displayed dollar amount is deliberately partial; token-equivalent reduction can still include all measured rows.',
  );

  const overview =
    `<details class="overview-panel collapsible-panel" id="overview" open aria-labelledby="overview-title">` +
    `<summary><span><span class="scope-label">Overview · since restart</span><span class="collapsible-title" id="overview-title">What PXPIPE changed</span></span><span class="collapsible-actions"><span class="scope-chip"><span class="live-dot"></span>live · ${formatDuration(s.uptime_sec)}</span><span class="collapse-control"><span class="when-open">Hide</span><span class="when-closed">Show</span></span></span></summary>` +
    `<div class="collapsible-content">` +
    `<div class="overview-head">` +
    `<div><p>Effect, activity, and evidence are separated so unlike numbers are not compared accidentally.</p></div>` +
    overviewHelp +
    `</div>` +
    `<div class="overview-grid">` +
    `<article class="outcome-card${outcomeClass}">` +
    `<div class="block-label-row"><div class="card-eyebrow">Estimated input change</div>${changeHelp}</div>` +
    `<div class="outcome-value">${numFmt(s.saved_input_tokens)}</div>` +
    `<div class="outcome-note">cache-aware counterfactual · not a provider bill</div>` +
    `<div class="effect-breakdown">` +
    `<div class="effect-row measured"><span class="effect-name"><span><b>Claude</b><small>provider-measured · ${numFmt(measuredClaudeRows)} rows</small></span>${claudeMeasuredHelp}</span><span class="effect-result"><strong>${numFmt(measuredClaudeSaved)}</strong>${pricedRows > 0 ? `<span class="price-callout"><small>Model-priced input value</small><b class="price-value">$${(s.saved_usd ?? 0).toFixed(2)}</b><em>${pricedRows}/${priceCoverageTotal} priced Claude rows</em></span>` : '<em>unpriced</em>'}</span></div>` +
    `<div class="effect-row modeled"><span class="effect-name"><span><b>Responses</b><small>locally modeled · ${numFmt(estimatedResponsesRows)} rows</small></span>${responsesModeledHelp}</span><strong>${numFmt(modeledResponsesSaved)} <em>not priced</em></strong></div>` +
    `</div></article>` +
    `<article class="overview-card">` +
    `<div class="block-label-row"><div class="card-eyebrow">Paid LLM responses</div>${paidHelp}</div>` +
    `<div class="overview-value">${numFmt(usageBearingResponses)}</div>` +
    `<div class="overview-lines">` +
    `<span><span class="field-label"><b>${numFmt(paidCompressed)}</b> imaged${imagedHelp}</span></span>` +
    `<span><span class="field-label"><b>${numFmt(paidPassthrough)}</b> passthrough${passthroughHelp}</span></span>` +
    `<span><span class="field-label"><b>${numFmt(excludedProbeRows)}</b> of imaged rows uncredited${uncreditedHelp}</span></span>` +
    `</div><small>${numFmt(s.requests)} total proxy responses observed</small>` +
    `</article>` +
    `<article class="overview-card evidence-card">` +
    `<div class="evidence-title"><div class="card-eyebrow">How reliable is the estimate?</div><div class="evidence-actions"><span class="quality-badge ${evidenceClass}">${evidenceLabel}</span>${reliabilityHelp}</div></div>` +
    `<div class="overview-lines compact">` +
    `<span><b>${numFmt(measuredClaudeRows)}</b> Claude rows measured by provider</span>` +
    `<span><b>${numFmt(estimatedResponsesRows)}</b> Responses rows modeled locally</span>` +
    `<span><span class="field-label"><b>${priceCoverage}</b> exact model-price coverage${priceCoverageHelp}</span></span>` +
    `</div><a class="text-link" href="#audit-drawer">See methodology and assumptions ↓</a>` +
    `</article>` +
    `</div>` +
    `<div class="reading-legend">` +
    `<span><b>Reduction</b> = estimated counterfactual</span>` +
    `<span><b>$ value</b> = measured Claude only</span>` +
    `<span><b>Codex usage</b> = consumption, not savings</span>` +
    `</div></div></details>`;

  const quotaLabel = (minutes: number): string => {
    if (minutes === 300) return '5-hour';
    if (minutes === 10_080) return 'Weekly';
    if (minutes > 0 && minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
    if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}-hour`;
    return `${numFmt(minutes)} min`;
  };
  const quotaRows = groupCodexQuotaWindows(codex.quotaWindows ?? []).map((group) => {
    const limitId = group.limitId ?? 'codex';
    const displayName = group.limitName || (limitId === 'codex' ? 'Codex' : limitId);
    return `<div class="quota-row"><span class="quota-name"><b>${escapeHtml(displayName)}</b><small>${escapeHtml(limitId)}</small></span>` +
      group.windows.map((window) =>
        `<span><small>${quotaLabel(window.windowMinutes)}</small><b>${window.usedPercent.toFixed(1)}%</b><em>${formatReset(window.resetsAt)}</em></span>`,
      ).join('') + `</div>`;
  }).join('');
  const codexStatus = codex.loading
    ? 'Scanning official rollouts…'
    : codex.error
      ? 'Rollout scan unavailable'
    : 'Retained rollout coverage';
  const codexHelp = helpTip(
    'codex-usage', 'Codex provider-reported usage',
    'Exact token and rate-limit observations read from retained local Codex rollout files whose provider is PXPIPE.',
    'This is the best available view of actual Codex consumption, but it covers retained files rather than every request ever made.',
    'Input includes cached input. Output includes reasoning. Do not add those subcomponents twice, and do not compare this usage total directly with estimated savings.',
  );
  const codexInputHelp = helpTip(
    'codex-input', 'Actual input',
    'Provider-reported Codex input tokens found in retained PXPIPE rollouts.',
    'It shows consumption, not what PXPIPE saved.',
    'Treat it as a cumulative retained-rollout total. Cached input is already included in this number.',
  );
  const codexCacheHelp = helpTip(
    'codex-cache', 'Cached input',
    'The portion of actual Codex input served from provider cache.',
    'Cached tokens are usually billed or limited differently, but they are still part of input usage.',
    'Read the token count and percentage as a subset of Actual input. Never add it to Actual input again.',
  );
  const codexOutputHelp = helpTip(
    'codex-output', 'Actual output',
    'Provider-reported Codex output tokens, including reasoning output.',
    'PXPIPE compresses input context only, so output is usage context rather than a savings claim.',
    'The smaller reasoning value is already included in total output and should not be added twice.',
  );
  const codexCoverageHelp = helpTip(
    'codex-coverage', 'PXPIPE coverage',
    'The number of usable token snapshots and retained Codex session files scanned locally.',
    'It defines the boundary of the Codex totals shown here.',
    'More records improve retained-history coverage, but deleted, moved, direct-provider, or unreadable rollouts remain outside the total.',
  );
  const quotaHelp = helpTip(
    'codex-quotas', 'Provider quota windows',
    'The freshest provider-reported percentage and reset time for every quota window, grouped by limit identifier.',
    'Different Codex products can report separate limits with the same duration; grouping prevents them from being merged accidentally.',
    'Each percentage is used quota for that named limit and window. Reset times come from the provider and are shown in local time.',
  );
  const codexPanel =
    `<details class="codex-panel collapsible-panel" id="usage-limits" open aria-labelledby="codex-title">` +
    `<summary><span><span class="scope-label codex-eyebrow">Usage &amp; limits · retained rollouts</span><span class="collapsible-title" id="codex-title">Codex provider-reported usage</span></span><span class="collapsible-actions"><span class="codex-badge">${codexStatus}</span><span class="collapse-control"><span class="when-open">Hide</span><span class="when-closed">Show</span></span></span></summary>` +
    `<div class="collapsible-content">` +
    `<div class="quality-head">` +
    `<div><div class="title-help-row"><p class="quality-lead">Consumption found in retained local PXPIPE rollouts. This is usage, not evidence of token savings.</p>${codexHelp}</div></div>` +
    `</div>` +
    `<div class="quality-grid">` +
    `<div class="quality-metric"><div class="block-label-row"><span class="quality-label">Actual input</span>${codexInputHelp}</div><strong>${numFmt(codex.inputTokens)}</strong><small>provider-reported input tokens</small></div>` +
    `<div class="quality-metric"><div class="block-label-row"><span class="quality-label">Cached input</span>${codexCacheHelp}</div><strong>${numFmt(codex.cachedInputTokens)} · ${codexCachePct}%</strong><small>included in actual input, not added twice</small></div>` +
    `<div class="quality-metric"><div class="block-label-row"><span class="quality-label">Actual output</span>${codexOutputHelp}</div><strong>${numFmt(codex.outputTokens)}</strong><small>${numFmt(codex.reasoningOutputTokens)} reasoning tokens included</small></div>` +
    `<div class="quality-metric"><div class="block-label-row"><span class="quality-label">PXPIPE coverage</span>${codexCoverageHelp}</div><strong>${numFmt(codex.usageSnapshots)} usage records</strong><small>${numFmt(codex.sessionFiles)} retained Codex session files</small></div>` +
    `</div>` +
    `<div class="usage-scope">Observed ${formatObservedAt(codex.earliestEventAt)} → ${formatObservedAt(codex.latestEventAt)} · ${numFmt(codex.sessionFiles)} retained files</div>` +
    `<div class="quota-head"><strong>Provider quota windows</strong>${quotaHelp}</div>` +
    `<div class="quota-list">${quotaRows || '<div class="quota-empty">No quota windows reported yet</div>'}</div>` +
    `<p class="quality-caveat"><strong>Usage, not savings.</strong> Cached input is included in input; reasoning is included in output. Deleted or unavailable rollouts are outside this coverage.</p>` +
    `</div></details>`;


  // math drawer
  const savedMath =
    `<div><span class="k">formula:</span> <span class="v">saved = baseline − actual</span></div>` +

    `<div><span class="k">weights:</span> <span class="v">input×1.0, cache_create_5m×1.25, cache_create_1h×2.0, cache_read×0.10</span></div>` +
    `<div class="sp"></div>` +
    mathRow('baseline', s.baseline_input_weighted, '(cache-aware: cacheable×weight + cold_tail)') +
    mathRow('actual', s.actual_input_weighted, '(input + server-reported cache tier + cache-read from usage)') +

    mathRow('saved', s.saved_input_tokens, `<span class="op">=</span> baseline − actual`) +
    mathRow('Claude measured reduction', measuredClaudeSaved, 'provider count_tokens baseline + upstream usage') +
    mathRow('Responses modeled reduction', modeledResponsesSaved, 'local tokenizer/vision counterfactual; not dollar-priced') +
    mathRow('TTL sensitivity (unknown creates→1h)', s.saved_if_unknown_cache_create_1h, 'downside scenario for rows whose server response omitted the 5m/1h split; not a confidence interval') +
    `<div class="sp"></div>` +
    mathRow('measured Claude rows', s.measured_anthropic_savings_requests, 'count_tokens + upstream usage; high-confidence part of the headline') +
    mathRow('estimated Responses rows', s.estimated_openai_savings_requests, 'local tokenizer/vision model; disclosed separately in this mixed legacy aggregate') +
    mathRow('probe-excluded rows', s.baseline_probe_excluded_requests, 'compressed paid requests with no successful baseline; zero saving credited') +
    mathRow('cache-create 5m / 1h / unknown', `${numFmt(s.cache_create_5m_tokens)} / ${numFmt(s.cache_create_1h_tokens)} / ${numFmt(s.cache_create_tier_unknown_tokens)}`, 'unknown tier retains the legacy 5m assumption; not proof of its TTL') +
    `<span class="src">output excluded — identical with/without compression; baseline cache TTL remains a modeled counterfactual</span>`;


  const usdMath =
    `<div><span class="k">formula:</span> <span class="v">$ saved = Σ(row_saved × that model’s input rate)</span></div>` +

    `<div class="sp"></div>` +
    mathRow('priced Claude rows', pricedRows, `${numFmt(unpricedRows)} measured Claude rows excluded until configured`) +
    mathRow('saved_usd', `$${(s.saved_usd || 0).toFixed(4)} `, `<span class="op">=</span> sum of model-priced rows`) +
    `<span class="src">source: ${escapeHtml(pa.source || 'docs.anthropic.com pricing')} · override: PXPIPE_MODEL_INPUT_USD_PER_MTOK JSON</span>`;


  const usdToTokenEquiv = (usd: number | undefined): number =>
    pa.input_per_mtok > 0 ? ((usd ?? 0) * 1e6) / pa.input_per_mtok : 0;
  const splitMath =
    `<div><span class="k">formula:</span> <span class="v">cost_index = weighted actual input + output × ${pa.output_multiplier}</span></div>` +
    `<div><span class="k">why:</span> <span class="v">partitions paid responses by the path that ran. It is a normalized token-equivalent index across mixed providers, not model-priced dollars. Selection bias still applies — read it with the sample counts.</span></div>` +
    `<div class="sp"></div>` +
    mathRow(`imaged (n=${s.compressed_paid_requests})`, usdToTokenEquiv(s.compressed_actual_usd), `total equivalents · avg ${numFmt(usdToTokenEquiv(s.compressed_avg_usd_per_request))}/response`) +
    mathRow(`passthrough (n=${s.passthrough_paid_requests})`, usdToTokenEquiv(s.passthrough_actual_usd), `total equivalents · avg ${numFmt(usdToTokenEquiv(s.passthrough_avg_usd_per_request))}/response`) +
    mathRow(
      'imaged − passthrough',
      `${numFmt(usdToTokenEquiv(s.compressed_minus_passthrough_avg_usd))}/response`,
      s.split_sufficient_sample
        ? `(both buckets ≥ ${s.split_min_sample_per_bucket} — delta is meaningful)`
        : `(small sample: need ≥ ${s.split_min_sample_per_bucket} per bucket; treat as noisy)`,
    ) +
    `<span class="src">observed normalized cost index; mixed-provider and not a currency value</span>`;


  const pctMath =
    `<div><span class="k">formula:</span> <span class="v">reduction_share = combined_reduction / (all_baseline_equivalent + all_output × ${pa.output_multiplier})</span></div>` +
    `<div><span class="k">diagnostic, not spend:</span> <span class="v">this mixed-provider counterfactual combines provider-measured Claude and locally modeled Responses reductions in normalized token equivalents. It is not a share of an invoice.</span></div>` +
    `<div class="sp"></div>` +
    mathRow('combined_reduction', s.saved_input_tokens, '(Claude measured + Responses modeled; cache-aware)') +
    mathRow('all_baseline_equivalent', s.all_baseline_equivalent_weighted, '(every paid request; baseline on measured + actual on the rest)') +
    mathRow(`all_output × ${pa.output_multiplier}`, s.all_output_weighted, '(every paid request)') +
    mathRow('reduction_share', (s.saved_pct_of_all_spend || 0).toFixed(1) + '%', `<span class="op">=</span> combined reduction / counterfactual total × 100`) +
    mathRow('all_usage_requests', s.all_usage_requests, '(denominator request count — compressed + passthrough + probe-failed)') +
    `<span class="src">mixed evidence numerator, all-rows normalized denominator — bounded at 100%</span>`;

  const tokeqMath =
    `<div><span class="k">formula:</span> <span class="v">token_equivalent = input + output × ${pa.output_multiplier}</span></div>` +
    `<div><span class="k">why:</span> <span class="v">matches Anthropic's per-Mtok price ratio ($${pa.input_per_mtok} input vs $${pa.input_per_mtok * pa.output_multiplier} output) — this is what the weekly-limit meter counts.</span></div>` +
    `<div class="sp"></div>` +
    mathRow('actual_token_equivalent', s.actual_token_equivalent) +
    mathRow('baseline_token_equivalent', s.baseline_token_equivalent, `(unproxied counterfactual, same ×${pa.output_multiplier} on output)`) +
    `<div class="sp"></div>` +
    mathRow('events_with_measurement', s.events_with_measurement, '(events where the SSE/JSON scanner produced char counts)') +
    mathRow('measured_text_chars', s.measured_text_chars, '') +
    mathRow('measured_thinking_chars', s.measured_thinking_chars, '') +
    mathRow('measured_tool_use_chars', s.measured_tool_use_chars, '') +
    mathRow('measured_redacted_blocks', s.measured_redacted_block_count, '(opaque encrypted blocks — billed but unmeasurable)') +
    `<span class="src">measured — no estimation</span>`;

  const drawer =
    `<details class="drawer" id="audit-drawer">` +
    `<summary>Show the math &amp; honesty receipts <span class="summary-q" aria-hidden="true">?</span></summary>` +
    `<div class="drawer-intro"><strong>Audit note:</strong> the savings headline is a counterfactual (the same request as plain text), not an invoice. Claude credit requires upstream usage and a successful text probe; OpenAI/Responses rows use a local text-versus-image estimate. The proxy only moves <em>input</em> tokens; output is shown on both sides so percentages stay honest.</div>` +
    `<div class="math-grid">` +

    mathBlock('Input tokens saved', savedMath, helpTip(
      'audit-input', 'Input tokens saved math',
      'The exact cache-aware counterfactual formula behind the input-change headline.',
      'It exposes the weights, exclusions, and measured-versus-modeled split instead of hiding assumptions in one total.',
      'Compare baseline with actual, then inspect Claude measured and Responses modeled subtotals. Probe-excluded rows receive zero credit.',
    )) +
    mathBlock('Dollars saved', usdMath, helpTip(
      'audit-dollars', 'Dollar value math',
      'The sum of Claude measured reductions multiplied by each row’s configured model input price.',
      'A single generic price would be misleading when models have different tariffs.',
      'Only priced Claude rows contribute. Responses modeled savings and unknown Claude prices are deliberately excluded.',
    )) +
    mathBlock('Observed path cost index (diagnostic)', splitMath, helpTip(
      'audit-path-index', 'Observed path cost index',
      'A normalized input-equivalent comparison of actual imaged and passthrough responses.',
      'It is an observational sanity check that does not require a counterfactual baseline.',
      'Use averages only when both samples are large enough. It is not currency, and path selection differences can bias the comparison.',
    )) +
    mathBlock('Estimated reduction share (mixed diagnostic)', pctMath, helpTip(
      'audit-share', 'Estimated reduction share',
      'Combined estimated reduction divided by a normalized all-response counterfactual total.',
      'It answers how large the attributed change is relative to all paid traffic, including passthrough and uncredited rows.',
      'Treat it as a mixed-evidence diagnostic, not a percentage of an invoice or provider quota.',
    )) +
    mathBlock('Token-equivalent (what the weekly cap counts)', tokeqMath, helpTip(
      'audit-equivalent', 'Token-equivalent',
      'Input plus output multiplied by the configured output-to-input price ratio.',
      'It places input and output on one normalized scale for limit and cost diagnostics.',
      'Output appears on both actual and baseline sides because PXPIPE does not compress it. Encrypted blocks can be billed even when their characters are not measurable.',
    )) +

    `</div></details>`;

  // NOTE: tests assert the header fragment contains the port number.
  const updated = `<div class="updated"><span class="live-dot"></span>live · port ${port} · uptime ${formatDuration(s.uptime_sec)}</div>`;

  return overview + codexPanel + drawer + updated;
}

// ---- request x-ray (image vs text breakdown) -----------------------------

export interface ContextMapData {
  id: number; // first image id (matches recent-table link)
  baselineTokens: number; // RAW count_tokens as plain text (cache-blind; sub-line only)
  realInput: number; // RAW input + cache_create + cache_read (cache-blind)
  baselineInputEff: number; // cache-WEIGHTED baseline — what text would actually be billed
  actualInputEff: number; // cache-WEIGHTED actual — what the images were actually billed
  haveBaseline: boolean; // weighted pair is trustworthy (baseline probe resolved)
  cacheRead: number; // cache_read tokens this turn. >0 ⇒ the actual request hit cache.
  warm: boolean; // did the TEXT baseline's prefix read warm? Server-observed only:
  // true iff the actual request had cache_read > 0. This keeps the text baseline
  // on the same cache state as the image path; no wall-clock-only inference.
  output: number;
  imageCount: number;
  baselineImagedTokens?: number;
  buckets: Partial<Record<string, number>>; // bucket → chars rendered to PNG
  imageIds: number[]; // image-ring ids for the gallery
  compressed: boolean;
  model?: string;
  responsesComposition?: {
    instructions: number; systemDeveloper: number; userAssistant: number;
    functionCalls: number; functionOutputs: number; reasoningEncrypted: number;
    compactionOpaque: number; toolsJson: number; other: number;
    totalLocal: number; imageParts: number;
    completedFunctionPairs?: number; recentNativeFunctionPairs?: number;
    oldFunctionPairs?: number; openFunctionCalls?: number;
    orphanFunctionOutputs?: number; malformedFunctionItems?: number;
    imageableFunctionCalls?: number; imageableFunctionOutputs?: number;
    collapsedFunctionPairs?: number; collapsedFunctionCalls?: number;
    collapsedFunctionOutputs?: number;
  };
  /** Difference between the provider text counterfactual and local o200k buckets.
   * Can include envelope, tokenizer, and server-side additions. */
  responsesUnexplainedTokens?: number;
  restored?: boolean; // rebuilt from JSONL after a restart — PNG thumbnails are gone
}

const CTXMAP_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ['static_slab', 'System prompt + tool docs'],
  ['reminder', 'System-reminder blocks'],
  ['tool_result_prose', 'Tool results — prose'],
  ['tool_result_log', 'Tool results — logs'],
  ['tool_result_json', 'Tool results — JSON'],
  ['history', 'Older conversation turns'],
];

/** Image-vs-text breakdown for one request. */
export function renderContextMapFragment(
  c: ContextMapData | undefined,
  history: ContextMapData[] = [],
  notFound = false,
): string {
  const isLatest = c !== undefined && c.id === (history.at(-1)?.id ?? -1);
  if (notFound) {
    return `<div class="ctxmap"><div class="empty-note">That request's breakdown isn't kept anymore — only the most recent requests are. Pick <strong>Details</strong> on a newer row.</div></div>`;
  }
  if (!c || (c.baselineTokens <= 0 && c.imageCount <= 0)) {
    return `<div class="ctxmap"><div class="empty-note">Pick <strong>Details</strong> on a request to see exactly which parts became images and which stayed as text.</div></div>`;
  }
  // Cache-aware billing-equivalent basis — identical to the recent row's
  // As-text / Sent / Saved/lost columns. These are not raw token counts; they apply
  // Anthropic's cache rates so create/read misses are visible in the comparison.
  // The two panels can never contradict each other. The raw
  // count_tokens ratio is cache-blind: it over-states savings whenever the
  // prefix would have been a cheap cache-read, so it must NOT drive the
  // headline. It survives only as a clarifying sub-line below.
  const showCompare = c.haveBaseline && c.baselineInputEff > 0;
  const base = c.baselineInputEff;
  const real = c.actualInputEff;
  const pct = showCompare ? Math.round((1 - real / base) * 100) : 0;
  const rawShrink = c.baselineTokens > 0 ? Math.round((1 - c.realInput / c.baselineTokens) * 100) : 0;
  const totalImagedChars = CTXMAP_BUCKETS.reduce((a, [key]) => a + (c.buckets[key] ?? 0), 0);
  const billingBasisHelp = helpTip(
    'context-billing-basis', 'Billing-equivalent comparison',
    'The request-level comparison of imaged input with the same context estimated as text, using cache-aware weights.',
    'Raw character counts and raw token counts can disagree with billed input when a cache is warm or newly written.',
    'Use this headline and the Saved/lost table column for the comparable basis. Treat raw content shrinkage as a supporting diagnostic only.',
  );
  const imageColumnHelp = helpTip(
    'context-images', 'Compressed into images',
    'Context buckets that PXPIPE rendered into PNG pages for the upstream model.',
    'These are the parts whose token representation can be reduced, at the trade-off of visual rather than byte-exact interpretation.',
    'Character counts describe source size. Inspect pages when fidelity matters, especially for numbers, identifiers, and code-like content.',
  );
  const textColumnHelp = helpTip(
    'context-text', 'Kept as plain text',
    'Context PXPIPE deliberately leaves native, including the newest user messages and model output.',
    'Keeping high-precision or recent content as text protects exactness and conversational continuity.',
    'These rows do not become images. “Verbatim” means they are forwarded as text; model output is shown only as usage context.',
  );

  const imgRows = CTXMAP_BUCKETS.map(([key, label]) => [label, c.buckets[key] ?? 0] as const)
    .filter(([, ch]) => ch > 0)
    .map(
      ([label, ch]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(ch)} chars</span></div>`,
    )
    .join('');

  const rc = c.responsesComposition;
  const responseRows: ReadonlyArray<readonly [string, number]> = rc
    ? [
        ['Instructions', rc.instructions],
        ['System / developer items', rc.systemDeveloper],
        ['User / assistant text kept native', rc.userAssistant],
        ['Native tool JSON', rc.toolsJson],
        ['Function calls', rc.functionCalls],
        ['Function outputs', rc.functionOutputs],
        ['Function outputs eligible in old closed pairs', rc.imageableFunctionOutputs ?? 0],
        ['Function outputs actually imaged this request', rc.collapsedFunctionOutputs ?? 0],
        ['Reasoning / encrypted items', rc.reasoningEncrypted],
        ['Compaction / opaque items', rc.compactionOpaque],
        ['Other Responses items', rc.other],
      ]
    : [];
  const responseBreakdown = rc
    ? `<div class="split-note" style="margin-top:12px"><strong>Original Responses composition (local o200k estimate)</strong></div>` +
      responseRows.filter(([, n]) => n > 0).map(([label, n]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(n)} tok</span></div>`,
      ).join('') +
      `<div class="ctx-row"><span class="ctx-lbl">Imageable text baseline</span><span class="ctx-val">${kFmt(c.baselineImagedTokens ?? 0)} tok</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Completed tool pairs (old / recent native / imaged)</span><span class="ctx-val">${rc.completedFunctionPairs ?? 0} (${rc.oldFunctionPairs ?? 0} / ${rc.recentNativeFunctionPairs ?? 0} / ${rc.collapsedFunctionPairs ?? 0})</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Open calls kept native</span><span class="ctx-val">${rc.openFunctionCalls ?? 0}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Native image parts</span><span class="ctx-val">${rc.imageParts}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Provider tokens not explained locally</span><span class="ctx-val">${kFmt(c.responsesUnexplainedTokens ?? 0)} tok</span></div>` +
      `<div class="split-note">This diagnostic uses local o200k counts only; it never calls Anthropic /count_tokens.</div>`
    : '';

  const ids = c.imageIds ?? [];
  const modelLabel = c.model ? escapeHtml(c.model) : 'the model';
  const gallery = ids.length
    ? `<div class="pages-title">${ids.length} image page${ids.length === 1 ? '' : 's'} sent to ${modelLabel} — click one to read the exact text behind it:</div>` +
      `<div class="pages">` +
      ids
        .map(
          (id) =>
            `<img class="page" src="/proxy-latest-png?id=${id}" alt="page ${id}" loading="lazy" title="Click to read the source text behind page ${id}" onclick="ppPin(${id});ppSource(true)" onerror="this.classList.add('page-gone'); this.alt='page ${id} expired from buffer';" />`,
        )
        .join('') +
      `</div>`
    : c.restored && c.imageCount > 0
      ? `<div class="pages-title">${c.imageCount} image page${c.imageCount === 1 ? '' : 's'} were sent — thumbnails expired when the proxy restarted. The breakdown above is reconstructed from the saved log.</div>`
      : '';

  // Did the TEXT baseline's prefix read warm this turn? This follows the actual
  // request's observed cache state: cache_read > 0 means warm, cache_read === 0
  // means cold. No wall-clock-only counterfactual is credited.
  const warm = showCompare && c.warm;
  const google = c.model?.startsWith('gemini-') === true;
  const textNoun = warm ? 'cached text' : 'text';
  // Raw count_tokens can grow (imaging bloated a short prompt), so say so rather
  // than rendering a nonsensical "shrank -36%".
  const rawPhrase =
    rawShrink >= 0 ? `Raw content shrank ${rawShrink}%.` : `Raw content grew ${-rawShrink}%.`;
  const headline = !showCompare
    ? `<strong>${kFmt(c.actualInputEff || c.realInput)}</strong> billing-equivalent input tokens sent`
    : pct >= 0
      ? google
        ? `<span class="ctx-big">${pct}%</span> smaller — text would account as <strong>${kFmt(base)}</strong> input tokens; images account as <strong>${kFmt(real)}</strong>`
        : `<span class="ctx-big">${pct}%</span> smaller — ${textNoun} would bill as <strong>${kFmt(base)}</strong> input tokens; images billed as <strong>${kFmt(real)}</strong>`
      : google
        ? `<span class="ctx-big">${-pct}%</span> bigger — images account as <strong>${kFmt(real)}</strong> input tokens vs <strong>${kFmt(base)}</strong> for text`
        : `<span class="ctx-big">${-pct}%</span> bigger — images billed as <strong>${kFmt(real)}</strong> input tokens vs <strong>${kFmt(base)}</strong> for ${textNoun}`;
  // Clarifying sub-line. It must match the actual request's cache state: claiming
  // a 0.1× read discount when cache_read===0 would count hypothetical cache as a
  // pxpipe effect, so cold rows price both paths cold.
  const subnote = !showCompare
    ? 'Billed tokens count cache discounts (reads at 0.1×) — no trustworthy text baseline for this request yet.'
    : google
      ? `Same provider-token basis as the Saved column. The gap is token count. ${rawPhrase}`
    : !warm
      ? `No warm text cache this turn — the text counterfactual's prefix is priced at the 1.25× create rate (the same event the imaged path pays), identical basis to the Saved column. The gap is purely token count. ${rawPhrase}`
      : pct < 0 && rawShrink > 0
          ? `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. The raw text is ${rawShrink}% smaller, but most of it would have been a cheap cache-read — so imaging it cost more.`
          : `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. ${rawPhrase}`;
  const title = isLatest ? 'Latest request' : 'Selected request';

  return (
    `<div class="ctxmap">` +
    `<div class="ctx-headline"><span class="ctx-title">${title}</span> ${headline} ${billingBasisHelp}</div>` +
    `<div class="split-note ctx-subnote">${subnote}</div>` +
    `<div class="legend"><span class="tag tag-img">Became an image</span><span class="tag tag-txt">Stayed as text</span></div>` +
    `<div class="split">` +
    `<div class="split-col split-img">` +
    `<div class="split-head"><span class="field-label">Compressed into images${imageColumnHelp}</span> <span class="split-sum">${kFmt(totalImagedChars)} chars · ${c.imageCount} page${c.imageCount === 1 ? '' : 's'}</span></div>` +
    (imgRows || `<div class="ctx-row muted-row">nothing imaged this request</div>`) +
    `<div class="split-note">pxpipe can misread exact values inside images — treat these as gist, not byte-exact.</div>` +
    `</div>` +
    `<div class="split-col split-txt">` +
    `<div class="split-head"><span class="field-label">Kept as plain text${textColumnHelp}</span> <span class="split-sum">byte-exact</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">Your latest messages</span><span class="ctx-val">verbatim</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">Model reply (output)</span><span class="ctx-val">${kFmt(c.output)} tok</span></div>` +
    `<div class="split-note">never imaged — safe for IDs, hashes and exact numbers.</div>` +
    `</div>` +
    `</div>` +
    responseBreakdown +
    gallery +
    `</div>`
  );
}

// ---- recent requests table -----------------------------------------------

function statusCls(status: number): string {
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  return 'good';
}

export function renderRecentFragment(p: RecentPayload): string {
  const rows = (p.recent ?? []).slice().reverse();
  const sentAsHelp = helpTip(
    'recent-sent-as', 'Sent as',
    'Whether the eligible context was sent upstream as images or normal text for this response.',
    'It identifies the actual path, not whether a saving was proven.',
    'Image means PXPIPE transformed eligible context. Text means passthrough. Use Saved/lost to see the attributed input difference when a baseline exists.',
  );
  const cacheHitsHelp = helpTip(
    'recent-cache-hits', 'Cache hits',
    'Provider input tokens served from a warm cache on this request.',
    'Warm cache reads have a lower billing weight, so they materially affect fair text-versus-image comparisons.',
    'This is a subset of input usage. A high value can make raw text reduction look larger than billing-equivalent savings.',
  );
  const asTextHelp = helpTip(
    'recent-as-text', 'As text',
    'The cache-aware input counterfactual if the same request had stayed as plain text.',
    'It is the baseline used to attribute PXPIPE input change.',
    'Compare it with Sent only on rows where both values exist. It is not a separately billed request.',
  );
  const sentHelp = helpTip(
    'recent-sent', 'Sent',
    'Actual cache-aware input usage of the request that was sent upstream.',
    'This is the observed side of the text-versus-image comparison.',
    'Compare it with As text. It includes the appropriate cache create/read weighting, not raw input tokens alone.',
  );
  const savedHelp = helpTip(
    'recent-saved-lost', 'Saved/lost',
    'As text minus Sent, expressed as cache-aware input equivalents.',
    'It shows the attributed effect for this one request using the same basis as the dashboard overview.',
    'Positive means estimated reduction; negative means the imaged path cost more. A create badge marks a one-time cache-write premium that later reads may recoup.',
  );
  const body =
    rows.length === 0
      ? `<tr><td colspan="10" class="empty-cell">No requests yet — they stream in here live.</td></tr>`
      : rows
          .map((e: RecentRow, i: number) => {
            const viewId = (e.img_ids ?? (e.img_id != null ? [e.img_id] : []))[0];
            const viewLink =
              viewId != null
                ? `<button class="row-view" type="button" hx-get="/fragments/context-map?req=${viewId}" hx-target="#frag-context-map" hx-swap="innerHTML">Details →</button>`
                : `<span class="muted">—</span>`;
            const saved = e.session_saved_so_far_delta;
            // A loss that disappears when the newly written prefix is repriced at
            // the read rate is just the one-time cache-create premium — the
            // purchase price of the cheap cache reads on the turns that follow.
            // Mark it so create turns don't read as gate failures.
            const cc = e.cache_create ?? 0;
            const createLoss =
              saved != null &&
              saved < 0 &&
              cc > 0 &&
              saved + cc * (CACHE_CREATE_RATE - CACHE_READ_RATE) > 0;
            const createNote = createLoss
              ? ` <span class="mk-create" title="Cache-create turn: this loss is the one-time ${CACHE_CREATE_RATE}× premium for writing ${numFmt(cc)} tokens to cache. Later turns re-read that prefix at ${CACHE_READ_RATE}×, which typically recoups it.">create</span>`
              : '';
            const savedCell = saved == null
              ? `<td class="num muted">—</td>`
              : saved > 0
                ? `<td class="num pos">${numFmt(saved)}</td>`
                : saved < 0
                  ? `<td class="num neg">${numFmt(saved)}${createNote}</td>`
                  : `<td class="num">0</td>`;
            const imaged = e.cc_added
              ? `<span class="badge badge-img">image</span>`
              : `<span class="badge badge-txt">text</span>`;
            return (
              `<tr>` +
              `<td class="muted">${i + 1}</td>` +
              `<td><span class="pill pill-${statusCls(e.status)}">${e.status}</span></td>` +
              `<td class="endp">${escapeHtml(shortPath(e.path))}</td>` +
              `<td>${e.model ? `<code>${escapeHtml(e.model)}</code>` : '<span class="muted">—</span>'}</td>` +
              `<td>${imaged}</td>` +
              `<td class="num">${e.cache_read != null ? numFmt(e.cache_read) : '—'}</td>` +
              `<td class="num">${e.baseline_input != null ? numFmt(e.baseline_input) : '—'}</td>` +
              `<td class="num">${e.actual_input != null ? numFmt(e.actual_input) : '—'}</td>` +
              savedCell +
              `<td class="num">${viewLink}</td>` +
              `</tr>`
            );
          })
          .join('');
  return (
    `<table class="rtable"><thead><tr>` +
    `<th>#</th>` +
    `<th>Result</th>` +
    `<th>Endpoint</th>` +
    `<th>Model</th>` +

    `<th><span class="th-help">Sent as${sentAsHelp}</span></th>` +
    `<th class="num"><span class="th-help">Cache hits${cacheHitsHelp}</span></th>` +
    `<th class="num"><span class="th-help">As text${asTextHelp}</span></th>` +
    `<th class="num"><span class="th-help">Sent${sentHelp}</span></th>` +
    `<th class="num"><span class="th-help">Saved/lost${savedHelp}</span></th>` +

    `<th></th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

// ---- image ↔ source inspector --------------------------------------------

export interface LatestFragmentInput {
  payload: RecentPayload;
  pin: number | null; // pinned image id, or null to follow latest
  showSource: boolean;
  sourceText: string | null; // null = not captured
}

export function renderLatestFragment(inp: LatestFragmentInput): string {
  const { payload, pin, showSource, sourceText } = inp;
  const hasPreview = payload.has_preview === true;
  const meta = payload.preview_meta ?? '';
  const imageIds = payload.image_ids ?? [];
  const pinnedEvicted = pin != null && !imageIds.includes(pin);

  // Pinned id, or latest (cache-busted by meta).
  const imgSrc =
    pin != null
      ? `/proxy-latest-png?id=${pin}`
      : `/proxy-latest-png?t=${encodeURIComponent(meta)}`;

  const pinBar =
    pin != null
      ? `<div class="viewer-bar"><button class="mini-btn" type="button" onclick="ppPin(null)">← back to latest</button><span class="mini-label">image #${pin}</span></div>`
      : '';

  let main: string;
  if (pin != null && pinnedEvicted) {
    main = `<div class="evicted">image #${pin} is no longer in the buffer</div>`;
  } else if (pin != null || hasPreview) {
    // When source pane is open the image appears inside the pairing — don't duplicate it.
    main = showSource ? '' : `<div class="frame"><img src="${imgSrc}" alt="rendered page" /></div>`;
  } else {
    main = `<div class="empty-note">No images yet — they appear the instant pxpipe compresses a request.</div>`;
  }

  const showBtn = pin != null ? !pinnedEvicted : hasPreview;
  const caption =
    pin != null ? `image #${pin}` : meta ? `${escapeHtml(meta)} · top-left at native size` : '';
  const srcBtn = showBtn
    ? `<button class="mini-btn" type="button" onclick="ppSource(${showSource ? 'false' : 'true'})">${showSource ? 'hide source text' : 'show the text behind this image'}</button>`
    : '';

  let pane = '';
  if (showSource) {
    pane =
      sourceText == null
        ? `<div class="evicted">source text wasn't captured for this image</div>`
        : `<div class="pairing">` +
          `<div class="pair-col"><div class="pair-head pair-img">What the model sees · image</div><div class="frame frame-sm"><img src="${imgSrc}" alt="rendered page" /></div></div>` +
          `<div class="pair-mid">made from ↓</div>` +
          `<div class="pair-col"><div class="pair-head pair-txt">The original text · byte-exact</div><pre class="src-pane">${escapeHtml(sourceText)}</pre></div>` +
          `</div>`;
  }

  return pinBar + main + `<div class="viewer-caption">${caption} ${srcBtn}</div>` + pane;
}

// ---- sessions bar chart --------------------------------------------------

const TOP_N = 8;

export function renderSessionsFragment(p: SessionsPayload): string {
  const all = p.sessions ?? [];
  const rows = [...all]
    .sort((a, b) => (b.tokensSavedEst ?? 0) - (a.tokensSavedEst ?? 0))
    .slice(0, TOP_N);
  const max = rows.reduce((m, s) => Math.max(m, s.tokensSavedEst ?? 0), 0);

  const label = (s: SessionRow) => {
    const proj = s.claudeCode?.projectPath || s.project;
    return proj ? shortPath(proj) : s.id.slice(0, 8);
  };
  const barPct = (v: number) => (max <= 0 || v <= 0 ? 0 : (v / max) * 100);

  const status = `<div class="status">${all.length} session${all.length === 1 ? '' : 's'} tracked</div>`;
  if (rows.length === 0) return status + `<div class="empty">No sessions yet.</div>`;

  const chart = rows
    .map((s) => {
      const v = s.tokensSavedEst ?? 0;
      const pct = barPct(v);
      const fill = pct > 0 ? `<div class="bar-fill" style="width:max(3px,${pct}%)"></div>` : '';
      return (
        `<div class="bar-row">` +
        `<div class="bar-label" title="${escapeHtml(s.claudeCode?.projectPath || s.project || s.id)}">${escapeHtml(label(s))}</div>` +
        `<div class="bar-track">${fill}</div>` +
        `<div class="bar-val${v < 0 ? ' neg' : ''}">${numFmt(v)}</div>` +
        `</div>`
      );
    })
    .join('');

  return (
    status +
    `<div class="bars">${chart}</div>` +
    `<div class="axis">tokens saved per session (cache-aware) · top ${rows.length} of ${all.length}</div>`
  );
}

// ---- full-history stats table --------------------------------------------

export function renderStatsTableFragment(p: FullStatsPayload): string {
  if (p.error || !p.summary) {
    return `<div class="status">${escapeHtml(p.error || 'no data')}</div><table class="dtable"><tbody></tbody></table>`;
  }
  const s = p.summary;
  const totalIn = (s.inputTokensTotal || 0) + (s.cacheCreateTokensTotal || 0) + (s.cacheReadTokensTotal || 0);
  const hitRateTok = totalIn > 0 ? ((s.cacheReadTokensTotal / totalIn) * 100).toFixed(1) + '%' : '-';
  const hitRateEv =
    s.eventsWithBaseline > 0 ? ((s.cacheHitEvents / s.eventsWithBaseline) * 100).toFixed(1) + '%' : '-';
  const charRatio =
    s.origCharsTotal > 0 ? ((s.imageBytesTotal / s.origCharsTotal) * 100).toFixed(3) + 'x' : '-';

  // NOTE: the literal word "requests" is asserted by tests.
  const tr = (k: string, v: string) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`;
  return (
    `<div class="status">${numFmt(p.parsed)} events parsed from disk</div>` +
    `<table class="dtable"><tbody>` +
    tr('requests', numFmt(s.total)) +
    tr('2xx / 4xx / 5xx', `${numFmt(s.ok2xx)} / ${numFmt(s.err4xx)} / ${numFmt(s.err5xx)}`) +
    tr('compressed', numFmt(s.compressed)) +
    tr('passthrough', numFmt(s.passthrough)) +
    tr('input tokens', numFmt(s.inputTokensTotal)) +
    tr('cache create', numFmt(s.cacheCreateTokensTotal)) +
    tr('cache read', numFmt(s.cacheReadTokensTotal)) +
    tr('cache hit (by tokens)', hitRateTok) +
    tr('cache hit (by events)', hitRateEv) +
    tr('original chars', numFmt(s.origCharsTotal)) +
    tr('image bytes', numFmt(s.imageBytesTotal)) +
    tr('bytes / char', charRatio) +
    (s.pinEvents
      ? tr(
          'pin footer (uncached)',
          `${numFmt(s.pinCharsTotal ?? 0)} chars / ${numFmt(s.pinEvents)} req`,
        )
      : '') +
    tr('latency p50 / p95', `${numFmt(s.durationP50)} / ${numFmt(s.durationP95)} ms`) +
    tr('first-byte p50 / p95', `${numFmt(s.firstByteP50)} / ${numFmt(s.firstByteP95)} ms`) +
    `</tbody></table>`
  );
}

// ---- page shell -------------------------------------------------------------

// Favicon mirrors the .flame-dot glyph: a glossy flame sphere (radial highlight
// at 35%/30%, --flame -> --flame-strong) ringed by a faint --flame-tint halo.
// Inlined as a URL-encoded SVG data URI so the dashboard stays self-contained
// (no extra route/static asset). Keep colors in sync with :root in CSS below.
const FAVICON =
  "data:image/svg+xml," +
  "%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E" +
  "%3Cdefs%3E%3CradialGradient%20id='f'%20cx='35%25'%20cy='30%25'%20r='80%25'%3E" +
  "%3Cstop%20offset='0%25'%20stop-color='%23ffd0a8'/%3E" +
  "%3Cstop%20offset='55%25'%20stop-color='%23ff5a1f'/%3E" +
  "%3Cstop%20offset='100%25'%20stop-color='%23e8420a'/%3E" +
  "%3C/radialGradient%3E%3C/defs%3E" +
  "%3Ccircle%20cx='16'%20cy='16'%20r='15.5'%20fill='%23fff1ea'/%3E" +
  "%3Ccircle%20cx='16'%20cy='16'%20r='10'%20fill='url(%23f)'/%3E%3C/svg%3E";

const CSS = `
  :root {
    --bg: #faf6f2; --surface: #ffffff; --surface-2: #fbf4ee;
    --border: #efe5db; --border-strong: #e4d6c8;
    --ink: #241f1b; --ink-2: #5d534a; --muted: #9b9189;
    --flame: #ff5a1f; --flame-strong: #e8420a; --flame-ink: #bd3a08; --flame-tint: #fff1ea;
    --good: #1f9d57; --good-tint: #e7f6ee; --bad: #d8483b; --bad-tint: #fcebe9; --warn: #b7791f; --warn-tint: #fbf0db;
    --img: #ff5a1f; --img-ink: #bd3a08; --img-tint: #fff1ea;
    --txt: #2f7db0; --txt-ink: #1f5f8b; --txt-tint: #e9f3fb;
    --radius: 14px;
    --shadow: 0 1px 2px rgba(60,35,15,.05), 0 8px 24px rgba(60,35,15,.05);
    --mono: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color-scheme: light;
  }
  /* Dark theme: same warm-flame identity, inverted neutrals. Set before first
     paint by the <head> script (localStorage 'pp-theme' else system pref);
     toggled by ppTheme(). Accents (flame/img/txt) are lifted for contrast. */
  :root[data-theme="dark"] {
    --bg: #17120f; --surface: #211a15; --surface-2: #2a211b;
    --border: #352a22; --border-strong: #46382e;
    --ink: #f6efe8; --ink-2: #cabbac; --muted: #9a8c7d;
    --flame: #ff6a33; --flame-strong: #e8420a; --flame-ink: #ff9a63; --flame-tint: #3a2318;
    --good: #3fbd76; --good-tint: #15291f; --bad: #f0645a; --bad-tint: #341b18; --warn: #d99a3a; --warn-tint: #33260f;
    --img: #ff6a33; --img-ink: #ff9a63; --img-tint: #3a2318;
    --txt: #5aa3d6; --txt-ink: #8cc3ea; --txt-tint: #142631;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 28px rgba(0,0,0,.45);
    color-scheme: dark;
  }
  /* Dark fix-ups for the few intentionally hard-coded (light) spots. */
  :root[data-theme="dark"] .banner { border-color: #6e342c; color: #f4b9b1; }
  :root[data-theme="dark"] .banner strong { color: #ffd6cf; }
  :root[data-theme="dark"] .toast { box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 22px 26px 64px; background: var(--bg); color: var(--ink-2);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; }
  b, strong { color: var(--ink); }
  .good { color: var(--good); } .bad { color: var(--bad); }
  .muted { color: var(--muted); }

  /* topbar */
  .topbar { position: sticky; top: 0; z-index: 200; display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; margin: -22px -26px 18px; padding: 14px 26px 12px; background: color-mix(in srgb, var(--bg) 94%, transparent);
    border-bottom: 1px solid var(--border); box-shadow: 0 5px 18px rgba(45,28,16,.06); backdrop-filter: blur(12px); }
  .brand { display: flex; align-items: center; gap: 12px; }
  .flame-dot { width: 14px; height: 14px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #ffd0a8, var(--flame) 55%, var(--flame-strong));
    box-shadow: 0 0 0 4px var(--flame-tint); flex: none; }
  .wordmark { margin: 0; font-size: 22px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
  .tagline { font-size: 12.5px; color: var(--muted); margin-top: 1px; max-width: 460px; }
  .controls { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }

  /* kill switch */
  .banner { display: block; margin: 0 0 8px; padding: 9px 13px; background: var(--bad-tint);
    border: 1px solid #f3b6af; border-radius: 9px; color: #9c2b20; font-size: 12px; max-width: 520px; }
  .banner strong { color: #8a2117; }
  .switch { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; justify-content: flex-end; }
  .switch-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
    padding: 3px 10px; border-radius: 999px; }
  .switch-state.on { color: var(--good); background: var(--good-tint); }
  .switch-state.off { color: var(--bad); background: var(--bad-tint); }
  .switch-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .switch-btn { background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong);
    padding: 6px 13px; cursor: pointer; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600;
    box-shadow: var(--shadow); }
  .switch-btn:hover { border-color: var(--flame); color: var(--flame-ink); }
  .hint { color: var(--muted); font-size: 11px; }
  .theme-btn { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
    padding: 5px 11px; cursor: pointer; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600;
    box-shadow: var(--shadow); display: inline-flex; align-items: center; gap: 6px; line-height: 1; }
  .theme-btn:hover { border-color: var(--flame); color: var(--flame-ink); }

  .page-nav { display: flex; align-items: center; gap: 5px; margin: -8px 0 14px; overflow-x: auto; }
  .page-nav a { color: var(--muted); text-decoration: none; font-size: 11.5px; font-weight: 650;
    white-space: nowrap; padding: 5px 9px; border-radius: 7px; }
  .page-nav a:hover { color: var(--flame-ink); background: var(--flame-tint); }
  .settings-shell { position: relative; }
  .settings-shell > .help-tip { position: absolute; z-index: 5; top: 8px; right: 12px; }
  .settings-panel { margin: 0 0 14px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; box-shadow: var(--shadow); }
  .settings-panel > summary { cursor: pointer; list-style: none; padding: 9px 13px; color: var(--ink-2);
    padding-right: 46px; font-size: 11.5px; font-weight: 650; }
  .settings-panel > summary::-webkit-details-marker { display: none; }
  .settings-panel > summary::before { content: '⚙'; margin-right: 7px; color: var(--muted); }
  .settings-panel[open] > summary { border-bottom: 1px solid var(--border); }
  .settings-panel > summary:focus-visible, .page-nav a:focus-visible, .text-link:focus-visible,
  .drawer > summary:focus-visible { outline: 2px solid var(--flame); outline-offset: 2px; }
  .settings-panel #frag-models { padding: 12px 13px 2px; }
  .settings-panel .models { margin-bottom: 10px; }

  /* Contextual help: native details works with mouse, keyboard, and touch. */
  .help-tip { position: relative; display: inline-flex; flex: none; font-size: 12px; }
  .help-tip[open] { z-index: 100; }
  .help-tip > summary { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px;
    list-style: none; cursor: help; user-select: none; color: var(--muted); background: var(--surface);
    border: 1px solid var(--border-strong); border-radius: 50%; font: 750 11px/1 var(--mono); }
  .help-tip > summary::-webkit-details-marker { display: none; }
  .help-tip > summary:hover, .help-tip > summary:focus-visible, .help-tip[open] > summary {
    color: var(--flame-ink); border-color: var(--flame); background: var(--flame-tint); outline: none; }
  .help-tip > summary:focus-visible { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--flame); }
  .help-popover { position: absolute; z-index: 110; top: calc(100% + 7px); left: 0; width: min(360px, calc(100vw - 44px));
    padding: 12px 13px; color: var(--ink-2); background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: 10px; box-shadow: 0 12px 36px rgba(45, 28, 16, .20); font-size: 11.5px; line-height: 1.45;
    text-align: left; text-transform: none; letter-spacing: normal; font-weight: 400; }
  :root[data-theme="dark"] .help-popover { box-shadow: 0 14px 40px rgba(0,0,0,.6); }
  .help-popover > strong { display: block; margin-bottom: 7px; color: var(--ink); font-size: 12.5px; }
  .help-popover p { margin: 6px 0 0; }
  .help-popover p b { color: var(--ink); }
  .field-label, .th-help, .hero-number-group { display: inline-flex; align-items: center; gap: 6px; }
  .th-help { justify-content: flex-end; white-space: nowrap; }
  .rtable .help-tip { vertical-align: middle; }
  .rtable .help-popover { position: fixed; top: 92px; right: 22px; left: auto; }
  .block-label-row, .title-help-row, .card-head-row, .section-title-row, .quota-head, .evidence-actions {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
  .block-label-row > .help-tip .help-popover, .title-help-row > .help-tip .help-popover,
  .card-head-row > .help-tip .help-popover, .section-title-row > .help-tip .help-popover,
  .quota-head > .help-tip .help-popover, .evidence-actions > .help-tip .help-popover,
  .settings-shell > .help-tip .help-popover { left: auto; right: 0; }
  .title-help-row { align-items: center; }
  .block-label-row .hero-eyebrow, .block-label-row .quality-label { margin-bottom: 0; }
  .hero > .block-label-row { margin-bottom: 8px; }
  .quota-head { align-items: center; margin-top: 12px; color: var(--ink-2); font-size: 11px; }
  @media (max-width: 520px) {
    .help-popover { position: fixed; top: 76px; left: 22px !important; right: 22px !important; width: auto;
      max-height: calc(100vh - 98px); overflow: auto; }
  }

  /* model chips */
  .models { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
  .models-label { color: var(--ink-2); font-size: 12px; font-weight: 600; }
  .models-csv { flex: 1 1 260px; min-width: 220px; color: var(--ink); background: var(--surface);
    border: 1px solid var(--border-strong); border-radius: 6px; padding: 4px 8px;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .models-csv:focus { outline: none; border-color: var(--flame-ink); }
  .models-routing { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
  #routing-help { border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface);
    color: var(--ink); max-width: 600px; padding: 16px 20px; }
  #routing-help::backdrop { background: rgba(20, 12, 6, .4); }
  #routing-help h3 { margin: 0 0 8px; font-size: 14px; color: var(--ink); }
  #routing-help p, #routing-help li { font-size: 12px; line-height: 1.55; color: var(--ink-2); margin: 6px 0; }
  #routing-help ul { margin: 6px 0; padding-left: 18px; }
  #routing-help code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
  #routing-help pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; margin: 8px 0; overflow-x: auto;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
  .chip { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
    border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 12px; }
  .chip:hover { border-color: var(--flame); color: var(--flame-ink); }
  .chip.on { background: var(--flame-tint); color: var(--flame-ink); border-color: var(--flame);
    font-weight: 600; }

  /* collapsed model-scope section (#116): the default compress scope is Fable 5
     only, so the three family rows stay hidden until the user opts in. The
     <details> wrapper lives in the static shell — NOT inside #frag-models —
     because the every-2s innerHTML poll would otherwise reset its open state. */
  .models-collapse { margin: 0 0 18px; }
  .models-collapse .models { margin: 0 0 10px; }
  .models-collapse .models:last-child { margin-bottom: 0; }
  .models-summary { cursor: pointer; color: var(--ink-2); font-size: 12px; font-weight: 600;
    margin: 0 0 8px; user-select: none; }
  .models-summary:hover { color: var(--flame-ink); }
  .models-warning { color: var(--ink-2); background: var(--surface); border: 1px solid var(--border-strong);
    border-left: 3px solid var(--bad); border-radius: 8px; padding: 8px 12px; font-size: 12px;
    margin: 0 0 12px; }

  /* session hero */
  #current-session { scroll-margin-top: 118px; }
  #frag-session { display: block; margin-bottom: 16px; }
  .hero { background: linear-gradient(135deg, var(--flame-tint), var(--surface) 60%); border: 1px solid var(--border);
    border-left: 4px solid var(--flame); border-radius: var(--radius); padding: 17px 20px; box-shadow: var(--shadow); }
  .hero-neg { border-left-color: var(--bad); }
  .hero-eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 8px; }
  .hero-headline { font-size: 22px; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; line-height: 1.15; }
  .hero-num { font-size: 40px; font-weight: 800; line-height: 1; margin-right: 7px;
    background: linear-gradient(135deg, #ff9a4d, var(--flame) 55%, var(--flame-strong));
    -webkit-background-clip: text; background-clip: text; color: transparent;
    font-variant-numeric: tabular-nums; }
  .hero-neg .hero-num { background: linear-gradient(135deg, #f0857a, var(--bad));
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero-sub { font-size: 14.5px; color: var(--ink-2); margin-top: 12px; max-width: 720px; }
  .hero-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    font-size: 12px; color: var(--muted); margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border-strong); }
  .session-follow { flex: none; padding: 4px 8px; color: var(--flame-ink); background: var(--surface); border: 1px solid var(--border-strong);
    border-radius: 6px; cursor: pointer; font: 650 10.5px/1.2 inherit; }
  .session-follow:hover, .session-follow:focus-visible { color: var(--flame-ink); border-color: var(--flame); outline: none; }
  .hero-empty .hero-headline { color: var(--muted); font-size: 24px; }

  /* Overview — one reading order: effect, activity, evidence. */
  .overview-panel { margin: 0 0 16px; padding: 20px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); scroll-margin-top: 118px; }
  .overview-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 15px; }
  .overview-head h2 { margin: 2px 0 3px; color: var(--ink); font-size: 20px; line-height: 1.2; letter-spacing: -.015em; }
  .overview-head p { margin: 0; color: var(--muted); font-size: 12px; }
  .collapsible-panel > summary { display: flex; align-items: center; justify-content: space-between; gap: 14px;
    list-style: none; cursor: pointer; user-select: none; }
  .collapsible-panel > summary::-webkit-details-marker { display: none; }
  .collapsible-panel > summary:focus-visible { outline: 2px solid var(--flame); outline-offset: 4px; }
  .collapsible-title { display: block; margin-top: 2px; color: var(--ink); font-size: 18px; font-weight: 750; line-height: 1.2; }
  .collapsible-actions { display: inline-flex; flex: none; align-items: center; gap: 8px; }
  .collapse-control { display: inline-flex; align-items: center; min-height: 25px; padding: 4px 9px; color: var(--muted);
    border: 1px solid var(--border-strong); border-radius: 999px; font-size: 10.5px; font-weight: 700; }
  .collapse-control::before { content: '▾'; margin-right: 5px; color: var(--flame); }
  .collapsible-panel:not([open]) .collapse-control::before { content: '▸'; }
  .when-closed { display: none; }
  .collapsible-panel:not([open]) .when-open { display: none; }
  .collapsible-panel:not([open]) .when-closed { display: inline; }
  .collapsible-content { padding-top: 15px; }
  .codex-panel > summary .scope-label { color: var(--txt); }
  @media (max-width: 660px) {
    .collapsible-panel > summary { align-items: flex-start; }
    .collapsible-actions { flex-direction: column; align-items: flex-end; gap: 5px; }
    .collapsible-actions .scope-chip, .collapsible-actions .codex-badge { font-size: 9.5px; }
  }
  .scope-label { color: var(--flame-ink); font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
  .scope-chip { flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px;
    border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 10.5px; white-space: nowrap; }
  .overview-grid { display: grid; grid-template-columns: minmax(360px, 1.7fr) repeat(2, minmax(210px, 1fr)); gap: 11px; }
  .outcome-card, .overview-card { min-width: 0; padding: 15px; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 11px; }
  .outcome-card { background: linear-gradient(135deg, var(--good-tint), var(--surface) 76%); border-left: 3px solid var(--good); }
  .outcome-card.negative { background: linear-gradient(135deg, var(--bad-tint), var(--surface) 76%); border-left-color: var(--bad); }
  .card-eyebrow { color: var(--muted); font-size: 10.5px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase; }
  .outcome-value, .overview-value { margin-top: 4px; color: var(--ink); font-size: 31px; font-weight: 820;
    line-height: 1.05; letter-spacing: -.025em; font-variant-numeric: tabular-nums; }
  .outcome-value { color: var(--good); }
  .outcome-card.negative .outcome-value { color: var(--bad); }
  .outcome-note { margin-top: 4px; color: var(--muted); font-size: 10.5px; }
  .effect-breakdown { display: grid; gap: 7px; margin-top: 13px; padding-top: 11px; border-top: 1px dashed var(--border-strong); }
  .effect-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .effect-row > span, .effect-row > strong { min-width: 0; }
  .effect-name { display: inline-flex; align-items: center; gap: 7px; }
  .effect-result { display: grid; justify-items: end; gap: 4px; text-align: right; }
  .effect-row b { display: block; font-size: 12px; }
  .effect-row small { display: block; color: var(--muted); font-size: 10px; font-weight: 400; }
  .effect-row strong { color: var(--ink); text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
  .effect-row em { display: block; color: var(--muted); font-size: 10.5px; font-style: normal; font-weight: 550; }
  .effect-row.measured em { color: var(--good); }
  .price-callout { display: inline-grid; justify-items: end; gap: 1px; padding: 5px 7px; background: var(--good-tint);
    border: 1px solid color-mix(in srgb, var(--good) 55%, var(--border)); border-radius: 7px; white-space: nowrap; }
  .price-callout small { color: var(--ink-2); font-size: 9.5px; font-weight: 650; }
  .price-value { color: var(--good); font-size: 20px; line-height: 1; font-weight: 850; }
  .price-callout em { color: var(--muted); font-size: 9.5px; font-weight: 600; }
  .overview-lines { display: grid; gap: 5px; margin: 12px 0 9px; font-size: 11.5px; }
  .overview-lines span { display: flex; justify-content: space-between; gap: 8px; color: var(--ink-2); }
  .overview-lines.compact span { display: block; }
  .overview-card > small { color: var(--muted); font-size: 10px; }
  .evidence-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .text-link { color: var(--flame-ink); font-size: 10.5px; font-weight: 650; text-decoration: none; }
  .text-link:hover { text-decoration: underline; }
  .reading-legend { display: flex; flex-wrap: wrap; gap: 7px 18px; margin-top: 12px; padding: 9px 11px;
    background: var(--surface-2); border-radius: 8px; color: var(--muted); font-size: 10.5px; }
  .reading-legend b { color: var(--ink-2); }
  @media (max-width: 1050px) { .overview-grid { grid-template-columns: 1fr 1fr; } .outcome-card { grid-column: 1 / -1; } }
  @media (max-width: 660px) {
    .overview-panel { padding: 15px; } .overview-head { flex-direction: column; }
    .overview-grid { grid-template-columns: 1fr; } .outcome-card { grid-column: auto; }
    .effect-row { align-items: flex-start; }
  }

  /* estimate quality — visible trust summary, not hidden in the math drawer */
  .quality-panel { margin: 0 0 14px; padding: 18px; background: linear-gradient(135deg, var(--good-tint), var(--surface) 68%);
    border: 1px solid var(--border); border-left: 4px solid var(--good); border-radius: var(--radius); box-shadow: var(--shadow); }
  .quality-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
  .quality-eyebrow { margin-bottom: 5px; color: var(--good); font-size: 10.5px; font-weight: 800;
    letter-spacing: .09em; text-transform: uppercase; }
  .quality-title { margin: 0; color: var(--ink); font-size: 18px; line-height: 1.25; letter-spacing: -.01em; }
  .quality-lead { max-width: 860px; margin: 7px 0 0; color: var(--ink-2); font-size: 12.5px; line-height: 1.5; }
  .quality-badge { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px;
    border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
  .quality-badge::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .quality-badge.good { color: var(--good); background: var(--good-tint); border: 1px solid currentColor; }
  .quality-badge.mixed { color: var(--warn); background: var(--warn-tint); border: 1px solid currentColor; }
  .quality-badge.waiting { color: var(--muted); background: var(--surface-2); border: 1px solid var(--border-strong); }
  .quality-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 15px; }
  .quality-metric { min-width: 0; padding: 11px 12px; background: color-mix(in srgb, var(--surface) 82%, transparent);
    border: 1px solid var(--border); border-radius: 9px; }
  .quality-label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 10.5px; font-weight: 700;
    letter-spacing: .03em; text-transform: uppercase; }
  .quality-metric strong { display: block; color: var(--ink); font-size: 16px; line-height: 1.25; font-variant-numeric: tabular-nums; }
  .quality-metric small { display: block; margin-top: 5px; color: var(--muted); font-size: 10.5px; line-height: 1.35; }
  .quality-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 7px 13px; margin-top: 13px; }
  .quality-check { color: var(--good); font-size: 11px; font-weight: 600; }
  .quality-excluded { margin-left: auto; color: var(--muted); font-size: 11px; }
  .quality-caveat { margin: 12px 0 0; padding-top: 10px; border-top: 1px dashed var(--border-strong);
    color: var(--muted); font-size: 11px; line-height: 1.45; }
  .quality-caveat strong { color: var(--ink-2); }
  @media (max-width: 1000px) { .quality-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 680px) {
    .quality-head { flex-direction: column; gap: 10px; }
    .quality-grid { grid-template-columns: 1fr; }
    .quality-excluded { width: 100%; margin-left: 0; }
  }

  /* exact Codex rollout usage — visually distinct from estimated savings */
  .codex-panel { margin: 0 0 14px; padding: 18px; background: linear-gradient(135deg, var(--txt-tint), var(--surface) 68%);
    border: 1px solid var(--border); border-left: 4px solid var(--txt); border-radius: var(--radius); box-shadow: var(--shadow);
    scroll-margin-top: 118px; }
  .codex-eyebrow { margin-bottom: 5px; color: var(--txt); font-size: 10.5px; font-weight: 800;
    letter-spacing: .09em; text-transform: uppercase; }
  .codex-badge { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px;
    color: var(--txt-ink); background: var(--txt-tint); border: 1px solid var(--txt); border-radius: 999px;
    font-size: 11px; font-weight: 700; white-space: nowrap; }
  .codex-badge::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--txt); }
  .usage-scope { margin-top: 11px; color: var(--muted); font-size: 10.5px; }
  .quota-list { display: grid; gap: 7px; margin-top: 11px; }
  .quota-row { display: grid; grid-template-columns: minmax(180px, 1.2fr) repeat(auto-fit, minmax(140px, 1fr)); gap: 10px;
    padding: 9px 11px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; }
  .quota-row > span { min-width: 0; }
  .quota-row small, .quota-row em { display: block; color: var(--muted); font-size: 9.5px; font-style: normal; }
  .quota-row b { display: block; color: var(--ink); font-size: 12px; font-variant-numeric: tabular-nums; }
  .quota-name small { font-family: var(--mono); }
  .quota-empty { color: var(--muted); font-size: 11px; padding: 9px; }
  @media (max-width: 680px) { .quota-row { grid-template-columns: 1fr 1fr; } .quota-name { grid-column: 1 / -1; } }

  /* drawer */
  .drawer { margin: 0 0 14px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: visible; scroll-margin-top: 118px; }
  .drawer > summary { cursor: pointer; user-select: none; list-style: none; padding: 12px 16px;
    font-size: 13px; font-weight: 600; color: var(--flame-ink); display: flex; align-items: center; gap: 8px; }
  .drawer > summary::-webkit-details-marker { display: none; }
  .drawer > summary::before { content: '▸'; color: var(--flame); font-size: 11px; }
  .drawer[open] > summary::before { content: '▾'; }
  .drawer > summary:hover { background: var(--surface-2); }
  .summary-q { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
    margin-left: auto; border: 1px solid var(--border-strong); border-radius: 50%; color: var(--muted);
    font: 750 10px/1 var(--mono); }
  .drawer-intro { padding: 0 16px 10px; font-size: 12px; color: var(--ink-2); }
  .drawer-intro em { color: var(--flame-ink); font-style: normal; font-weight: 600; }
  .math-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 0 16px 16px; }
  @media (max-width: 860px) { .math-grid { grid-template-columns: 1fr; } }
  .math-block h4 { margin: 0 0 6px; font-size: 12px; color: var(--ink); }
  .formula { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 11px; font: 11px/1.55 var(--mono); color: var(--ink-2); white-space: pre-wrap;
    word-break: break-word; }
  .formula .k { color: var(--muted); } .formula .v { color: var(--ink); } .formula .op { color: var(--flame); }
  .formula .sp { height: 6px; }
  .formula .src { color: var(--muted); font-size: 10px; display: block; margin-top: 7px;
    border-top: 1px solid var(--border); padding-top: 6px; }
  .updated { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }

  /* sections */
  .section { margin-top: 26px; }
  .section-head { font-size: 14px; font-weight: 700; color: var(--ink); margin: 0 0 12px;
    display: flex; align-items: baseline; gap: 10px; }
  .section-sub { font-size: 12px; font-weight: 400; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 18px; box-shadow: var(--shadow); min-width: 0; }
  .card-head { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); margin: 0 0 12px; }
  .card-head-row > .card-head { margin-bottom: 12px; }
  .card-head-row.spaced { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border); }
  .card-head-row.spaced > .card-head { margin-bottom: 12px; }
  .section-title-row { align-items: baseline; }
  .section-title-row > .section-head { flex: 1; }

  /* x-ray */
  .xray { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 1000px) { .xray { grid-template-columns: 1fr; } }

  /* context map */
  .ctxmap { font-size: 13px; }
  .empty-note { color: var(--muted); font-size: 12.5px; padding: 14px; background: var(--surface-2);
    border: 1px dashed var(--border-strong); border-radius: 10px; }
  .ctx-headline { font-size: 13px; color: var(--ink-2); margin-bottom: 10px; }
  .ctx-title { display: inline-block; font-weight: 700; color: var(--ink); margin-right: 6px; }
  .ctx-big { font-size: 22px; font-weight: 800; color: var(--flame); font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 8px; margin-bottom: 10px; }
  .tag { font-size: 11px; font-weight: 600; padding: 3px 9px 3px 22px; border-radius: 999px; position: relative; }
  .tag::before { content: ''; position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
    width: 8px; height: 8px; border-radius: 2px; }
  .tag-img { background: var(--img-tint); color: var(--img-ink); }
  .tag-img::before { background: var(--img); }
  .tag-txt { background: var(--txt-tint); color: var(--txt-ink); }
  .tag-txt::before { background: var(--txt); }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 560px) { .split { grid-template-columns: 1fr; } }
  .split-col { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--surface); }
  .split-img { border-top: 3px solid var(--img); background: linear-gradient(180deg, var(--img-tint), var(--surface) 40%); }
  .split-txt { border-top: 3px solid var(--txt); background: linear-gradient(180deg, var(--txt-tint), var(--surface) 40%); }
  .split-head { font-size: 12px; font-weight: 700; color: var(--ink); margin-bottom: 8px; display: flex;
    flex-direction: column; gap: 2px; }
  .split-sum { font-size: 10.5px; font-weight: 600; color: var(--muted); }
  .ctx-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; padding: 4px 0;
    border-bottom: 1px solid var(--border); }
  .ctx-row:last-of-type { border-bottom: none; }
  .ctx-lbl { color: var(--ink-2); } .ctx-val { color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted-row { color: var(--muted); font-style: italic; }
  .split-note { font-size: 10.5px; color: var(--muted); margin-top: 7px; }
  .pages-title { font-size: 11px; color: var(--ink-2); margin: 12px 0 6px; }
  .pages { display: flex; flex-wrap: wrap; gap: 6px; max-height: 320px; overflow: auto;
    background: var(--surface-2); padding: 6px; border: 1px solid var(--border); border-radius: 8px; }
  .page { height: 130px; width: auto; max-width: 230px; object-fit: contain; object-position: top left;
    image-rendering: pixelated; background: #fff; border: 1px solid var(--border-strong); border-radius: 4px;
    cursor: pointer; transition: border-color .12s, transform .12s; }
  .page:hover { border-color: var(--flame); transform: translateY(-1px); }
  .page.page-gone { width: 150px; height: 56px; background: var(--surface-2); border: 1px dashed var(--border-strong);
    color: var(--muted); font-size: 10px; cursor: default; }

  /* recent requests */
  .row-view { padding: 0; color: var(--flame-ink); background: transparent; border: 0; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .row-view:hover { text-decoration: underline; }
  table.rtable, table.dtable { width: 100%; border-collapse: collapse; font-size: 12px; }
  .rtable th, .dtable th { text-align: left; color: var(--muted); font-weight: 600; padding: 7px 8px;
    border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
  .rtable td, .dtable td { padding: 7px 8px; border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums; vertical-align: middle; color: var(--ink-2); }
  .rtable tr:last-child td, .dtable tr:last-child td { border-bottom: none; }
  .rtable tbody tr:hover, .rtable tbody tr:hover { background: var(--surface-2); }
  /* Keep wide tables inside their card: scroll horizontally rather than
     pushing the card border out. Fires only when the nowrap columns exceed
     the card width (narrow x-ray column / small window); no scrollbar when
     they fit. The table keeps width:100% so it fills at wide widths. */
  #frag-recent, #frag-stats { overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
  #frag-recent table, #frag-stats table { min-width: max-content; }
  #frag-latest { overflow: auto; scrollbar-width: thin; }
  th.num, td.num { text-align: right; }
  td.pos { color: var(--good); font-weight: 600; }
  td.neg { color: var(--bad); font-weight: 600; }
  .endp { color: var(--ink); font-family: var(--mono); font-size: 11px; }
  .empty-cell { color: var(--muted); text-align: center; padding: 18px; }
  .pill { display: inline-block; min-width: 38px; text-align: center; font-size: 11px; font-weight: 700;
    padding: 2px 8px; border-radius: 999px; font-variant-numeric: tabular-nums; }
  .pill-good { background: var(--good-tint); color: var(--good); }
  .pill-warn { background: var(--warn-tint); color: var(--warn); }
  .pill-bad { background: var(--bad-tint); color: var(--bad); }
  .badge { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .mk-create { font-size: 9.5px; font-weight: 700; color: var(--muted); border: 1px solid var(--muted);
    border-radius: 999px; padding: 0 5px; margin-left: 4px; vertical-align: 1px; cursor: help; white-space: nowrap; }
  .badge-img { background: var(--img-tint); color: var(--img-ink); }
  .badge-txt { background: var(--txt-tint); color: var(--txt-ink); }

  /* inspector */
  .viewer-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .mini-btn { font-size: 11px; background: var(--surface); color: var(--flame-ink); border: 1px solid var(--border-strong);
    border-radius: 7px; padding: 3px 9px; cursor: pointer; font-weight: 600; }
  .mini-btn:hover { border-color: var(--flame); }
  .mini-label { font-size: 11px; color: var(--muted); }
  .frame { background: #fff; border: 1px solid var(--border-strong); border-radius: 8px; padding: 5px;
    overflow: auto; max-height: 360px; scrollbar-width: thin; }
  .frame img { display: block; width: auto; height: auto; max-width: none; image-rendering: pixelated; }
  .frame-sm { max-height: 260px; }
  .viewer-caption { font-size: 11px; color: var(--muted); margin-top: 8px; display: flex; align-items: center;
    gap: 10px; flex-wrap: wrap; }
  .pairing { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 10px; }
  .pair-head { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 6px; display: inline-block;
    margin-bottom: 6px; }
  .pair-img { background: var(--img-tint); color: var(--img-ink); }
  .pair-txt { background: var(--txt-tint); color: var(--txt-ink); }
  .pair-mid { font-size: 11px; font-weight: 600; color: var(--muted); text-align: center; }
  .src-pane { margin: 0; max-height: 280px; overflow: auto; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 8px; padding: 9px; font: 11px/1.45 var(--mono);
    white-space: pre-wrap; word-break: break-word; color: var(--ink-2); }
  .evicted { font-size: 11.5px; color: var(--muted); padding: 12px; background: var(--surface-2);
    border: 1px dashed var(--border-strong); border-radius: 8px; }

  /* sessions bars */
  .status { margin-bottom: 12px; color: var(--muted); font-size: 12px; }
  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
  .bar-label { width: 150px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--ink); font-family: var(--mono); font-size: 11px; }
  .bar-track { flex: 1; min-width: 0; height: 16px; background: var(--surface-2); border-radius: 5px;
    overflow: hidden; border: 1px solid var(--border); }
  .bar-fill { height: 100%; border-radius: 5px 0 0 5px;
    background: linear-gradient(90deg, #ffa766, var(--flame)); }
  .bar-val { width: 78px; flex: none; text-align: right; font-variant-numeric: tabular-nums;
    color: var(--flame-ink); font-weight: 600; }
  .bar-val.neg { color: var(--bad); }
  .axis { margin-top: 12px; color: var(--muted); font-size: 11px; }
  .empty { text-align: center; color: var(--muted); padding: 22px; font-size: 12px; }

  /* toast tray */
  .tray { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px;
    z-index: 1000; pointer-events: none; }
  .toast { background: var(--surface); color: var(--bad); border: 1px solid #f0b3ab; border-radius: 9px;
    padding: 10px 14px; font-size: 12px; box-shadow: 0 8px 24px rgba(60,35,15,.14); display: flex;
    align-items: center; gap: 12px; pointer-events: auto; max-width: 360px; }
  .toast button { background: transparent; color: inherit; border: 0; cursor: pointer; font-size: 16px;
    line-height: 1; padding: 0; }
`;

// Client glue: window.pp (pin+source state) → hx-vals; preserves <details> open state across swaps; routes htmx errors to toast tray.
const GLUE_JS = `
  window.pp = { pin: null, src: false, session: null, hashRevealPending: !!location.hash };
  function ppPin(id) {
    window.pp.pin = id;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  function ppSource(on) {
    window.pp.src = on;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  function ppWatchLatest() {
    window.pp.session = null;
    htmx.trigger('#frag-session', 'pp-refresh');
  }
  document.body.addEventListener('htmx:beforeSwap', function (ev) {
    const states = [];
    ev.detail.target.querySelectorAll('details[id]').forEach(function (d) {
      states.push({ id: d.id, open: d.open });
    });
    ev.detail.target.__ppDetails = states;
  });
  document.body.addEventListener('htmx:afterSwap', function (ev) {
    (ev.detail.target.__ppDetails || []).forEach(function (state) {
      const d = document.getElementById(state.id);
      if (d) d.toggleAttribute('open', state.open);
    });
    if (window.pp.hashRevealPending) ppRevealHash();
    if (ev.detail.target && ev.detail.target.id === 'frag-session') {
      var sessionNode = ev.detail.target.querySelector('[data-session-id]');
      var sessionId = sessionNode && sessionNode.getAttribute('data-session-id');
      if (sessionId && sessionId !== window.pp.session) window.pp.session = sessionId;
    }
  });
  function ppRevealHash() {
    if (!location.hash || location.hash.length < 2) { window.pp.hashRevealPending = false; return; }
    var target = document.getElementById(location.hash.slice(1));
    if (!target) return false;
    if (target.tagName === 'DETAILS') target.setAttribute('open', '');
    requestAnimationFrame(function () { target.scrollIntoView({ block: 'start' }); });
    window.pp.hashRevealPending = false;
    return true;
  }
  document.body.addEventListener('click', function (ev) {
    var link = ev.target.closest && ev.target.closest('a[href^="#"]');
    if (link) { window.pp.hashRevealPending = true; setTimeout(ppRevealHash, 0); }
    if (!(ev.target.closest && ev.target.closest('.help-tip'))) {
      document.querySelectorAll('details.help-tip[open]').forEach(function (d) { d.removeAttribute('open'); });
    }
  });
  document.addEventListener('toggle', function (ev) {
    var opened = ev.target;
    if (!opened.matches || !opened.matches('details.help-tip[open]')) return;
    document.querySelectorAll('details.help-tip[open]').forEach(function (d) {
      if (d !== opened) d.removeAttribute('open');
    });
  }, true);
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    document.querySelectorAll('details.help-tip[open]').forEach(function (d) { d.removeAttribute('open'); });
  });
  window.addEventListener('hashchange', function () { window.pp.hashRevealPending = true; ppRevealHash(); });
  document.body.addEventListener('htmx:responseError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: ev.detail.xhr.status + ' ' + ev.detail.requestConfig.path }
    }));
  });
  document.body.addEventListener('htmx:sendError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: 'proxy unreachable: ' + ev.detail.requestConfig.path }
    }));
  });
`;

// Theme: light/dark via data-theme on <html>; saved in localStorage, defaults to system pref.
const THEME_JS = `
  (function () {
    function apply(t) {
      document.documentElement.dataset.theme = t;
      var b = document.getElementById('theme-btn');
      if (b) {
        b.textContent = t === 'dark' ? '☀ Light' : '☾ Dark';
        b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      }
    }
    window.ppTheme = function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('pp-theme', next); } catch (e) {}
      apply(next);
    };
    apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  })();
`;

export function renderPage(port: number): string {
  // hx-trigger="load, every Ns": paint on load then poll (2s live, 5s aggregates).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pxpipe — live dashboard</title>
<link rel="icon" href="${FAVICON}" />
<style>${CSS}</style>
<script>
  // Set theme before first paint (no flash): saved choice wins, else system preference.
  (function () {
    try {
      var s = localStorage.getItem('pp-theme');
      var dark = s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } catch (e) { document.documentElement.dataset.theme = 'light'; }
  })();
</script>
</head>
<body>

<header class="topbar">
  <div class="brand">
    <span class="flame-dot"></span>
    <div>
      <h1 class="wordmark">pxpipe</h1>
      <div class="tagline">Live proxy effect, provider usage, and an auditable explanation of every estimate.</div>
    </div>
  </div>
  <div class="controls">
    <button type="button" id="theme-btn" class="theme-btn" onclick="ppTheme()" aria-label="Toggle dark mode" title="Toggle dark / light mode">☾ Dark</button>
    <div id="frag-toggle" hx-get="/fragments/toggle" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
  </div>
</header>


<details class="models-collapse">
  <summary class="models-summary">Connect an agent <span class="hint">warp launches any CLI through this proxy · pin keeps instructions last in the request</span></summary>
  <p>Warp starts the agent with the proxy already wired:</p>
  <pre>pxpipe warp -- claude
pxpipe warp -- codex
pxpipe warp -- cursor-agent</pre>
  <p>Pin instructions from inside a session with <code>@pxpipe pin …</code>; pinned text is relocated to the end of every request.</p>
</details>

<nav class="page-nav" aria-label="Dashboard sections">
  <a href="#overview">Overview</a>
  <a href="#current-session">Current session</a>
  <a href="#requests">Requests</a>
  <a href="#usage-limits">Usage &amp; limits</a>
  <a href="#audit-drawer">Audit</a>
</nav>


<div class="settings-shell">
  <details class="settings-panel">
    <summary>Model scope &amp; routing settings</summary>
    <div id="frag-models" hx-get="/fragments/models" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
  </details>
  ${helpTip(
    'model-settings', 'Model scope and routing settings',
    'Runtime controls for choosing which model bases PXPIPE may transform.',
    'They let you opt models in or out without changing upstream routing or restarting the proxy.',
    'Checked chips are active now. Your choice is saved automatically and survives restart, overriding PXPIPE_MODELS until you press Reset to default.',
  )}
</div>

<div id="current-session"><div id="frag-session" hx-get="/fragments/session-summary" hx-trigger="load, every 2s, pp-refresh" hx-swap="innerHTML"
  hx-vals='js:{session: window.pp.session || ""}'>
  <div class="hero hero-empty"><div class="hero-headline">Connecting…</div></div>
</div></div>

<div id="frag-header" hx-get="/fragments/header" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>

<section class="section" id="requests">
  <h2 class="section-head">What happened to your context <span class="section-sub">click a request to see image vs text</span></h2>
  <div class="xray">
    <div class="card">
      <div class="card-head-row"><h3 class="card-head">Recent requests</h3>${helpTip(
        'recent-requests', 'Recent requests',
        'The latest proxy responses with model, status, path, usage, and attributed input change.',
        'It connects summary totals to individual requests so unusual rows can be inspected.',
        'Use status and path first, then compare actual and baseline values. Open Details to inspect the exact image-versus-text composition.',
      )}</div>
      <div id="frag-recent" hx-get="/fragments/recent" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
    </div>
    <div class="card">
      <div class="card-head-row"><h3 class="card-head">Image vs text breakdown</h3>${helpTip(
        'context-breakdown', 'Image versus text breakdown',
        'A request-level map of which context buckets stayed native text and which were rendered into images.',
        'It explains where the estimated input change came from instead of showing only a final number.',
        'Compare the image and text columns. Cache-aware effective input drives savings; raw token counts are supporting diagnostics.',
      )}</div>
      <div id="frag-context-map" hx-get="/fragments/context-map" hx-trigger="load" hx-swap="innerHTML"></div>
      <div class="card-head-row spaced"><h3 class="card-head">Image ↔ source inspector</h3>${helpTip(
        'source-inspector', 'Image and source inspector',
        'A visual preview of the PNG sent to the model, optionally paired with the source text used to create it.',
        'It lets you verify fidelity, layout, and source-to-image pairing for a concrete request.',
        'Select a recent request, inspect each page, and enable source view when you need to compare content. Previews can disappear after ring-buffer eviction or restart.',
      )}</div>
      <div id="frag-latest" hx-get="/fragments/latest" hx-trigger="load, every 2s, pp-refresh" hx-swap="innerHTML"
           hx-vals='js:{pin: window.pp.pin == null ? "" : window.pp.pin, source: window.pp.src ? "1" : ""}'></div>
    </div>
  </div>
</section>

<section class="section" id="sessions">
  <div class="section-title-row"><h2 class="section-head">Top sessions <span class="section-sub">by tokens saved</span></h2>${helpTip(
    'top-sessions', 'Top sessions',
    'A ranking of retained PXPIPE sessions by their accumulated estimated input change.',
    'It reveals which conversations contribute most to the total and where investigation is most useful.',
    'Longer bars mean larger positive estimated reduction. Negative values indicate sessions where imaging cost more effective input than the text counterfactual.',
  )}</div>
  <div class="card">
    <div id="frag-sessions" hx-get="/fragments/sessions" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
  </div>
</section>

<section class="section" id="history">
  <div class="section-title-row"><h2 class="section-head">Full history <span class="section-sub">every event on disk</span></h2>${helpTip(
    'full-history', 'Full history',
    'The event log PXPIPE retained on disk, including successful, passthrough, and error events.',
    'It is the durable audit trail behind session and request diagnostics.',
    'Use it for completeness and troubleshooting rather than headline savings. Rows without upstream usage may be operational events and are not paid LLM responses.',
  )}</div>
  <div class="card">
    <div id="frag-stats" hx-get="/fragments/stats" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
  </div>
</section>

<div class="tray" x-data="{ toasts: [], next: 1 }"
     @pp-toast.window="const id = next++; toasts.push({ id, text: $event.detail.text }); setTimeout(() => toasts = toasts.filter(t => t.id !== id), 5000)">
  <template x-for="t in toasts" :key="t.id">
    <div class="toast"><span x-text="t.text"></span><button type="button" @click="toasts = toasts.filter(x => x.id !== t.id)" aria-label="dismiss">&times;</button></div>
  </template>
</div>

<script>${HTMX_JS}</script>
<script>${GLUE_JS}</script>
<script>${THEME_JS}</script>
<script>${ALPINE_JS}</script>
</body>
</html>`;
}
