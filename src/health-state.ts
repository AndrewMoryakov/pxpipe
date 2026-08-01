/** Host-side assembler: turns pxpipe's live config + runtime state into the
 *  HealthState snapshot the pure evaluator consumes. Kept out of node.ts so it
 *  is importable in tests without starting a server. */

import { resolveUpstreams, type ProxyConfig } from './core/proxy.js';
import { getAllowedModelBases } from './core/applicability.js';
import {
  evaluateHealth,
  summarizeHealth,
  type HealthFinding,
  type HealthState,
} from './core/health.js';
import type { HealthCounters } from './health-counters.js';

export function buildHealthState(
  config: ProxyConfig,
  compression: { getCompressionEnabled(): boolean },
  counters: HealthCounters,
  nowMs: number,
): HealthState {
  const routes = resolveUpstreams(config);
  return {
    anthropicUpstream: routes.anthropic,
    openaiUpstream: routes.openai,
    // Phase A: no runtime upstream override exists yet — always false.
    openaiUpstreamOverridden: false,
    modelScope: getAllowedModelBases(),
    compressionEnabled: compression.getCompressionEnabled(),
    recent: counters.snapshot(nowMs),
  };
}

export interface HealthReport {
  ok: boolean;
  findings: HealthFinding[];
  state: HealthState | null;
  httpStatus: 200 | 503;
}

/** Build the public health report without ever mistaking a diagnostic failure
 * for a healthy process. The Node handler can still return the JSON report on
 * /api/health.json, while /healthz uses httpStatus for its probe semantics. */
export function buildHealthReport(
  config: ProxyConfig,
  compression: { getCompressionEnabled(): boolean },
  counters: HealthCounters,
  nowMs: number,
): HealthReport {
  try {
    const state = buildHealthState(config, compression, counters, nowMs);
    const findings = evaluateHealth(state);
    const summary = summarizeHealth(findings);
    return { ok: summary.ok, findings, state, httpStatus: summary.httpStatus };
  } catch {
    const findings: HealthFinding[] = [{
      id: 'health-diagnostics-failed',
      severity: 'error',
      title: 'Health diagnostics failed',
      detail: 'pxpipe could not assemble its health state; treat this instance as unhealthy.',
    }];
    return { ok: false, findings, state: null, httpStatus: 503 };
  }
}
