# scripts/pxpipe-healthcheck.ps1
# Verify a running pxpipe instance. Exit 0 = healthy, 1 = unhealthy/unreachable.
# Requires PowerShell 6+ (pwsh) for -SkipHttpErrorCheck. Run: pwsh -File scripts/pxpipe-healthcheck.ps1
param(
  [int]$Port = 47821,
  [int]$Retries = 20
)
$url = "http://127.0.0.1:$Port/healthz"
for ($i = 0; $i -lt $Retries; $i++) {
  try {
    # -SkipHttpErrorCheck returns the response object on 503 instead of throwing,
    # so we read StatusCode/Content uniformly. A throw here means the connection
    # was refused (server not up yet) — retry.
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -SkipHttpErrorCheck
  } catch {
    Start-Sleep -Milliseconds 500
    continue
  }
  $code = [int]$resp.StatusCode
  if ($code -eq 200) {
    $body = $resp.Content | ConvertFrom-Json
    Write-Host "[pxpipe] OK  healthz 200  openai upstream -> $($body.state.openaiUpstream)" -ForegroundColor Green
    exit 0
  }
  if ($code -eq 503) {
    $body = $resp.Content | ConvertFrom-Json
    $err = ($body.findings | Where-Object { $_.severity -eq 'error' } | Select-Object -First 1)
    Write-Host "[pxpipe] FAIL healthz 503  $($err.title)" -ForegroundColor Red
    if ($err.remediation) { Write-Host "[pxpipe]      fix: $($err.remediation.durableHint)" -ForegroundColor Yellow }
    exit 1
  }
  Start-Sleep -Milliseconds 500
}
Write-Host "[pxpipe] FAIL healthz unreachable or unexpected status on port $Port (is pxpipe running?)" -ForegroundColor Red
exit 1
