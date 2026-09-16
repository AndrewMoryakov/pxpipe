# pxpipe tunnel keeper: local $CLIENT_PXPIPE_PORT -> шлюз:$GATEWAY_PXPIPE_PORT
# Лог ведётся в C:\ProgramData\pxpipe и НЕ зависит от профиля пользователя,
# поэтому тишина в логе однозначно означает "keeper не работает".
#
# ПЕРЕНОСИМОСТЬ: все значения контура берутся из переменных окружения
# (задаются deploy\windows\apply-contour.ps1 из deploy\contour.env).
# Дефолты ниже — рабочая конфигурация контура frankfurt-147; задача
# планировщика запускает скрипт без окружения, поэтому дефолты обязаны
# быть валидными, а не пустыми.
$ErrorActionPreference = "Continue"

function Get-ContourValue($name, $default) {
    $v = [Environment]::GetEnvironmentVariable($name, 'Machine')
    if ([string]::IsNullOrWhiteSpace($v)) { $v = [Environment]::GetEnvironmentVariable($name) }
    if ([string]::IsNullOrWhiteSpace($v)) { return $default }
    return $v
}

$LogDir      = Get-ContourValue 'PXPIPE_CLIENT_LOG_DIR' 'C:\ProgramData\pxpipe'
$Log         = Join-Path $LogDir "pxpipe-tunnel.log"
$FallbackLog = Join-Path $env:TEMP "pxpipe-tunnel.log"
$SshExe      = "C:\Windows\System32\OpenSSH\ssh.exe"
$Remote      = "{0}@{1}" -f (Get-ContourValue 'PXPIPE_GATEWAY_SSH_USER' 'root'),
                            (Get-ContourValue 'PXPIPE_GATEWAY_SSH_HOST' '185.177.219.147')
$LocalPort   = [int](Get-ContourValue 'PXPIPE_CLIENT_PXPIPE_PORT'  47822)
$RemotePort  = [int](Get-ContourValue 'PXPIPE_GATEWAY_PXPIPE_PORT' 47821)
$ProbeUrl    = "http://127.0.0.1:$LocalPort/"

$HeartbeatSec  = [int](Get-ContourValue 'PXPIPE_KEEPER_HEARTBEAT_SEC'  300)  # строка "alive" раз в 5 минут
$ProbeSec      = [int](Get-ContourValue 'PXPIPE_KEEPER_PROBE_SEC'       60)  # функциональная проверка канала раз в минуту
$ProbeGraceSec = [int](Get-ContourValue 'PXPIPE_KEEPER_PROBE_GRACE_SEC' 20)  # дать ssh подняться до первой проверки
$ProbeFailMax  = [int](Get-ContourValue 'PXPIPE_KEEPER_PROBE_FAIL_MAX'   2)  # убить keeper после N неудач подряд
$BackoffMin    = [int](Get-ContourValue 'PXPIPE_KEEPER_BACKOFF_MIN'      5)
$BackoffMax    = [int](Get-ContourValue 'PXPIPE_KEEPER_BACKOFF_MAX'     60)
$StableSec     = [int](Get-ContourValue 'PXPIPE_KEEPER_STABLE_SEC'     120)  # соединение дольше этого считаем успешным
$MaxLogBytes   = 5MB

function Write-Log {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ss"), $Message
    try {
        Add-Content -Path $Log -Value $line -ErrorAction Stop
    } catch {
        try {
            Add-Content -Path $FallbackLog -Value "$line [fallback: $($_.Exception.Message)]" -ErrorAction SilentlyContinue
        } catch { }
    }
}

function Rotate-Log {
    try {
        if ((Test-Path $Log) -and ((Get-Item $Log -ErrorAction Stop).Length -gt $MaxLogBytes)) {
            Move-Item -Path $Log -Destination "$Log.1" -Force -ErrorAction Stop
        }
    } catch { }
}

# Функциональная проверка: важен сам факт HTTP-ответа с той стороны туннеля.
# Любой HTTP-статус (в т.ч. 404/401) доказывает, что канал живой насквозь.
# Отсутствие ответа на уровне соединения = канал мёртв.
function Test-Tunnel {
    try {
        Invoke-WebRequest -Uri $ProbeUrl -TimeoutSec 10 -UseBasicParsing -Method Get | Out-Null
        return $true
    } catch {
        $resp = $_.Exception.Response
        if ($resp -ne $null -and $resp.StatusCode -ne $null) { return $true }
        return $false
    }
}

try { if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null } } catch { }

Write-Log "=== keeper started (pid $PID) ==="

# Осиротевший ssh от прошлого keeper'а держал бы порт 47822 и, из-за
# ExitOnForwardFailure, загонял новый процесс в вечный цикл падений.
# Ищем по владельцу порта, а не по CommandLine: WMI не отдаёт CommandLine
# для этих процессов, и фильтр по нему молча не находил бы ничего.
try {
    $owners = @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($opid in $owners) {
        $p = Get-Process -Id $opid -ErrorAction SilentlyContinue
        if ($p -ne $null -and $p.ProcessName -eq 'ssh') {
            Write-Log "cleanup: убираю осиротевший ssh pid $opid (держал порт $LocalPort)"
            Stop-Process -Id $opid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
} catch { }

$backoff = $BackoffMin
# Имя с PID: два пересекающихся keeper'а не должны драться за один файл.
$errFile = Join-Path $env:TEMP "pxpipe-ssh-err-$PID.txt"

while ($true) {
    Rotate-Log
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue

    Write-Log "starting tunnel"
    $started = Get-Date
    $proc = $null
    try {
        $sshArgs = @(
            "-N",
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-o", "StrictHostKeyChecking=accept-new",
            "-L", "${LocalPort}:127.0.0.1:${RemotePort}",
            $Remote
        )
        $proc = Start-Process -FilePath $SshExe -ArgumentList $sshArgs -NoNewWindow -PassThru -RedirectStandardError $errFile
    } catch {
        Write-Log "error: не удалось запустить ssh: $($_.Exception.Message)"
    }

    if ($proc -ne $null) {
        $lastBeat   = Get-Date
        $lastProbe  = Get-Date
        $probeStart = (Get-Date).AddSeconds($ProbeGraceSec)
        $fails      = 0

        while (-not $proc.HasExited) {
            Start-Sleep -Seconds 5
            $now = Get-Date

            if ($now -ge $probeStart -and ($now - $lastProbe).TotalSeconds -ge $ProbeSec) {
                $lastProbe = $now
                if (Test-Tunnel) {
                    if ($fails -gt 0) { Write-Log "health: канал восстановился после $fails неудач" }
                    $fails = 0
                } else {
                    $fails++
                    Write-Log "health: проверка не прошла ($fails/$ProbeFailMax)"
                    if ($fails -ge $ProbeFailMax) {
                        Write-Log "health: канал мёртв при живом ssh - перезапускаю (kill pid $($proc.Id))"
                        try { $proc.Kill() } catch { Write-Log "health: kill не удался: $($_.Exception.Message)" }
                        break
                    }
                }
            }

            if (($now - $lastBeat).TotalSeconds -ge $HeartbeatSec) {
                $lastBeat = $now
                $mins = [math]::Round(($now - $started).TotalMinutes)
                Write-Log "alive (туннель держится $mins мин)"
            }
        }

        try { $proc.WaitForExit(10000) | Out-Null } catch { }
    }

    $dur = [int]((Get-Date) - $started).TotalSeconds

    foreach ($l in (@(Get-Content $errFile -ErrorAction SilentlyContinue) |
                    Where-Object { $_ -and $_.Trim() } | Select-Object -First 5)) {
        Write-Log "ssh: $l"
    }

    # Экспоненциальная выдержка: частые падения не должны превращаться
    # в цикл раз в 5 секунд - это прямой путь под бан fail2ban на сервере.
    if ($dur -ge $StableSec) { $backoff = $BackoffMin }
    Write-Log "tunnel exited after ${dur}s, retry in ${backoff}s"
    Start-Sleep -Seconds $backoff
    if ($dur -lt $StableSec) { $backoff = [math]::Min($backoff * 2, $BackoffMax) }
}
