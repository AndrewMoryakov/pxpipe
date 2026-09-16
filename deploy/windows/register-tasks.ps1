<#
.SYNOPSIS
  Регистрирует задачу-хранитель туннеля pxpipe на Windows-клиенте.

.DESCRIPTION
  ВСЕ настройки ниже заданы явно и намеренно. Дефолты планировщика Windows
  ломают этот сценарий — каждая строка с комментарием "ПОЧЕМУ" закрывает
  отказ, который реально наблюдался:

    DisallowStartIfOnBatteries / StopIfGoingOnBatteries
        Дефолт = $true. Ноутбук уходит в Modern Standby, планировщик считает
        это работой от батареи и ГЛУШИТ задачу. Туннель умирает молча, а
        Claude Code начинает получать ECONNREFUSED. Это был основной отказ.

    RunOnlyIfNetworkAvailable
        Дефолт = $true. При просыпании сеть ещё не поднята, задача не
        стартует и больше не пробует.

    ExecutionTimeLimit = PT0S
        Дефолт = 72 часа. Хранитель обязан жить вечно; по истечении лимита
        планировщик убивает его с SCHED_S_TASK_TERMINATED.

    MultipleInstancesPolicy = IgnoreNew
        Иначе повторный триггер плодит второй ssh, который не может занять
        порт, падает, и логи становятся нечитаемыми.

    Триггер: загрузка + повтор каждые 15 минут, бессрочно
        Повтор — это самовосстановление. Если процесс умер между повторами,
        следующий повтор поднимет его без участия человека.

.EXAMPLE
  pwsh -File deploy\windows\register-tasks.ps1 -ContourEnv deploy\contour.env
#>
[CmdletBinding()]
param(
    [string]$TaskName      = 'pxpipe-tunnel',
    [string]$ScriptPath    = "$env:USERPROFILE\bin\pxpipe-tunnel.ps1",
    [int]   $RepeatMinutes = 15
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ScriptPath)) {
    throw "Не найден скрипт-хранитель: $ScriptPath. Скопируй deploy\windows\pxpipe-tunnel.ps1 в ~\bin\ до регистрации."
}

Write-Host "Регистрирую задачу '$TaskName' -> $ScriptPath" -ForegroundColor Cyan

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""

# Триггер при загрузке + бессрочное повторение каждые N минут.
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes)).Repetition

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# Эти два свойства не выставляются параметрами командлета — только напрямую.
$settings.RunOnlyIfNetworkAvailable = $false
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries     = $false

# S4U: задача работает и когда пользователь не залогинен, пароль не хранится.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U `
    -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

# --- Верификация: читаем то, что реально записалось ------------------------
# Регистрация без проверки бессмысленна: часть настроек планировщик молча
# приводит к своим значениям.
$t = Get-ScheduledTask -TaskName $TaskName
$expected = [ordered]@{
    DisallowStartIfOnBatteries = $false
    StopIfGoingOnBatteries     = $false
    RunOnlyIfNetworkAvailable  = $false
    StartWhenAvailable         = $true
    ExecutionTimeLimit         = 'PT0S'
    MultipleInstances          = 'IgnoreNew'
}
Write-Host "`nПроверка записанных настроек:" -ForegroundColor Cyan
$bad = 0
foreach ($k in $expected.Keys) {
    $actual = $t.Settings.$k
    $ok = "$actual" -eq "$($expected[$k])"
    if (-not $ok) { $bad++ }
    $c = if ($ok) { 'Green' } else { 'Red' }
    Write-Host ("  [{0}] {1,-28} = {2}" -f $(if($ok){'ok  '}else{'ПЛОХО'}), $k, $actual) -ForegroundColor $c
}

Write-Host ''
if ($bad -eq 0) {
    Write-Host "Задача зарегистрирована корректно. Состояние: $((Get-ScheduledTask -TaskName $TaskName).State)" -ForegroundColor Green
    Write-Host "Дальше — приёмка: pwsh -File deploy\verify.ps1" -ForegroundColor DarkGray
} else {
    Write-Host "ВНИМАНИЕ: $bad настроек не применились. Задача переживёт не все сценарии сна." -ForegroundColor Red
    exit 1
}
