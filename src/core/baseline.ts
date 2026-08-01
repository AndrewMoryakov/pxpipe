/**
 * Cache-aware baseline math for the unproxied counterfactual.
 * Workers-safe: no node:, no Buffer, no process.*. Pure number math.
 * See docs/CACHING_AND_SAVINGS.md for the full derivation and audit history.
 */

/** Documented Anthropic cache price ratios to ordinary input. */
export const CACHE_CREATE_5M_RATE = 1.25;
export const CACHE_CREATE_1H_RATE = 2.0;
/** @deprecated Prefer the explicit 5m/1h constants. Kept for source compatibility. */
export const CACHE_CREATE_RATE = CACHE_CREATE_5M_RATE;
export const CACHE_READ_RATE = 0.1;

/**
 * Server-reported cache-create tier split. Anthropic omits it on some older
 * responses; that remainder is deliberately treated as a 5-minute estimate,
 * not as proof that the request used that tier. Callers can surface coverage.
 */
export interface CacheCreateBreakdown {
  fiveMinuteTokens?: number;
  oneHourTokens?: number;
}

export function cacheCreateEffectiveTokens(
  totalTokens: number,
  breakdown?: CacheCreateBreakdown,
): number {
  const total = Math.max(0, totalTokens || 0);
  const five = Math.min(total, Math.max(0, breakdown?.fiveMinuteTokens ?? 0));
  const one = Math.min(total - five, Math.max(0, breakdown?.oneHourTokens ?? 0));
  return five * CACHE_CREATE_5M_RATE + one * CACHE_CREATE_1H_RATE
    + (total - five - one) * CACHE_CREATE_5M_RATE;
}

export function cacheCreateUnknownTokens(
  totalTokens: number,
  breakdown?: CacheCreateBreakdown,
): number {
  const total = Math.max(0, totalTokens || 0);
  const five = Math.min(total, Math.max(0, breakdown?.fiveMinuteTokens ?? 0));
  const one = Math.min(total - five, Math.max(0, breakdown?.oneHourTokens ?? 0));
  return total - five - one;
}

/** Effective cache-write rate for this request. Older usage payloads do not
 * expose the tier split; preserve the historical/conservative 5-minute rate
 * in that case. The text counterfactual uses the same observed tier mix as
 * the transformed request because pxpipe relocates, rather than invents, the
 * caller's cache-control markers. */
function cacheCreateRate(cc: number, cc5m?: number, cc1h?: number): number {
  if (!(cc > 0)) return CACHE_CREATE_RATE;
  const splitReported = cc5m !== undefined || cc1h !== undefined;
  if (!splitReported) return CACHE_CREATE_RATE;
  const fiveMinute = Math.max(0, cc5m ?? 0);
  const oneHour = Math.max(0, cc1h ?? 0);
  const splitTotal = fiveMinute + oneHour;
  if (!(splitTotal > 0)) return CACHE_CREATE_RATE;
  // The API contract says splitTotal === cc. Normalize malformed/mismatched
  // payloads to the aggregate so telemetry never invents extra write tokens.
  return (
    fiveMinute * CACHE_CREATE_RATE + oneHour * CACHE_CREATE_1H_RATE
  ) / splitTotal;
}

/** Anthropic prompt-cache TTL (seconds). Kept for callers that display provider
 *  docs, but savings math does not use TTL to infer a hypothetical text-cache
 *  hit: text is considered warm only when the actual request reports cr > 0. */
export const CACHE_TTL_SEC = 300;

/** This session's previous usage-bearing turn, used only for warm split sizing. */
export interface BaselineWarmthPrev {
  /** Completion time of that turn, in wall-clock seconds. */
  ts: number;
  /** Cacheable-prefix tokens measured that turn (0 if the probe missed). */
  cacheable: number;
  /** Hash of the image-bound/static text prefix. If it changes, do not reuse the
   *  prior prefix size for this row's text reused/grown split. */
  prefixSha?: string;
}

/**
 * Decide whether the TEXT counterfactual's prefix was warm this turn.
 *
 * Strict accounting rule: the imagined text path gets the same observed cache
 * state as the real image path. `cr > 0` is server proof that the request read a
 * warm prefix, so the text baseline is warm too. `cr === 0` means the actual
 * request did not read cache, so the text baseline is priced cold too. We do not
 * use wall-clock TTL to claim that text would have been warm while images were
 * cold; that would be an unobservable counterfactual and can create negative
 * rows from cache assumptions rather than token savings.
 *
 * When cr proves warmth, a completed same-prefix prior is used only to estimate
 * how much of the text prefix was reused vs grown. If none is available, assume
 * full reuse of this turn's cacheable prefix; this is conservative for savings.
 */
export function deriveBaselineWarmth(
  prev: BaselineWarmthPrev | undefined,
  nowSec: number,
  cacheable: number,
  cr: number,
  ttlSec: number = CACHE_TTL_SEC,
  prefixSha?: string,
): { warm: boolean; prevCacheable: number } {
  const age = prev !== undefined ? nowSec - prev.ts : Number.POSITIVE_INFINITY;
  const samePrefix = prev === undefined
    || prev.prefixSha === undefined
    || prefixSha === undefined
    || prev.prefixSha === prefixSha;
  // cr is the only warm/cold signal. A prior only refines the warm split.
  if (!(cr > 0)) return { warm: false, prevCacheable: 0 };
  // Fresh prior: use its real prefix size for the reused/grown split. Without
  // one, cr proves warmth but not the split, so assume full reuse.
  const freshPrior = prev !== undefined && age >= 0 && age < ttlSec && samePrefix;
  return { warm: true, prevCacheable: freshPrior ? prev!.cacheable : cacheable };
}

/**
 * Weighted input cost for the unproxied TEXT counterfactual (see docs/CACHING_AND_SAVINGS.md).
 * Saving = baseline_eff − actual_eff; can be negative (honestly reported, not floored).
 *
 * @param baselineCacheable  tokens up to the last cache_control marker. ≤0 ⇒ credit nothing.
 * @param warm               was a warm cache available for this session this turn?
 * @param prevCacheable      cacheable prefix size on this session's previous turn (warm only).
 */
export function computeBaselineInputEff(
  baseline: number,
  baselineCacheable: number,
  inputTokens: number,
  cc: number,
  cr: number,
  warm = false,
  prevCacheable = 0,
): number {
  return computeBaselineInputEffWithCacheTier(
    baseline, baselineCacheable, inputTokens, cc, cr, warm, prevCacheable, 0,
  );
}

/** Tier-aware variant for internal telemetry accounting. */
export function computeBaselineInputEffWithCacheTier(
  baseline: number,
  baselineCacheable: number,
  inputTokens: number,
  cc: number,
  cr: number,
  warm: boolean,
  prevCacheable: number,
  cacheCreate1hTokens: number,
  cacheCreate5mTokens?: number,
): number {
  if (baseline <= 0) return 0;
  // Probe miss: can't split prefix from tail, so credit nothing (same as actual).
  if (baselineCacheable <= 0) {
    return computeActualInputEffWithCacheTier(
      inputTokens, cc, cr, cacheCreate1hTokens, cacheCreate5mTokens,
    );
  }
  const cacheable = Math.min(baselineCacheable, baseline);
  const coldTail = baseline - cacheable;
  const createRate = cacheCreateRate(cc, cacheCreate5mTokens, cacheCreate1hTokens);
  if (warm) {
    // Text reads the prefix it already had cached (0.10×) and creates only the
    // growth since last turn (at the observed write-tier rate).
    const reused = Math.min(Math.max(prevCacheable, 0), cacheable);
    const grown = cacheable - reused;
    return reused * CACHE_READ_RATE + grown * createRate + coldTail;
  }
  // Cold: no warm cache for text either, so it re-creates the whole cacheable
  // prefix at the observed create rate — the same event the imaged path pays.
  return cacheable * createRate + coldTail;
}

/** Weighted input cost pxpipe actually paid this turn. */
export function computeActualInputEff(
  inputTokens: number,
  cc: number,
  cr: number,
  cacheCreate?: CacheCreateBreakdown,
): number {
  return inputTokens + cacheCreateEffectiveTokens(cc, cacheCreate) + cr * CACHE_READ_RATE;
}

/** Tier-aware variant for internal telemetry accounting. */
export function computeActualInputEffWithCacheTier(
  inputTokens: number,
  cc: number,
  cr: number,
  cacheCreate1hTokens: number,
  cacheCreate5mTokens?: number,
): number {
  return inputTokens
    + cc * cacheCreateRate(cc, cacheCreate5mTokens, cacheCreate1hTokens)
    + cr * CACHE_READ_RATE;
}