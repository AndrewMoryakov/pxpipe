/** Cross-process exclusion for the append-only events log and destructive
 * rewrites. A writer holds the lock for its lifetime; prune holds the same
 * lock from its first scan through the final rename. */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type EventsLockRole = 'writer' | 'prune';

interface LockRecord {
  pid: number;
  role: EventsLockRole;
  token: string;
}

export interface EventsFileLock {
  readonly path: string;
  readonly role: EventsLockRole;
  release(): void;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readRecord(lockPath: string): LockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    // Backward compatibility with the old PID-only writer marker.
    try {
      const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        return { pid, role: 'writer', token: `legacy:${pid}` };
      }
    } catch {
      /* handled below */
    }
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const r = parsed as Partial<LockRecord>;
  if (!Number.isSafeInteger(r.pid) || (r.pid ?? 0) <= 0) return undefined;
  if (r.role !== 'writer' && r.role !== 'prune') return undefined;
  if (typeof r.token !== 'string' || r.token.length === 0) return undefined;
  return r as LockRecord;
}

export function acquireEventsFileLock(
  eventsFile: string,
  role: EventsLockRole,
): EventsFileLock {
  const lockPath = eventsFile + '.writer.lock';
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${role}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const record: LockRecord = { pid: process.pid, role, token };

  for (let attempt = 0; attempt < 4; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = readRecord(lockPath);
      if (!owner || processIsAlive(owner.pid)) {
        const description = owner ? `${owner.role} pid ${owner.pid}` : 'an unreadable lock';
        throw new Error(`events log is already owned by ${description}`);
      }
      // Stale owner. Removal and the next exclusive create are race-safe: if
      // another contender wins, our next open sees its live record and fails.
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    let released = false;
    return {
      path: lockPath,
      role,
      release(): void {
        if (released) return;
        released = true;
        const current = readRecord(lockPath);
        if (current?.token !== token) return;
        try {
          fs.unlinkSync(lockPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      },
    };
  }
  throw new Error('could not acquire events log lock after stale-owner races');
}
