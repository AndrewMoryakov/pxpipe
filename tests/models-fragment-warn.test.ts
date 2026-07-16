import { describe, it, expect } from 'vitest';
import { renderModelsFragment } from '../src/dashboard/fragments.js';

// Readiness tiers (derived from committed eval receipts, see fragments.ts):
//  - below-bar → blocking confirm on enable + ⚠ when lit
//  - unmeasured → NON-blocking ⚠ + tooltip (default for unlisted ids)
//  - validated (Fable) → nothing
const BELOW_BAR = ['claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.5', 'gpt-5.6-sol', 'grok-4.5', 'gpt-5.6'];

/** Extract the <button> for one model id from rendered html. */
function chip(html: string, id: string): string {
  const esc = id.replace(/\./g, '\\.');
  return html.match(new RegExp(`<button[^>]*"model":"${esc}"[^>]*>[^<]*</button>`))?.[0] ?? '';
}

describe('renderModelsFragment — readiness-tiered warnings', () => {
  it('blocking confirm on exactly the below-bar chips when OFF', () => {
    const html = renderModelsFragment([], [], true);
    expect((html.match(/hx-confirm=/g) ?? []).length).toBe(BELOW_BAR.length);
    // below-bar confirm carries the concrete measured number.
    expect(html).toContain('0/15 verbatim dense-hex');
  });

  it('disabling never prompts: all below-bar ON → no confirm, ⚠ present', () => {
    const html = renderModelsFragment(BELOW_BAR, [], true);
    expect(html).not.toContain('hx-confirm=');
    expect(html).toContain('⚠');
  });

  it('unmeasured (Terra) never blocks: no confirm off or on; ⚠ + tooltip when on', () => {
    const off = chip(renderModelsFragment([], [], true), 'gpt-5.6-terra');
    const on = chip(renderModelsFragment(['gpt-5.6-terra'], [], true), 'gpt-5.6-terra');
    expect(off).not.toContain('hx-confirm=');
    expect(on).not.toContain('hx-confirm=');
    expect(on).toContain('⚠');
    expect(on).toContain('title=');
    expect(on).toContain('unmeasured');
  });

  it('validated (Fable) is never flagged: no confirm, ⚠, or title', () => {
    const on = chip(renderModelsFragment(['claude-fable-5'], [], true), 'claude-fable-5');
    expect(on).not.toContain('hx-confirm=');
    expect(on).not.toContain('⚠');
    expect(on).not.toContain('title=');
    expect(on).toContain('✓');
  });

  it('unknown/unlisted model defaults to unmeasured (⚠ + tooltip, no confirm)', () => {
    const c = chip(renderModelsFragment(['gpt-9.9-foo'], [], true), 'gpt-9.9-foo');
    expect(c).not.toContain('hx-confirm=');
    expect(c).toContain('⚠');
    expect(c).toContain('title=');
  });
});
