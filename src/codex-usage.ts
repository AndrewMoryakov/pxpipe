/**
 * Exact Codex usage imported from the official local rollout logs.
 *
 * Codex persists provider-reported TokenCount snapshots under
 *   $CODEX_HOME/sessions/<date>/rollout-*.jsonl
 * Community usage tools use the same source. We only index sessions whose
 * session_meta.model_provider is `pxpipe`, keep no prompts or response text,
 * and expose aggregate token/rate-limit telemetry to the local dashboard.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

export interface CodexTokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

export interface CodexRateLimits {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  observedAt: string | null;
}

export interface CodexQuotaWindow extends CodexRateLimitWindow {
  limitId: string | null;
  limitName: string | null;
  observedAt: string | null;
}

/** Quota windows belonging to one provider-reported limit. */
export interface CodexQuotaGroup {
  limitId: string | null;
  limitName: string | null;
  /** Latest observation for each duration, sorted shortest first. */
  windows: CodexQuotaWindow[];
}

export interface CodexUsageSnapshot extends CodexTokenBreakdown {
  source: string;
  loading: boolean;
  error: string | null;
  sessionFiles: number;
  usageSnapshots: number;
  modelContextWindow: number | null;
  earliestEventAt: string | null;
  latestEventAt: string | null;
  rateLimits: CodexRateLimits | null;
  /** Latest observation for each reported window duration (e.g. 300m, 10080m). */
  quotaWindows: CodexQuotaWindow[];
}

interface RawTokenUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

interface FileSummary extends CodexTokenBreakdown {
  usageSnapshots: number;
  modelContextWindow: number | null;
  earliestEventAt: string | null;
  latestEventAt: string | null;
  rateLimits: CodexRateLimits | null;
  quotaWindows: CodexQuotaWindow[];
}

interface FileState {
  provider: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Byte offset already read from the file. */
  offset: number;
  /** Bytes after the most recent newline, retained until the JSONL row is complete. */
  pending: Buffer;
  /** A small observed suffix used to distinguish append from in-place replacement. */
  tail: Buffer;
  parseState: ParseState | null;
  summary: FileSummary | null;
}

interface ParseState extends FileSummary {
  seenTotals: Set<string>;
  previousTotal: CodexTokenBreakdown | null;
  quotaByMinutes: Map<string, CodexQuotaWindow>;
}

const EMPTY_BREAKDOWN: CodexTokenBreakdown = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

function emptyParseState(): ParseState {
  return {
    ...EMPTY_BREAKDOWN,
    usageSnapshots: 0,
    modelContextWindow: null,
    earliestEventAt: null,
    latestEventAt: null,
    rateLimits: null,
    quotaWindows: [],
    seenTotals: new Set(),
    previousTotal: null,
    quotaByMinutes: new Map(),
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function tokenBreakdown(value: unknown): CodexTokenBreakdown | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as RawTokenUsage;
  return {
    inputTokens: finiteNumber(u.input_tokens),
    cachedInputTokens: finiteNumber(u.cached_input_tokens),
    outputTokens: finiteNumber(u.output_tokens),
    reasoningOutputTokens: finiteNumber(u.reasoning_output_tokens),
    totalTokens: finiteNumber(u.total_tokens),
  };
}

function subtractBreakdown(
  current: CodexTokenBreakdown,
  previous: CodexTokenBreakdown | null,
): CodexTokenBreakdown {
  return {
    inputTokens: Math.max(0, current.inputTokens - (previous?.inputTokens ?? 0)),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - (previous?.cachedInputTokens ?? 0)),
    outputTokens: Math.max(0, current.outputTokens - (previous?.outputTokens ?? 0)),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - (previous?.reasoningOutputTokens ?? 0)),
    totalTokens: Math.max(0, current.totalTokens - (previous?.totalTokens ?? 0)),
  };
}

function totalKey(u: CodexTokenBreakdown): string {
  return [u.inputTokens, u.cachedInputTokens, u.outputTokens, u.reasoningOutputTokens, u.totalTokens].join(':');
}

function rateWindow(value: unknown): CodexRateLimitWindow | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.used_percent !== 'number') return null;
  return {
    usedPercent: finiteNumber(v.used_percent),
    windowMinutes: finiteNumber(v.window_minutes),
    resetsAt: finiteNumber(v.resets_at),
  };
}

function parseRateLimits(value: unknown, observedAt: string | null): CodexRateLimits | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const primary = rateWindow(r.primary);
  const secondary = rateWindow(r.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: typeof r.limit_id === 'string' ? r.limit_id : null,
    limitName: typeof r.limit_name === 'string' ? r.limit_name : null,
    primary,
    secondary,
    planType: typeof r.plan_type === 'string' ? r.plan_type : null,
    observedAt,
  };
}

function recordQuotaWindows(state: ParseState, limits: CodexRateLimits): void {
  for (const window of [limits.primary, limits.secondary]) {
    if (!window || window.windowMinutes <= 0) continue;
    const candidate: CodexQuotaWindow = {
      ...window,
      limitId: limits.limitId,
      limitName: limits.limitName,
      observedAt: limits.observedAt,
    };
    const limitKey = limits.limitId !== null
      ? `id:${limits.limitId}`
      : `name:${limits.limitName ?? ''}`;
    const key = `${limitKey}:${window.windowMinutes}`;
    const previous = state.quotaByMinutes.get(key);
    if (!previous || (candidate.observedAt ?? '') >= (previous.observedAt ?? '')) {
      state.quotaByMinutes.set(key, candidate);
    }
  }
  state.quotaWindows = [...state.quotaByMinutes.values()]
    .sort((a, b) => a.windowMinutes - b.windowMinutes);
}

/**
 * Group quota windows without allowing equal-duration windows from different
 * provider limits to be presented as one quota. Unknown ids are kept apart by
 * their provider-reported names when available.
 */
export function groupCodexQuotaWindows(windows: Iterable<CodexQuotaWindow>): CodexQuotaGroup[] {
  const groups = new Map<string, {
    limitId: string | null;
    limitName: string | null;
    observedAt: string;
    byMinutes: Map<number, CodexQuotaWindow>;
  }>();

  for (const window of windows) {
    const key = window.limitId !== null
      ? `id:${window.limitId}`
      : `name:${window.limitName ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        limitId: window.limitId,
        limitName: window.limitName,
        observedAt: window.observedAt ?? '',
        byMinutes: new Map(),
      };
      groups.set(key, group);
    } else if ((window.observedAt ?? '') >= group.observedAt) {
      group.limitName = window.limitName;
      group.observedAt = window.observedAt ?? '';
    }
    const previous = group.byMinutes.get(window.windowMinutes);
    if (!previous || (window.observedAt ?? '') >= (previous.observedAt ?? '')) {
      group.byMinutes.set(window.windowMinutes, window);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      limitId: group.limitId,
      limitName: group.limitName,
      windows: [...group.byMinutes.values()].sort((a, b) => a.windowMinutes - b.windowMinutes),
    }))
    .sort((a, b) => (a.limitName ?? a.limitId ?? '').localeCompare(b.limitName ?? b.limitId ?? ''));
}

/** Apply one rollout JSONL line. Exported for focused schema/dedup tests. */
function applyCodexUsageLine(state: ParseState, line: string): boolean {
  // Avoid parsing prompt/response records entirely. TokenCount rows are small,
  // and this fast gate keeps indexing both cheaper and less privacy-invasive.
  if (!line.includes('"token_count"')) return false;
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return false;
  }
  // A true return means that a non-newline-terminated tail was nevertheless
  // a complete JSON value and can be committed. It does not mean it carried
  // a usable TokenCount payload.
  if (!row || typeof row !== 'object') return true;
  const obj = row as Record<string, unknown>;
  if (obj.type !== 'event_msg' || !obj.payload || typeof obj.payload !== 'object') return true;
  const payload = obj.payload as Record<string, unknown>;
  if (payload.type !== 'token_count' || !payload.info || typeof payload.info !== 'object') return true;
  const info = payload.info as Record<string, unknown>;
  const total = tokenBreakdown(info.total_token_usage);
  if (!total) return true;

  // Status refreshes often repeat the cumulative token total while carrying
  // newer quota percentages/reset times. Metadata must advance independently
  // of token deduplication or the dashboard can show a stale quota window.
  if (typeof info.model_context_window === 'number' && Number.isFinite(info.model_context_window)) {
    state.modelContextWindow = info.model_context_window;
  }
  const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  if (timestamp && (!state.earliestEventAt || timestamp < state.earliestEventAt)) {
    state.earliestEventAt = timestamp;
  }
  if (timestamp && (!state.latestEventAt || timestamp > state.latestEventAt)) {
    state.latestEventAt = timestamp;
  }
  const limits = parseRateLimits(payload.rate_limits, timestamp);
  if (limits) {
    state.rateLimits = newerRateLimits(state.rateLimits, limits);
    recordQuotaWindows(state, limits);
  }

  const key = totalKey(total);
  if (state.seenTotals.has(key)) return true; // Codex emits duplicate status snapshots.
  state.seenTotals.add(key);

  const last = tokenBreakdown(info.last_token_usage);
  const delta = last ?? subtractBreakdown(total, state.previousTotal);
  state.previousTotal = total;
  state.inputTokens += delta.inputTokens;
  state.cachedInputTokens += delta.cachedInputTokens;
  state.outputTokens += delta.outputTokens;
  state.reasoningOutputTokens += delta.reasoningOutputTokens;
  state.totalTokens += delta.totalTokens;
  state.usageSnapshots += 1;
  return true;
}

function summaryFromParseState(state: ParseState): FileSummary {
  const { seenTotals: _seen, previousTotal: _previous, quotaByMinutes: _quota, ...summary } = state;
  return summary;
}

/** Parse an in-memory fixture; production uses the streaming file variant. */
export function summarizeCodexRolloutLines(lines: Iterable<string>): FileSummary {
  const state = emptyParseState();
  for (const line of lines) applyCodexUsageLine(state, line);
  return summaryFromParseState(state);
}

async function firstSessionProvider(file: string): Promise<string> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // session_meta can carry a large base_instructions string. Extract only
      // the non-sensitive provider discriminator instead of JSON-parsing it.
      const match = /"model_provider"\s*:\s*"([^"\\]{1,80})"/.exec(line);
      if (match) return match[1]!;
      break;
    }
    return 'unknown';
  } finally {
    rl.close();
    stream.destroy();
  }
}

const FILE_TAIL_BYTES = 256;

async function readFileRange(file: string, start: number, endExclusive: number): Promise<Buffer> {
  if (endExclusive <= start) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  const stream = fs.createReadStream(file, { start, end: endExclusive - 1 });
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function applyRolloutBytes(state: ParseState, bytes: Buffer): number {
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue;
    let lineEnd = i;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd -= 1;
    applyCodexUsageLine(state, bytes.toString('utf8', lineStart, lineEnd));
    lineStart = i + 1;
  }

  if (lineStart < bytes.length) {
    // Codex normally terminates every JSONL row with LF. Still accept a final
    // complete token_count JSON value, while retaining an incomplete write for
    // the next refresh. Non-token rows stay pending until their newline so we
    // never JSON.parse large prompt/response records merely to detect EOF.
    const tail = bytes.toString('utf8', lineStart);
    if (applyCodexUsageLine(state, tail)) return bytes.length;
  }
  return lineStart;
}

function updateObservedTail(state: FileState, observed: Buffer): void {
  if (observed.length === 0) return;
  const combined = state.tail.length > 0 ? Buffer.concat([state.tail, observed]) : observed;
  state.tail = Buffer.from(combined.subarray(Math.max(0, combined.length - FILE_TAIL_BYTES)));
}

async function observedTailMatches(file: string, state: FileState): Promise<boolean> {
  if (state.tail.length === 0) return true;
  if (state.offset < state.tail.length) return false;
  const actual = await readFileRange(file, state.offset - state.tail.length, state.offset);
  return actual.equals(state.tail);
}

async function appendRolloutFile(file: string, state: FileState, size: number): Promise<void> {
  const parseState = state.parseState ?? emptyParseState();
  state.parseState = parseState;
  const bytes = await readFileRange(file, state.offset, size);
  const candidate = state.pending.length > 0 ? Buffer.concat([state.pending, bytes]) : bytes;
  const consumed = applyRolloutBytes(parseState, candidate);
  // Copy the usually tiny partial row so a slice does not retain a large
  // candidate allocation after complete rows have already been consumed.
  state.pending = Buffer.from(candidate.subarray(consumed));
  updateObservedTail(state, bytes);
  state.offset += bytes.length;
  state.summary = summaryFromParseState(parseState);
}

function freshFileState(provider: string, stat: fs.Stats): FileState {
  return {
    provider,
    dev: stat.dev,
    ino: stat.ino,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    pending: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    parseState: provider === 'pxpipe' ? emptyParseState() : null,
    summary: null,
  };
}

function fileIdentityChanged(state: FileState, stat: fs.Stats): boolean {
  return state.dev !== stat.dev || state.ino !== stat.ino;
}

async function rolloutFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(child);
    }
  };
  await walk(dir);
  return out;
}

function newerRateLimits(a: CodexRateLimits | null, b: CodexRateLimits | null): CodexRateLimits | null {
  if (!a) return b;
  if (!b) return a;
  return (b.observedAt ?? '') > (a.observedAt ?? '') ? b : a;
}

export function resolveCodexSessionsDir(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

export class CodexUsageIndex {
  private readonly states = new Map<string, FileState>();
  private refreshing = false;
  private timer: NodeJS.Timeout | null = null;
  private current: CodexUsageSnapshot;

  constructor(private readonly sessionsDir = resolveCodexSessionsDir()) {
    this.current = {
      ...EMPTY_BREAKDOWN,
      source: 'retained local Codex rollout logs',
      loading: true,
      error: null,
      sessionFiles: 0,
      usageSnapshots: 0,
      modelContextWindow: null,
      earliestEventAt: null,
      latestEventAt: null,
      rateLimits: null,
      quotaWindows: [],
    };
  }

  start(intervalMs = 10_000): void {
    void this.refresh();
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): CodexUsageSnapshot {
    return structuredClone(this.current);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const files = await rolloutFiles(this.sessionsDir);
      const found = new Set(files);
      for (const known of this.states.keys()) {
        if (!found.has(known)) this.states.delete(known);
      }

      for (const file of files) {
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        let state = this.states.get(file);
        if (!state) {
          const provider = await firstSessionProvider(file);
          // Remember the observed file revision even when session_meta is not
          // readable yet. Active rollouts can briefly exist as an empty or
          // partial file; an `unknown` provider must be retried after the file
          // grows instead of being excluded for the lifetime of the process.
          state = freshFileState(provider, stat);
          this.states.set(file, state);
        } else {
          const identityChanged = fileIdentityChanged(state, stat);
          const shrank = stat.size < state.size;
          const sameSizeRewrite = stat.size === state.size && stat.mtimeMs !== state.mtimeMs;
          let prefixChanged = false;
          if (!identityChanged && !shrank && stat.size > state.size && state.provider === 'pxpipe') {
            prefixChanged = !(await observedTailMatches(file, state));
          }
          if (identityChanged || shrank || sameSizeRewrite || prefixChanged) {
            // Truncate, atomic replace, and in-place rewrites invalidate both
            // cumulative-token deduplication and metadata. Rebuild only this
            // file from byte zero and detect its provider again.
            state = freshFileState(await firstSessionProvider(file), stat);
            this.states.set(file, state);
          } else if (
            state.provider === 'unknown'
            && (state.size !== stat.size || state.mtimeMs !== stat.mtimeMs)
          ) {
            state.provider = await firstSessionProvider(file);
            if (state.provider === 'pxpipe') state.parseState = emptyParseState();
          }
        }

        if (state.provider === 'pxpipe') {
          if (state.size !== stat.size || state.mtimeMs !== stat.mtimeMs || !state.summary) {
            await appendRolloutFile(file, state, stat.size);
          }
        }
        state.size = stat.size;
        state.mtimeMs = stat.mtimeMs;
      }

      const next: CodexUsageSnapshot = {
        ...EMPTY_BREAKDOWN,
        source: 'retained local Codex rollout logs',
        loading: false,
        error: null,
        sessionFiles: 0,
        usageSnapshots: 0,
        modelContextWindow: null,
        earliestEventAt: null,
        latestEventAt: null,
        rateLimits: null,
        quotaWindows: [],
      };
      const quotaByMinutes = new Map<string, CodexQuotaWindow>();
      for (const state of this.states.values()) {
        if (state.provider !== 'pxpipe' || !state.summary) continue;
        const s = state.summary;
        next.sessionFiles += 1;
        next.usageSnapshots += s.usageSnapshots;
        next.inputTokens += s.inputTokens;
        next.cachedInputTokens += s.cachedInputTokens;
        next.outputTokens += s.outputTokens;
        next.reasoningOutputTokens += s.reasoningOutputTokens;
        next.totalTokens += s.totalTokens;
        if (s.modelContextWindow !== null) next.modelContextWindow = s.modelContextWindow;
        if (s.earliestEventAt && (!next.earliestEventAt || s.earliestEventAt < next.earliestEventAt)) {
          next.earliestEventAt = s.earliestEventAt;
        }
        if (s.latestEventAt && (!next.latestEventAt || s.latestEventAt > next.latestEventAt)) {
          next.latestEventAt = s.latestEventAt;
        }
        next.rateLimits = newerRateLimits(next.rateLimits, s.rateLimits);
        for (const window of s.quotaWindows) {
          const limitKey = window.limitId !== null
            ? `id:${window.limitId}`
            : `name:${window.limitName ?? ''}`;
          const key = `${limitKey}:${window.windowMinutes}`;
          const previous = quotaByMinutes.get(key);
          if (!previous || (window.observedAt ?? '') >= (previous.observedAt ?? '')) {
            quotaByMinutes.set(key, window);
          }
        }
      }
      next.quotaWindows = [...quotaByMinutes.values()]
        .sort((a, b) => a.windowMinutes - b.windowMinutes);
      this.current = next;
    } catch (err) {
      this.current = {
        ...this.current,
        loading: false,
        // /proxy-stats may be exposed via HOST; do not leak absolute local
        // paths embedded in filesystem errors into the dashboard payload.
        error: err instanceof Error ? err.name : 'Codex rollout scan failed',
      };
    } finally {
      this.refreshing = false;
    }
  }
}
