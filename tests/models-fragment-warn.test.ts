import { describe, it, expect } from 'vitest';
import { renderModelsFragment } from '../src/dashboard/fragments.js';

// Weak-reader chips (per FINDINGS): enabling one from the dashboard must prompt
// a confirm; a lit one must show a ⚠ marker. Non-flagged models (Fable, Sonnet,
// Terra, Lun, broad gpt-5.6) never prompt.
const WEAK = ['claude-opus-4-8', 'claude-opus-4-7', 'gpt-5.5', 'gpt-5.6-sol', 'grok-4.5'];

describe('renderModelsFragment — weak-reader warnings', () => {
  it('adds hx-confirm only to weak-reader chips that are OFF (enable attempt)', () => {
    // Nothing active, nothing extra configured → chip set is the built-in catalog.
    const html = renderModelsFragment([], [], true);
    // Exactly the weak readers carry a confirm; Fable/Sonnet/Terra/Lun/gpt-5.6 do not.
    const confirmCount = (html.match(/hx-confirm=/g) ?? []).length;
    expect(confirmCount).toBe(WEAK.length);
    // The Opus warning text is present and carries the FINDINGS number.
    expect(html).toContain('6/15 dense-hex');
  });

  it('does NOT prompt when a weak reader is already ON (disable never confirms)', () => {
    // All weak readers lit → clicking them would DISABLE → no confirm anywhere.
    const html = renderModelsFragment(WEAK, [], true);
    expect(html).not.toContain('hx-confirm=');
    // Lit weak readers show the ⚠ marker.
    expect(html).toContain('⚠');
  });

  it('never marks or prompts a non-flagged model (Terra)', () => {
    const offHtml = renderModelsFragment([], [], true);
    const onHtml = renderModelsFragment(['gpt-5.6-terra'], [], true);
    // Terra chip: extract its button and assert no confirm / no ⚠ on it.
    const terraOff = offHtml.match(/<button[^>]*"model":"gpt-5\.6-terra"[^>]*>[^<]*<\/button>/)?.[0] ?? '';
    const terraOn = onHtml.match(/<button[^>]*"model":"gpt-5\.6-terra"[^>]*>[^<]*<\/button>/)?.[0] ?? '';
    expect(terraOff).not.toContain('hx-confirm=');
    expect(terraOn).not.toContain('⚠');
    expect(terraOn).toContain('✓'); // it is enabled, just not flagged
  });
});
