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
