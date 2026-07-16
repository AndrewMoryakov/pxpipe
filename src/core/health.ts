/** Pure self-diagnosis for pxpipe. No fs, no network, no clock — the caller
 *  passes a state snapshot (including any "recent traffic" aggregate) and gets
 *  back findings. Runs anywhere core runs. */

export type Severity = 'error' | 'warn' | 'info';

export interface Remediation {
  kind: 'set-openai-upstream';
  target: 'https://chatgpt.com';
  durableHint: string;
}

export interface HealthFinding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  remediation?: Remediation;
}

export interface HealthRecentTraffic {
  codexResponses404: number;
  codexResponsesTotal: number;
  windowSeconds: number;
}

export interface HealthState {
  anthropicUpstream: string;
  openaiUpstream: string;
  openaiUpstreamOverridden: boolean;
  modelScope: string[];
  compressionEnabled: boolean;
  recent: HealthRecentTraffic;
}

const CHATGPT_DURABLE_HINT =
  'Set OPENAI_UPSTREAM=https://chatgpt.com (User env: setx OPENAI_UPSTREAM "https://chatgpt.com" then re-login, or in pxpipe-run.cmd) and restart pxpipe.';

/** Lower-cased hostname, or null when the URL cannot be parsed. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True only for chatgpt.com or a *.chatgpt.com subdomain. An unparseable URL
 *  is NOT chatgpt.com (so it surfaces as a mismatch rather than passing). */
function isChatGPTHost(url: string): boolean {
  const h = hostOf(url);
  return h === 'chatgpt.com' || (h !== null && h.endsWith('.chatgpt.com'));
}

export function evaluateHealth(state: HealthState): HealthFinding[] {
  const findings: HealthFinding[] = [];

  if (!isChatGPTHost(state.openaiUpstream)) {
    const confirmed = state.recent.codexResponses404 > 0;
    findings.push({
      id: 'codex-upstream-mismatch',
      severity: confirmed ? 'error' : 'warn',
      title: confirmed
        ? 'Codex requests are 404ing: OpenAI upstream is not chatgpt.com'
        : 'OpenAI upstream is not chatgpt.com — Codex paths will 404',
      detail: confirmed
        ? `${state.recent.codexResponses404}/${state.recent.codexResponsesTotal} recent /backend-api/codex/* requests returned 404 while the OpenAI upstream is ${state.openaiUpstream}. That path only exists on chatgpt.com.`
        : `The OpenAI upstream is ${state.openaiUpstream}. Codex uses /backend-api/codex/*, which exists only on chatgpt.com and 404s here. (No codex traffic seen yet.)`,
      remediation: {
        kind: 'set-openai-upstream',
        target: 'https://chatgpt.com',
        durableHint: CHATGPT_DURABLE_HINT,
      },
    });
  }

  if (!state.compressionEnabled || state.modelScope.length === 0) {
    findings.push({
      id: 'compression-passthrough',
      severity: 'info',
      title: 'Compression is not active — traffic passes through untransformed',
      detail: !state.compressionEnabled
        ? 'The dashboard compression kill-switch is off; every request forwards unchanged.'
        : 'The model scope is empty, so no model is eligible for imaging; every request forwards unchanged.',
    });
  }

  if (state.openaiUpstreamOverridden) {
    findings.push({
      id: 'openai-upstream-overridden',
      severity: 'info',
      title: 'OpenAI upstream is overridden at runtime',
      detail: `A runtime hot-swap is routing OpenAI traffic to ${state.openaiUpstream}. This is in-memory only; set OPENAI_UPSTREAM to make it durable.`,
    });
  }

  return findings;
}

/** ok = no error-severity findings. Maps to the /healthz status code. */
export function summarizeHealth(findings: HealthFinding[]): { ok: boolean; httpStatus: 200 | 503 } {
  const ok = !findings.some((f) => f.severity === 'error');
  return { ok, httpStatus: ok ? 200 : 503 };
}
