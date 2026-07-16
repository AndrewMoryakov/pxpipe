/** Host-side rolling counter of recent /backend-api/codex/* traffic. Feeds the
 *  evidence-driven codex-upstream check. Time is passed in (Date.now() from the
 *  host) so it is deterministically testable. Not in core: it holds state and
 *  reads the clock via its caller. */

const DEFAULT_WINDOW_MS = 300_000; // 5 minutes

interface Entry {
  ts: number;
  is404: boolean;
}

export class HealthCounters {
  private codex: Entry[] = [];

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  private isCodexPath(path: string): boolean {
    return path.startsWith('/backend-api/codex/');
  }

  record(path: string, status: number, nowMs: number): void {
    if (!this.isCodexPath(path)) return;
    this.codex.push({ ts: nowMs, is404: status === 404 });
    this.trim(nowMs);
  }

  /** Entries are appended in time order, so stale ones are a prefix. */
  private trim(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let i = 0;
    while (i < this.codex.length && this.codex[i]!.ts < cutoff) i++;
    if (i > 0) this.codex.splice(0, i);
  }

  snapshot(nowMs: number): { codexResponses404: number; codexResponsesTotal: number; windowSeconds: number } {
    this.trim(nowMs);
    let c404 = 0;
    for (const e of this.codex) if (e.is404) c404++;
    return {
      codexResponses404: c404,
      codexResponsesTotal: this.codex.length,
      windowSeconds: Math.round(this.windowMs / 1000),
    };
  }
}
