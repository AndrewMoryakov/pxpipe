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
# ВНИМАНИЕ: ниже намеренно не используются -AsHashtable и -Encoding utf8NoBOM —
# это параметры PowerShell 6+, а задача/инструкция могут запускаться под
# Windows PowerShell 5.1. Работа идёт через PSObject, запись — через .NET
# (UTF-8 строго без BOM: Claude Code не читает settings.json с BOM).
$settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
if ($null -eq $settings.PSObject.Properties['env']) {
    $settings | Add-Member -NotePropertyName 'env' -NotePropertyValue ([PSCustomObject]@{})
}

if ($Mode -eq 'On') {
    if ($null -eq $settings.env.PSObject.Properties['ANTHROPIC_BASE_URL']) {
        $settings.env | Add-Member -NotePropertyName 'ANTHROPIC_BASE_URL' -NotePropertyValue $proxyUrl
    } else {
        $settings.env.ANTHROPIC_BASE_URL = $proxyUrl
    }
} else {
    $settings.env.PSObject.Properties.Remove('ANTHROPIC_BASE_URL')
    if (@($settings.env.PSObject.Properties).Count -eq 0) {
        $settings.PSObject.Properties.Remove('env')
    }
}

$json = $settings | ConvertTo-Json -Depth 50
[System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))

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
