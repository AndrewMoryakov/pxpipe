import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CodexUsageIndex,
  groupCodexQuotaWindows,
  summarizeCodexRolloutLines,
} from '../src/codex-usage.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function tokenLine(
  total: Record<string, number>,
  last: Record<string, number> | null,
  timestamp = '2026-07-14T00:00:00.000Z',
): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: total,
        last_token_usage: last,
        model_context_window: 200_000,
      },
      rate_limits: {
        limit_id: 'codex',
        limit_name: 'Codex',
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_789_000_000 },
        secondary: { used_percent: 33, window_minutes: 10_080, resets_at: 1_789_500_000 },
      },
    },
  });
}

describe('Codex rollout usage parser', () => {
  it('uses last_token_usage and ignores duplicate cumulative snapshots', () => {
    const total = {
      input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100,
      reasoning_output_tokens: 60, total_tokens: 1100,
    };
    const last = {
      input_tokens: 400, cached_input_tokens: 300, output_tokens: 40,
      reasoning_output_tokens: 20, total_tokens: 440,
    };
    const first = tokenLine(total, last);
    const refreshed = JSON.parse(tokenLine(total, last, '2026-07-14T00:05:00.000Z'));
    refreshed.payload.rate_limits.primary.used_percent = 18.75;
    refreshed.payload.rate_limits.primary.resets_at = 1_789_000_300;
    const summary = summarizeCodexRolloutLines([first, JSON.stringify(refreshed)]);
    expect(summary.usageSnapshots).toBe(1);
    expect(summary.inputTokens).toBe(400);
    expect(summary.cachedInputTokens).toBe(300);
    expect(summary.outputTokens).toBe(40);
    expect(summary.reasoningOutputTokens).toBe(20);
    expect(summary.rateLimits?.primary?.usedPercent).toBe(18.75);
    expect(summary.rateLimits?.primary?.resetsAt).toBe(1_789_000_300);
    expect(summary.earliestEventAt).toBe('2026-07-14T00:00:00.000Z');
    expect(summary.latestEventAt).toBe('2026-07-14T00:05:00.000Z');
  });

  it('groups equal-duration quota windows by provider limit id', () => {
    const groups = groupCodexQuotaWindows([
      { limitId: 'codex', limitName: 'Codex', usedPercent: 12, windowMinutes: 300, resetsAt: 10, observedAt: '2026-07-14T00:00:00Z' },
      { limitId: 'other', limitName: 'Other', usedPercent: 72, windowMinutes: 300, resetsAt: 20, observedAt: '2026-07-14T00:01:00Z' },
      { limitId: 'codex', limitName: 'Codex', usedPercent: 34, windowMinutes: 10_080, resetsAt: 30, observedAt: '2026-07-14T00:02:00Z' },
      { limitId: 'codex', limitName: 'Codex', usedPercent: 18, windowMinutes: 300, resetsAt: 40, observedAt: '2026-07-14T00:03:00Z' },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.limitId === 'codex')?.windows).toEqual([
      expect.objectContaining({ windowMinutes: 300, usedPercent: 18 }),
      expect.objectContaining({ windowMinutes: 10_080, usedPercent: 34 }),
    ]);
    expect(groups.find((group) => group.limitId === 'other')?.windows).toEqual([
      expect.objectContaining({ windowMinutes: 300, usedPercent: 72 }),
    ]);
  });

  it('keeps unnamed provider limits separate by their reported names', () => {
    const total = { input_tokens: 100, total_tokens: 100 };
    const first = JSON.parse(tokenLine(total, total, '2026-07-14T00:00:00.000Z'));
    delete first.payload.rate_limits.limit_id;
    first.payload.rate_limits.limit_name = 'Limit A';
    const second = JSON.parse(tokenLine(total, total, '2026-07-14T00:01:00.000Z'));
    delete second.payload.rate_limits.limit_id;
    second.payload.rate_limits.limit_name = 'Limit B';

    const summary = summarizeCodexRolloutLines([JSON.stringify(first), JSON.stringify(second)]);
    const groups = groupCodexQuotaWindows(summary.quotaWindows);
    expect(groups.map((group) => group.limitName)).toEqual(['Limit A', 'Limit B']);
    expect(groups.every((group) => group.windows.length === 2)).toBe(true);
  });

  it('falls back to cumulative deltas when last_token_usage is absent', () => {
    const first = { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 };
    const second = { input_tokens: 250, cached_input_tokens: 180, output_tokens: 30, reasoning_output_tokens: 9, total_tokens: 280 };
    const summary = summarizeCodexRolloutLines([tokenLine(first, null), tokenLine(second, null)]);
    expect(summary.usageSnapshots).toBe(2);
    expect(summary.inputTokens).toBe(250);
    expect(summary.cachedInputTokens).toBe(180);
    expect(summary.outputTokens).toBe(30);
    expect(summary.totalTokens).toBe(280);
  });

  it('indexes only sessions whose official model_provider is pxpipe', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-codex-usage-'));
    tempDirs.push(root);
    const nested = path.join(root, '2026', '07', '14');
    await fs.mkdir(nested, { recursive: true });
    const usage = {
      input_tokens: 500, cached_input_tokens: 450, output_tokens: 25,
      reasoning_output_tokens: 10, total_tokens: 525,
    };
    await fs.writeFile(path.join(nested, 'rollout-pxpipe.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'pxpipe', session_id: 'one' } }),
      tokenLine(usage, usage),
    ].join('\n'));
    await fs.writeFile(path.join(nested, 'rollout-direct.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai', session_id: 'two' } }),
      tokenLine({ ...usage, input_tokens: 9999 }, { ...usage, input_tokens: 9999 }),
    ].join('\n'));

    const index = new CodexUsageIndex(root);
    await index.refresh();
    const snapshot = index.snapshot();
    expect(snapshot.loading).toBe(false);
    expect(snapshot.sessionFiles).toBe(1);
    expect(snapshot.usageSnapshots).toBe(1);
    expect(snapshot.inputTokens).toBe(500);
    expect(snapshot.cachedInputTokens).toBe(450);
    expect(snapshot.rateLimits?.secondary?.windowMinutes).toBe(10_080);
    expect(snapshot.earliestEventAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('aggregates the earliest and latest token observations across sessions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-codex-usage-'));
    tempDirs.push(root);
    const usage = { input_tokens: 10, total_tokens: 10 };
    const document = (timestamp: string): string => [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'pxpipe' } }),
      tokenLine(usage, usage, timestamp),
      '',
    ].join('\n');
    await fs.writeFile(path.join(root, 'rollout-later.jsonl'), document('2026-07-14T05:00:00.000Z'));
    await fs.writeFile(path.join(root, 'rollout-earlier.jsonl'), document('2026-07-13T22:00:00.000Z'));

    const index = new CodexUsageIndex(root);
    await index.refresh();

    expect(index.snapshot().earliestEventAt).toBe('2026-07-13T22:00:00.000Z');
    expect(index.snapshot().latestEventAt).toBe('2026-07-14T05:00:00.000Z');
  });

  it('retries provider detection when an active rollout first appears empty', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-codex-usage-'));
    tempDirs.push(root);
    const file = path.join(root, 'rollout-active.jsonl');
    await fs.writeFile(file, '');

    const index = new CodexUsageIndex(root);
    await index.refresh();
    expect(index.snapshot().sessionFiles).toBe(0);

    const usage = {
      input_tokens: 700, cached_input_tokens: 600, output_tokens: 30,
      reasoning_output_tokens: 12, total_tokens: 730,
    };
    await fs.writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'pxpipe' } }),
      tokenLine(usage, usage),
    ].join('\n'));
    await index.refresh();

    expect(index.snapshot().sessionFiles).toBe(1);
    expect(index.snapshot().inputTokens).toBe(700);
  });

  it('increments a growing rollout without recounting prior snapshots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-codex-usage-'));
    tempDirs.push(root);
    const file = path.join(root, 'rollout-growing.jsonl');
    const first = {
      input_tokens: 100, cached_input_tokens: 80, output_tokens: 10,
      reasoning_output_tokens: 4, total_tokens: 110,
    };
    const secondTotal = {
      input_tokens: 250, cached_input_tokens: 200, output_tokens: 25,
      reasoning_output_tokens: 9, total_tokens: 275,
    };
    const secondLast = {
      input_tokens: 150, cached_input_tokens: 120, output_tokens: 15,
      reasoning_output_tokens: 5, total_tokens: 165,
    };
    await fs.writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'pxpipe' } }),
      tokenLine(first, first),
      '',
    ].join('\n'));

    const index = new CodexUsageIndex(root);
    await index.refresh();
    expect(index.snapshot().inputTokens).toBe(100);

    await fs.appendFile(file, `${tokenLine(secondTotal, secondLast, '2026-07-14T00:01:00.000Z')}\n`);
    await index.refresh();
    expect(index.snapshot().usageSnapshots).toBe(2);
    expect(index.snapshot().inputTokens).toBe(250);
    expect(index.snapshot().outputTokens).toBe(25);

    await index.refresh();
    expect(index.snapshot().usageSnapshots).toBe(2);
    expect(index.snapshot().inputTokens).toBe(250);
  });

  it('defers an incomplete final JSONL row until the append completes it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-codex-usage-'));
    tempDirs.push(root);
    const file = path.join(root, 'rollout-partial.jsonl');
    const usage = {
      input_tokens: 345, cached_input_tokens: 300, output_tokens: 20,
      reasoning_output_tokens: 7, total_tokens: 365,
    };
    const row = tokenLine(usage, usage);
    const split = Math.floor(row.length / 2);
    await fs.writeFile(file, `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'pxpipe' } })}\n${row.slice(0, split)}`);

    const index = new CodexUsageIndex(root);
    await index.refresh();
    expect(index.snapshot().sessionFiles).toBe(1);
    expect(index.snapshot().usageSnapshots).toBe(0);

    await fs.appendFile(file, `${row.slice(split)}\n`);
    await index.refresh();
    expect(index.snapshot().usageSnapshots).toBe(1);
    expect(index.snapshot().inputTokens).toBe(345);
  });

  it('rebuilds per-file state after truncate or path replacement', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-codex-usage-'));
    tempDirs.push(root);
    const file = path.join(root, 'rollout-reset.jsonl');
    const document = (inputTokens: number): string => [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'pxpipe' } }),
      tokenLine({ input_tokens: inputTokens, total_tokens: inputTokens }, { input_tokens: inputTokens, total_tokens: inputTokens }),
      '',
    ].join('\n');
    await fs.writeFile(file, document(9000));

    const index = new CodexUsageIndex(root);
    await index.refresh();
    expect(index.snapshot().inputTokens).toBe(9000);

    await fs.writeFile(file, document(40));
    await index.refresh();
    expect(index.snapshot().usageSnapshots).toBe(1);
    expect(index.snapshot().inputTokens).toBe(40);

    const replacement = path.join(root, 'replacement.jsonl');
    await fs.writeFile(replacement, document(777));
    await fs.rm(file);
    await fs.rename(replacement, file);
    await index.refresh();
    expect(index.snapshot().usageSnapshots).toBe(1);
    expect(index.snapshot().inputTokens).toBe(777);
  });

  it('preserves dedup and advances quota metadata across incremental appends', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-codex-usage-'));
    tempDirs.push(root);
    const file = path.join(root, 'rollout-metadata.jsonl');
    const usage = {
      input_tokens: 120, cached_input_tokens: 100, output_tokens: 8,
      reasoning_output_tokens: 3, total_tokens: 128,
    };
    const first = tokenLine(usage, usage);
    await fs.writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'pxpipe' } }),
      first,
      '',
    ].join('\n'));

    const index = new CodexUsageIndex(root);
    await index.refresh();

    const duplicate = JSON.parse(tokenLine(usage, usage, '2026-07-14T00:10:00.000Z'));
    duplicate.payload.rate_limits.primary.used_percent = 91;
    duplicate.payload.rate_limits.primary.resets_at = 1_789_999_999;
    await fs.appendFile(file, `${JSON.stringify(duplicate)}\n`);
    await index.refresh();

    const snapshot = index.snapshot();
    expect(snapshot.usageSnapshots).toBe(1);
    expect(snapshot.inputTokens).toBe(120);
    expect(snapshot.rateLimits?.primary?.usedPercent).toBe(91);
    expect(snapshot.rateLimits?.primary?.resetsAt).toBe(1_789_999_999);
    expect(snapshot.latestEventAt).toBe('2026-07-14T00:10:00.000Z');
  });
});
