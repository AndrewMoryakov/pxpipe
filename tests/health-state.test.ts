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
