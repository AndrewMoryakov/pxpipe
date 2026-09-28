/**
 * Session state survives a proxy restart.
 *
 * Why this matters: the freeze step is a PIN. A session repacked at a coarse
 * grid must never be rendered finer again, or every history chunk re-keys and
 * the provider bills the whole prefix as cache_create. The pin lived only in
 * process memory, so a restart dropped it for every live session.
 *
 * Run just this file:  pnpm vitest run tests/session-state-persistence.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureSessionStateStore,
  flushSessionState,
  markCacheDead,
  noteCacheOutcome,
  noteHistoryRequest,
  peekSessionState,
  recordFreezeStep,
  resetSessionState,
  restoreSessionState,
  serializeSessionState,
  sessionStateSize,
  type SessionStateStore,
} from '../src/core/session-state.js';

/** In-memory store with call counters; `failSave` simulates an unwritable disk. */
function memoryStore(
  initial?: string,
): SessionStateStore & { text: string | undefined; saves: string[]; loads: number; failSave: boolean } {
  const s = {
    text: initial,
    saves: [] as string[],
    loads: 0,
    failSave: false,
    load(): string | undefined {
      s.loads++;
      return s.text;
    },
    save(text: string): void {
      if (s.failSave) throw new Error('disk full');
      s.text = text;
      s.saves.push(text);
    },
  };
  return s;
}

const T0 = 1_760_000_000_000; // arbitrary fixed "now"

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetSessionState();
  configureSessionStateStore(undefined);
});

afterEach(() => {
  configureSessionStateStore(undefined);
  resetSessionState();
  vi.useRealTimers();
});

describe('restart round-trip', () => {
  it('restores the freeze-step floor and server-observed liveness', () => {
    const disk = memoryStore();
    configureSessionStateStore(disk, T0);

    noteHistoryRequest('sess-a', T0);
    recordFreezeStep('sess-a', 640);
    noteCacheOutcome('sess-a', 400_000, 3_000);
    expect(flushSessionState()).toBe(true);

    // "Restart": a fresh process has an empty map and reads the same file.
    resetSessionState();
    expect(sessionStateSize()).toBe(0);
    expect(configureSessionStateStore(disk, T0 + 20_000)).toBe(1);

    expect(peekSessionState('sess-a')?.freezeStep).toBe(640);
    // The next request after the restart keeps the floor and stays warm: the
    // provider said a cache exists, so re-cutting the grid is NOT free.
    const state = noteHistoryRequest('sess-a', T0 + 20_000);
    expect(state).toEqual({ cold: false, minFreezeStep: 640 });
  });

  it('a session the file does not know stays unknown (= warm, no floor)', () => {
    const disk = memoryStore();
    configureSessionStateStore(disk, T0);
    noteHistoryRequest('sess-a', T0);
    flushSessionState();
    resetSessionState();
    configureSessionStateStore(disk, T0);
    expect(noteHistoryRequest('sess-b', T0)).toEqual({ cold: false, minFreezeStep: 0 });
  });

  it('records already in memory win over the file', () => {
    const disk = memoryStore();
    configureSessionStateStore(disk, T0);
    recordFreezeStep('sess-a', 320);
    flushSessionState();
    resetSessionState();
    // The live process has already moved this session past what the file says.
    recordFreezeStep('sess-a', 1280);
    expect(restoreSessionState(disk.text, T0)).toBe(0);
    expect(peekSessionState('sess-a')?.freezeStep).toBe(1280);
  });
});

describe('write-through', () => {
  it('coalesces a burst of mutations into one debounced save', () => {
    const disk = memoryStore();
    configureSessionStateStore(disk, T0);
    noteHistoryRequest('sess-a', T0);
    recordFreezeStep('sess-a', 160);
    markCacheDead('sess-a');
    expect(disk.saves).toHaveLength(0);
    vi.advanceTimersByTime(249);
    expect(disk.saves).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(disk.saves).toHaveLength(1);
    const parsed = JSON.parse(disk.saves[0]!) as { format: number; sessions: Array<Record<string, unknown>> };
    expect(parsed.format).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]).toMatchObject({ key: 'sess-a', freezeStep: 160, cacheDead: true });
  });

  it('does not save when nothing changed', () => {
    const disk = memoryStore();
    configureSessionStateStore(disk, T0);
    recordFreezeStep('sess-a', 640);
    flushSessionState();
    expect(disk.saves).toHaveLength(1);
    // Lower step: not a change (the floor only rises).
    recordFreezeStep('sess-a', 320);
    expect(flushSessionState()).toBe(false);
    expect(disk.saves).toHaveLength(1);
  });

  it('flush writes immediately and cancels the pending timer', () => {
    const disk = memoryStore();
    configureSessionStateStore(disk, T0);
    recordFreezeStep('sess-a', 640);
    expect(flushSessionState()).toBe(true);
    expect(disk.saves).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(disk.saves).toHaveLength(1);
  });

  it('a store that throws never reaches the request path', () => {
    const disk = memoryStore();
    disk.failSave = true;
    configureSessionStateStore(disk, T0);
    expect(() => {
      recordFreezeStep('sess-a', 640);
      vi.advanceTimersByTime(250);
    }).not.toThrow();
    expect(flushSessionState()).toBe(false);
    // In-memory state is intact regardless.
    expect(peekSessionState('sess-a')?.freezeStep).toBe(640);
  });

  it('without a store the module is exactly as before: no timers, no saves', () => {
    recordFreezeStep('sess-a', 640);
    noteHistoryRequest('sess-a', T0);
    expect(vi.getTimerCount()).toBe(0);
    expect(flushSessionState()).toBe(false);
  });
});

describe('restore hygiene', () => {
  it('drops records idle for more than 24 h, keeps the rest', () => {
    const day = 24 * 3_600_000;
    const text = JSON.stringify({
      format: 1,
      saved_at_ms: T0,
      sessions: [
        { key: 'fresh', lastSeenMs: T0 - 60_000, freezeStep: 320, cacheDead: false },
        { key: 'stale', lastSeenMs: T0 - day - 1, freezeStep: 320, cacheDead: false },
      ],
    });
    expect(restoreSessionState(text, T0)).toBe(1);
    expect(peekSessionState('fresh')).toBeDefined();
    expect(peekSessionState('stale')).toBeUndefined();
  });

  it('omits stale and never-seen records when serializing', () => {
    const day = 24 * 3_600_000;
    noteHistoryRequest('old', T0 - day - 1);
    noteHistoryRequest('new', T0);
    recordFreezeStep('pinned-only', 640); // lastSeenMs 0: never requested
    const parsed = JSON.parse(serializeSessionState(T0)) as { sessions: Array<{ key: string }> };
    expect(parsed.sessions.map((s) => s.key)).toEqual(['new']);
  });

  it('ignores corrupt, foreign or malformed files without throwing', () => {
    for (const text of [
      'not json',
      '{}',
      '[]',
      JSON.stringify({ format: 99, sessions: [] }),
      JSON.stringify({ format: 1, sessions: 'nope' }),
      JSON.stringify({ format: 1, sessions: [null, 42, { key: '' }, { key: 'k' }, { key: 'k', lastSeenMs: 'x' }] }),
      JSON.stringify({ format: 1, sessions: [{ key: 'k', lastSeenMs: T0, freezeStep: -1, cacheDead: false }] }),
      JSON.stringify({ format: 1, sessions: [{ key: 'k', lastSeenMs: T0, freezeStep: 1, cacheDead: 'no' }] }),
    ]) {
      expect(restoreSessionState(text, T0), text).toBe(0);
    }
    expect(sessionStateSize()).toBe(0);
  });

  it('a store whose load throws leaves the map untouched', () => {
    const disk: SessionStateStore = {
      load() {
        throw new Error('EACCES');
      },
      save() {},
    };
    recordFreezeStep('sess-a', 640);
    expect(configureSessionStateStore(disk, T0)).toBe(0);
    expect(peekSessionState('sess-a')?.freezeStep).toBe(640);
  });

  it('sanitizes optional fields', () => {
    const text = JSON.stringify({
      format: 1,
      sessions: [
        {
          key: 'k',
          lastSeenMs: T0,
          freezeStep: 640,
          cacheDead: false,
          lastCacheAlive: 'yes', // wrong type: dropped
          everCacheAlive: true,
        },
      ],
    });
    expect(restoreSessionState(text, T0)).toBe(1);
    expect(peekSessionState('k')?.freezeStep).toBe(640);
    // lastCacheAlive was dropped, so the server has not "said alive"; the session
    // was seen just now, so it is warm by the clock. Either way: not cold.
    expect(noteHistoryRequest('k', T0 + 1).cold).toBe(false);
  });

  it('respects the in-memory capacity when restoring a large file', () => {
    const sessionsOnDisk = Array.from({ length: 600 }, (_, i) => ({
      key: `s${i}`,
      lastSeenMs: T0 - (600 - i) * 1000, // oldest first, like a saved LRU order
      freezeStep: 1,
      cacheDead: false,
    }));
    const text = JSON.stringify({ format: 1, saved_at_ms: T0, sessions: sessionsOnDisk });
    expect(restoreSessionState(text, T0)).toBe(600);
    expect(sessionStateSize()).toBe(512);
    expect(peekSessionState('s0')).toBeUndefined(); // oldest evicted
    expect(peekSessionState('s599')).toBeDefined(); // newest kept
  });
});
