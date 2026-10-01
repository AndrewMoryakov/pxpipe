<#
.SYNOPSIS
  Регистрирует задачи Windows-клиента контура (хранитель туннеля, канарейка,
  рабочий ssh-туннель) с настройками, которые доказанно переживают сон.

.DESCRIPTION
  ВСЕ настройки ниже заданы явно и намеренно. Дефолты планировщика Windows
  ломают этот сценарий — каждая строка с комментарием "ПОЧЕМУ" закрывает
  отказ, который реально наблюдался на frankfurt-147:

    DisallowStartIfOnBatteries / StopIfGoingOnBatteries
        Дефолт = $true. Ноутбук уходит в Modern Standby, планировщик считает
        это работой от батареи и ГЛУШИТ задачу. Туннель умирает молча, а
        Claude Code начинает получать ECONNREFUSED. Это был основной отказ.

    RunOnlyIfNetworkAvailable
        Дефолт = $true. При просыпании сеть ещё не поднята, задача не
        стартует и больше не пробует.

    ExecutionTimeLimit = PT0S (для хранителей)
        Дефолт = 72 часа. Хранитель обязан жить вечно; по истечении лимита
        планировщик убивает его с SCHED_S_TASK_TERMINATED.

    MultipleInstancesPolicy = IgnoreNew
        Иначе повторный триггер плодит второй ssh, который не может занять
        порт, падает, и логи становятся нечитаемыми.

    Триггер: загрузка + повтор каждые N минут, бессрочно
        Повтор — это самовосстановление. Если процесс умер между повторами,
        следующий повтор поднимет его без участия человека.

    RunLevel = Limited, LogonType = S4U
        Проверенная на работающем контуре комбинация: задача идёт без
        логина пользователя, пароль не хранится, UAC не требуется.

.EXAMPLE
  # все задачи контура
  powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1

.EXAMPLE
  # только хранитель pxpipe
  powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1 -Only pxpipe-tunnel
#>
[CmdletBinding()]
param(
    # Каталог, куда уже скопированы скрипты (см. README, шаг "клиент").
    [string]  $BinDir = "$env:USERPROFILE\bin",

    # Подмножество задач; пусто = все.
    [string[]]$Only = @(),

    # Не регистрировать, только показать план.
    [switch]  $WhatIfOnly
)

$ErrorActionPreference = 'Stop'

# --- таблица задач контура -------------------------------------------------
# Значения соответствуют состоянию, проверенному на работающем контуре
# frankfurt-147 (см. deploy/DIAGNOSIS.md). Менять — только вместе с проверкой.
$tasks = @(
    [ordered]@{
        Name          = 'pxpipe-tunnel'
        Script        = 'pxpipe-tunnel.ps1'
        RepeatMinutes = 15
        TimeLimit     = [TimeSpan]::Zero      # PT0S — жить вечно
        RestartCount  = 5
        Required      = $true
        Comment       = 'хранитель ssh-туннеля к шлюзу + локальный порт pxpipe'
    },
    [ordered]@{
        Name          = 'pxpipe-canary'
        Script        = 'canary.ps1'
        RepeatMinutes = 5
        TimeLimit     = (New-TimeSpan -Minutes 4)  # короче интервала повтора
        RestartCount  = 0
        Required      = $true
        Comment       = 'health-check + уведомление в Telegram при смене состояния'
    },
    [ordered]@{
        Name          = 'Tashkent Clash SSH Tunnels'
        Script        = 'start-tashkent-tunnels.ps1'
        RepeatMinutes = 15
        TimeLimit     = [TimeSpan]::Zero
        RestartCount  = 5
        Required      = $false                # рабочий туннель, не часть pxpipe
        Comment       = 'рабочий ssh-туннель (отдельный контур)'
    }
)

if ($Only.Count) {
    $tasks = $tasks | Where-Object { $Only -contains $_.Name }
    if (-not $tasks) { throw "Ни одна задача не совпала с -Only: $($Only -join ', ')" }
}

function Register-ContourTask($spec) {
    $scriptPath = Join-Path $BinDir $spec.Script

    if (-not (Test-Path $scriptPath)) {
        if ($spec.Required) {
            throw "Не найден скрипт: $scriptPath. Скопируй deploy\windows\*.ps1 в $BinDir до регистрации."
        }
        Write-Host ("  пропуск '{0}': нет {1} (задача необязательная)" -f $spec.Name, $scriptPath) -ForegroundColor DarkYellow
        return $null
    }

    Write-Host ("Регистрирую '{0}' -> {1}" -f $spec.Name, $scriptPath) -ForegroundColor Cyan
    Write-Host ("  {0}" -f $spec.Comment) -ForegroundColor DarkGray

    if ($WhatIfOnly) { return $null }

    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

    # Триггер при загрузке + бессрочное повторение каждые N минут.
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes $spec.RepeatMinutes)).Repetition

    $settingsArgs = @{
        AllowStartIfOnBatteries    = $true
        DontStopIfGoingOnBatteries = $true
        StartWhenAvailable         = $true
        MultipleInstances          = 'IgnoreNew'
        ExecutionTimeLimit         = $spec.TimeLimit
    }
    if ($spec.RestartCount -gt 0) {
        $settingsArgs.RestartCount    = $spec.RestartCount
        $settingsArgs.RestartInterval = (New-TimeSpan -Minutes 1)
    }
    $settings = New-ScheduledTaskSettingsSet @settingsArgs

    # Эти два свойства не выставляются параметрами командлета — только напрямую.
    $settings.RunOnlyIfNetworkAvailable  = $false
    $settings.DisallowStartIfOnBatteries = $false
    $settings.StopIfGoingOnBatteries     = $false

    # S4U: задача работает и когда пользователь не залогинен, пароль не хранится.
    $principal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType S4U `
        -RunLevel Limited

    Register-ScheduledTask -TaskName $spec.Name -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null

    Start-ScheduledTask -TaskName $spec.Name
    return $spec
}

# --- регистрация -----------------------------------------------------------
$registered = @()
foreach ($spec in $tasks) {
    $r = Register-ContourTask $spec
    if ($r) { $registered += $r }
}

if ($WhatIfOnly -or -not $registered) { return }

# --- Верификация: читаем то, что реально записалось ------------------------
# Регистрация без проверки бессмысленна: часть настроек планировщик молча
# приводит к своим значениям.
Write-Host "`nПроверка записанных настроек:" -ForegroundColor Cyan
$bad = 0
foreach ($spec in $registered) {
    $t  = Get-ScheduledTask -TaskName $spec.Name
    $xml = [xml](Export-ScheduledTask -TaskName $spec.Name)
    $expected = [ordered]@{
        DisallowStartIfOnBatteries = 'False'
        StopIfGoingOnBatteries     = 'False'
        RunOnlyIfNetworkAvailable  = 'False'
        StartWhenAvailable         = 'True'
        ExecutionTimeLimit         = if ($spec.TimeLimit -eq [TimeSpan]::Zero) { 'PT0S' } else { 'PT4M' }
    }
    Write-Host ("  {0}" -f $spec.Name) -ForegroundColor White
    foreach ($k in $expected.Keys) {
        $actual = "$($t.Settings.$k)"
        $ok = $actual -eq $expected[$k]
        if (-not $ok) { $bad++ }
        Write-Host ("    [{0}] {1,-28} = {2}" -f $(if($ok){'ok  '}else{'ПЛОХО'}), $k, $actual) `
            -ForegroundColor $(if($ok){'Green'}else{'Red'})
    }
    # MultipleInstancesPolicy надёжно читается только из XML.
    $mi = $xml.Task.Settings.MultipleInstancesPolicy
    $ok = ($mi -eq 'IgnoreNew')
    if (-not $ok) { $bad++ }
    Write-Host ("    [{0}] {1,-28} = {2}" -f $(if($ok){'ok  '}else{'ПЛОХО'}), 'MultipleInstancesPolicy', $mi) `
        -ForegroundColor $(if($ok){'Green'}else{'Red'})
    # Триггер загрузки — без него задача не встанет после ребута.
    $hasBoot = [bool]($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })
    if (-not $hasBoot) { $bad++ }
    Write-Host ("    [{0}] {1,-28} = {2}" -f $(if($hasBoot){'ok  '}else{'ПЛОХО'}), 'BootTrigger', $hasBoot) `
        -ForegroundColor $(if($hasBoot){'Green'}else{'Red'})
}

Write-Host ''
if ($bad -eq 0) {
    Write-Host "Задачи зарегистрированы корректно." -ForegroundColor Green
    Write-Host "Дальше — приёмка: powershell -ExecutionPolicy Bypass -File deploy\verify.ps1" -ForegroundColor DarkGray
} else {
    Write-Host "ВНИМАНИЕ: $bad настроек не применились. Задачи переживут не все сценарии сна." -ForegroundColor Red
    exit 1
}
