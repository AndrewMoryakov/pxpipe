param([Parameter(Mandatory)][ValidateSet('On', 'Off')][string]$Mode)

$ErrorActionPreference = 'Stop'
$settingsPath = "$env:USERPROFILE\.claude\settings.json"

# Порт контура: PXPIPE_CLIENT_PXPIPE_PORT (machine env, ставится apply-contour.ps1).
$port = [Environment]::GetEnvironmentVariable('PXPIPE_CLIENT_PXPIPE_PORT', 'Machine')
if ([string]::IsNullOrWhiteSpace($port)) { $port = 47822 }
$port = [int]$port
$proxyUrl = "http://127.0.0.1:$port"

if (-not (Test-Path "$settingsPath.bak-pxpipe")) {
    Copy-Item $settingsPath "$settingsPath.bak-pxpipe"   # pre-pxpipe copy, kept once
}
$settings = Get-Content $settingsPath -Raw | ConvertFrom-Json -AsHashtable
if (-not $settings.Contains('env')) { $settings['env'] = [ordered]@{} }

if ($Mode -eq 'On') {
    $settings['env']['ANTHROPIC_BASE_URL'] = $proxyUrl
} else {
    $settings['env'].Remove('ANTHROPIC_BASE_URL')
    if ($settings['env'].Count -eq 0) { $settings.Remove('env') }
}

$settings | ConvertTo-Json -Depth 50 | Set-Content $settingsPath -Encoding utf8NoBOM

if ($Mode -eq 'On') {
    Write-Host "Claude Code -> pxpipe ($proxyUrl)" -ForegroundColor Green
    try {
        $task = Get-ScheduledTask -TaskName pxpipe-tunnel -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq 'Disabled') {
            Write-Host 'Задача pxpipe-tunnel была отключена - включаю и запускаю.' -ForegroundColor Yellow
            Enable-ScheduledTask -TaskName pxpipe-tunnel | Out-Null
        }
        if ($task -and $task.State -ne 'Running') { Start-ScheduledTask -TaskName pxpipe-tunnel; Start-Sleep -Seconds 5 }
    } catch {
        Write-Host "Не удалось управлять задачей pxpipe-tunnel ($($_.Exception.Message)). Запусти её вручную из Task Scheduler." -ForegroundColor Yellow
    }
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        Write-Host "Туннель на 127.0.0.1:$port поднят." -ForegroundColor Green
    } else {
        Write-Host "ВНИМАНИЕ: туннель на 127.0.0.1:$port не слушает - Claude Code не сможет подключиться. См. $env:ProgramData\pxpipe\pxpipe-tunnel.log" -ForegroundColor Red
    }
} else {
    Write-Host 'Claude Code -> напрямую (api.anthropic.com)' -ForegroundColor Cyan
}
Write-Host 'Изменение применится к новым сессиям Claude Code.'
