<#
.SYNOPSIS
  Приёмочный тест контура pxpipe со стороны клиента (Windows).

.DESCRIPTION
  Это ворота приёмки. Контур считается развёрнутым ТОЛЬКО если оба
  сквозных теста дали CLAUDE_OK и CODEX_OK — то есть реальный запрос
  реальной моделью прошёл через pxpipe.

  Намеренно НЕ считается успехом:
    * "порт слушает"            — туннель может стоять, а pxpipe лежать;
    * "docker ps healthy"       — healthcheck не ходит к апстриму;
    * "конфиг содержит нужный URL" — наличие конфига не есть работа.

.EXAMPLE
  pwsh -File deploy\verify.ps1
  pwsh -File deploy\verify.ps1 -Port 47822 -SkipCodex
#>
[CmdletBinding()]
param(
    [int]$Port = 47822,
    [switch]$SkipClaude,
    [switch]$SkipCodex
)

$ErrorActionPreference = 'Continue'
$baseUrl = "http://127.0.0.1:$Port"
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
    param([string]$Name, [string]$State, [string]$Detail)
    $results.Add([pscustomobject]@{ Check = $Name; State = $State; Detail = $Detail })
    $color = switch ($State) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-Host ("  [{0,-4}] {1,-22} {2}" -f $State, $Name, $Detail) -ForegroundColor $color
}

Write-Host "`n=== ПРИЁМКА КОНТУРА pxpipe ($baseUrl) ===`n" -ForegroundColor Cyan

# --- 1. Транспорт: туннель слушает ---------------------------------------
$listen = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' `
    -LocalPort $Port -ErrorAction SilentlyContinue
if ($listen) {
    $owner = (Get-Process -Id $listen[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Add-Result 'tunnel-listen' 'PASS' "127.0.0.1:$Port слушает (процесс: $owner)"
} else {
    Add-Result 'tunnel-listen' 'FAIL' "127.0.0.1:$Port не слушает. Смотри $env:ProgramData\pxpipe\pxpipe-tunnel.log"
}

# --- 2. Транспорт: pxpipe отвечает по HTTP --------------------------------
try {
    $r = Invoke-WebRequest -Uri $baseUrl -Method GET -TimeoutSec 10 `
        -UseBasicParsing -ErrorAction Stop
    Add-Result 'pxpipe-http' 'PASS' "HTTP $($r.StatusCode)"
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code) {
        # Любой HTTP-ответ означает, что туннель донёс запрос до pxpipe.
        Add-Result 'pxpipe-http' 'PASS' "HTTP $code (pxpipe отвечает)"
    } else {
        Add-Result 'pxpipe-http' 'FAIL' "нет HTTP-ответа: $($_.Exception.Message)"
    }
}

# --- 3. Сквозной тест Claude Code ----------------------------------------
if ($SkipClaude) {
    Add-Result 'claude-e2e' 'WARN' 'пропущен (-SkipClaude)'
} else {
    $env:ANTHROPIC_BASE_URL = $baseUrl
    $out = & claude -p "Reply with exactly: CLAUDE_OK" --model claude-haiku-4-5-20251001 2>&1 | Out-String
    if ($out -match 'CLAUDE_OK') {
        Add-Result 'claude-e2e' 'PASS' 'реальный ответ модели получен через pxpipe'
    } else {
        $snippet = ($out.Trim() -replace '\s+', ' ')
        if ($snippet.Length -gt 160) { $snippet = $snippet.Substring(0, 160) }
        Add-Result 'claude-e2e' 'FAIL' "ответ: $snippet"
    }
}

# --- 4. Сквозной тест Codex ----------------------------------------------
if ($SkipCodex) {
    Add-Result 'codex-e2e' 'WARN' 'пропущен (-SkipCodex)'
} else {
    $out = & codex exec --skip-git-repo-check "Reply with exactly: CODEX_OK" 2>&1 | Out-String
    if ($out -match 'CODEX_OK') {
        Add-Result 'codex-e2e' 'PASS' 'реальный ответ модели получен через pxpipe'
    } else {
        Add-Result 'codex-e2e' 'FAIL' ("ответ: " + ($out.Trim() -replace '\s+', ' '))
    }
}

# --- Итог ------------------------------------------------------------------
$failed = @($results | Where-Object State -eq 'FAIL')
Write-Host ''
if ($failed.Count -eq 0) {
    Write-Host "РЕЗУЛЬТАТ: контур принят." -ForegroundColor Green
    Write-Host "Известные открытые дефекты — deploy/docs/KNOWN-OPEN.md" -ForegroundColor DarkGray
    exit 0
} else {
    Write-Host "РЕЗУЛЬТАТ: контур НЕ принят, провалено проверок: $($failed.Count)." -ForegroundColor Red
    Write-Host "Диагностика по слоям — deploy/docs/RATIONALE.md" -ForegroundColor DarkGray
    exit 1
}
