#!/usr/bin/env sh
# scripts/pxpipe-healthcheck.sh — Linux/macOS counterpart of pxpipe-healthcheck.ps1.
# Verify a running pxpipe instance. Exit 0 = healthy, 1 = unhealthy/unreachable.
# Usage: ./scripts/pxpipe-healthcheck.sh [port] [retries]
set -u
port="${1:-${PORT:-47821}}"
retries="${2:-20}"
url="http://127.0.0.1:${port}/healthz"
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

i=0
while [ "$i" -lt "$retries" ]; do
  # curl prints the status code; a connection refusal (server not up yet)
  # yields 000 and we retry.
  code="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 2 "$url" || true)"
  if [ "$code" = "200" ]; then
    upstream="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(b.state?.openaiUpstream ?? "?")' "$body_file" 2>/dev/null || echo '?')"
    echo "[pxpipe] OK  healthz 200  openai upstream -> ${upstream}"
    exit 0
  fi
  if [ "$code" = "503" ]; then
    node -e '
      const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const e = (b.findings || []).find((f) => f.severity === "error") || {};
      console.log(`[pxpipe] FAIL healthz 503  ${e.title ?? "unknown finding"}`);
      if (e.remediation?.durableHint) console.log(`[pxpipe]      fix: ${e.remediation.durableHint}`);
    ' "$body_file" 2>/dev/null || echo "[pxpipe] FAIL healthz 503"
    exit 1
  fi
  i=$((i + 1))
  sleep 0.5
done
echo "[pxpipe] FAIL healthz unreachable or unexpected status on port ${port} (is pxpipe running?)"
exit 1
