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
