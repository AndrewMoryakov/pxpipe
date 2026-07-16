import { describe, it, expect } from 'vitest';
import { renderHeaderFragment, renderSessionSummaryFragment } from '../src/dashboard/fragments.js';
import type { CurrentSessionPayload, StatsPayload } from '../src/dashboard/types.js';

function payload(p: Partial<CurrentSessionPayload>): CurrentSessionPayload {
  return {
    sessionId: 'abcdef1234567890',
    baselineMeasuredCount: 1,
    rawOutputTokens: 139,
    ...p,
  };
}

describe('renderSessionSummaryFragment hero', () => {
  it('shows the cache-aware effect for the current session', () => {
    const html = renderSessionSummaryFragment(
      payload({ baselineInputWeighted: 7000, actualInputWeighted: 1800 }),
    );
    expect(html).toContain('Current session · abcdef12');
    expect(html).toContain('class="hero-num">74%</span>');
    expect(html).toContain('less estimated input after caching');
    expect(html).toContain('id="help-current-session-percent"');
    expect(html).toContain('id="help-current-session-effective-input"');
    expect(html).toContain('74%'); // 1 - 1800/7000
  });

  it('flips direction on a warm net-loss session', () => {
    const html = renderSessionSummaryFragment(
      payload({ baselineInputWeighted: 1546, actualInputWeighted: 1863 }),
    );
    expect(html).toContain('class="hero-num">21%</span>');
    expect(html).toContain('more estimated input after caching');
    expect(html).toContain('hero-neg'); // red styling on a loss
  });

  it('never lumps output into the headline ratio', () => {
    const a = renderSessionSummaryFragment(
      payload({ baselineInputWeighted: 2000, actualInputWeighted: 1000, rawOutputTokens: 10 }),
    );
    const b = renderSessionSummaryFragment(
      payload({ baselineInputWeighted: 2000, actualInputWeighted: 1000, rawOutputTokens: 9000 }),
    );
    expect(a).toContain('50%');
    expect(b).toContain('50%');
  });

  it('renders explicit waiting states for no session and an unmeasured session', () => {
    expect(renderSessionSummaryFragment({ sessionId: null })).toContain('Waiting for session traffic');
    expect(renderSessionSummaryFragment(payload({ baselineMeasuredCount: 0 }))).toContain('Waiting for a comparable response');
  });
});

describe('renderHeaderFragment estimate quality', () => {
  it('shows measured, estimated, excluded, TTL, and pricing coverage without opening the drawer', () => {
    const html = renderHeaderFragment({
      requests: 9,
      compressed_requests: 8,
      saved_input_tokens: 12_345,
      measured_claude_saved_input_equivalents: 8_500,
      modeled_openai_saved_input_equivalents: 3_845,
      usage_bearing_responses: 4,
      measured_anthropic_savings_requests: 3,
      estimated_openai_savings_requests: 2,
      baseline_probe_excluded_requests: 1,
      cache_create_5m_tokens: 750,
      cache_create_1h_tokens: 250,
      cache_create_tier_unknown_tokens: 1_000,
      priced_measured_savings_requests: 2,
      unpriced_measured_savings_requests: 1,
      saved_usd: 0.42,
      split_sufficient_sample: false,
      compressed_paid_requests: 3,
      passthrough_paid_requests: 1,
      split_min_sample_per_bucket: 10,
      uptime_sec: 60,
      pricing_assumptions: {
        input_per_mtok: 3,
        output_multiplier: 5,
        source: 'official pricing',
      },
      codex_actual_usage: {
        source: 'test sessions', loading: false, error: null,
        sessionFiles: 4, usageSnapshots: 12,
        inputTokens: 10_000, cachedInputTokens: 9_000,
        outputTokens: 600, reasoningOutputTokens: 250, totalTokens: 10_600,
        modelContextWindow: 200_000,
        earliestEventAt: '2026-07-13T22:00:00Z', latestEventAt: '2026-07-14T00:00:00Z',
        quotaWindows: [
          { usedPercent: 25, windowMinutes: 300, resetsAt: 1_789_000_000, limitId: 'codex', limitName: 'Codex', observedAt: '2026-07-14T00:00:00Z' },
          { usedPercent: 40, windowMinutes: 10_080, resetsAt: 1_789_500_000, limitId: 'codex', limitName: 'Codex', observedAt: '2026-07-14T00:00:00Z' },
          { usedPercent: 12, windowMinutes: 300, resetsAt: 1_789_100_000, limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', observedAt: '2026-07-14T00:00:00Z' },
          { usedPercent: 18, windowMinutes: 10_080, resetsAt: 1_789_600_000, limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', observedAt: '2026-07-14T00:00:00Z' },
          { usedPercent: 7, windowMinutes: 1_440, resetsAt: 1_789_200_000, limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', observedAt: '2026-07-14T00:00:00Z' },
        ],
        rateLimits: {
          limitId: 'codex', limitName: 'Codex', planType: null,
          observedAt: '2026-07-14T00:00:00Z',
          primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_789_000_000 },
          secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: 1_789_500_000 },
        },
      },
    } as StatsPayload, 47821);

    expect(html).toContain('Overview · since restart');
    expect(html).toContain('What PXPIPE changed');
    expect(html).toContain('Estimated input change');
    expect(html).toContain('8,500</strong><span class="price-callout"><small>Model-priced input value</small><b class="price-value">$0.42</b><em>2/3 priced Claude rows</em>');
    expect(html).toContain('3,845 <em>not priced</em>');
    expect(html).toContain('Paid LLM responses');
    expect(html).toContain('Mixed evidence');
    expect(html).toContain('2/3 rows');
    expect(html).toContain('1</b> of imaged rows uncredited');
    expect(html).toContain('Usage &amp; limits · retained rollouts');
    expect(html).toContain('Codex provider-reported usage');
    expect(html).toContain('9,000 · 90.0%');
    expect(html).toContain('12 usage records');
    expect(html).toContain('codex_bengalfox');
    expect(html).toContain('GPT-5.3-Codex-Spark');
    expect(html).toContain('<small>1-day</small>');
    expect(html).toContain('Usage, not savings.');
    expect(html).toContain('750 / 250 / 1,000');
    expect(html).toContain('id="audit-drawer"');
    expect(html).toContain('<details class="overview-panel collapsible-panel" id="overview" open');
    expect(html).toContain('<details class="codex-panel collapsible-panel" id="usage-limits" open');
    expect(html).toContain('<span class="when-open">Hide</span>');
    expect(html).toContain('id="help-overview"');
    expect(html).toContain('id="help-input-change"');
    expect(html).toContain('id="help-paid-responses"');
    expect(html).toContain('id="help-paid-imaged"');
    expect(html).toContain('id="help-paid-passthrough"');
    expect(html).toContain('id="help-paid-uncredited"');
    expect(html).toContain('id="help-price-coverage"');
    expect(html).toContain('id="help-reliability"');
    expect(html).toContain('id="help-codex-quotas"');
    expect(html).toContain('<b>What it is.</b>');
    expect(html).toContain('<b>Why it matters.</b>');
    expect(html).toContain('<b>How to read it.</b>');
    expect(html.indexOf('Overview · since restart')).toBeLessThan(html.indexOf('Show the math'));
  });
});
