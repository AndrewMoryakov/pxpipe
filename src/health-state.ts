/** Host-side assembler: turns pxpipe's live config + runtime state into the
 *  HealthState snapshot the pure evaluator consumes. Kept out of node.ts so it
 *  is importable in tests without starting a server. */

import { resolveUpstreams, type ProxyConfig } from './core/proxy.js';
import { getAllowedModelBases } from './core/applicability.js';
import type { HealthState } from './core/health.js';
import type { HealthCounters } from './health-counters.js';

export function buildHealthState(
  config: ProxyConfig,
  compression: { isCompressionEnabled(): boolean },
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
    compressionEnabled: compression.isCompressionEnabled(),
    recent: counters.snapshot(nowMs),
  };
}
