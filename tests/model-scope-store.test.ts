import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  modelScopeFile,
  loadPersistedModelScope,
  savePersistedModelScope,
  clearPersistedModelScope,
} from '../src/model-scope-store.js';

describe('model-scope-store (Variant A persistence)', () => {
  let dir: string;
  let eventsFile: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-scope-'));
    eventsFile = path.join(dir, 'events.jsonl');
    file = modelScopeFile(eventsFile);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('places the file next to the events log', () => {
    expect(file).toBe(path.join(dir, 'model-scope.json'));
  });

  it('absent file → null (fall back to PXPIPE_MODELS / default)', () => {
    expect(loadPersistedModelScope(file)).toBeNull();
  });

  it('round-trips a saved scope verbatim', () => {
    savePersistedModelScope(file, ['claude-fable-5', 'gpt-5.6-terra']);
    expect(loadPersistedModelScope(file)).toEqual(['claude-fable-5', 'gpt-5.6-terra']);
  });

  it('persists an empty list as [] — a real "compress nothing" choice, NOT null', () => {
    savePersistedModelScope(file, []);
    // The load-bearing distinction of Variant A: [] is a persisted choice, so
    // it must NOT fall through to env/default the way an absent file does.
    expect(loadPersistedModelScope(file)).toEqual([]);
  });

  it('clear removes the file → load returns null again', () => {
    savePersistedModelScope(file, ['claude-sonnet-5']);
    clearPersistedModelScope(file);
    expect(loadPersistedModelScope(file)).toBeNull();
  });

  it('clear on an absent file is a no-op (does not throw)', () => {
    expect(() => clearPersistedModelScope(file)).not.toThrow();
    expect(loadPersistedModelScope(file)).toBeNull();
  });

  it('malformed JSON → null (a corrupt file must never block startup)', () => {
    fs.writeFileSync(file, '{ not valid json');
    expect(loadPersistedModelScope(file)).toBeNull();
  });

  it('valid JSON without a modelBases array → null', () => {
    fs.writeFileSync(file, JSON.stringify({ modelBases: 'claude-fable-5' }));
    expect(loadPersistedModelScope(file)).toBeNull();
  });

  it('trims and drops blank/non-string entries on load', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ modelBases: ['  claude-fable-5 ', '', 42, 'gpt-5.6-sol'] }),
    );
    expect(loadPersistedModelScope(file)).toEqual(['claude-fable-5', 'gpt-5.6-sol']);
  });

  it('all-invalid non-empty arrays → null instead of disabling every model', () => {
    fs.writeFileSync(file, JSON.stringify({ modelBases: [42, {}, '  '] }));
    expect(loadPersistedModelScope(file)).toBeNull();
  });
});
