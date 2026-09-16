<#
  pxpipe-canary — следит за здоровьем связки на клиенте контура и шлёт в Telegram
  ТОЛЬКО при смене состояния (OK<->FAIL), не спамит. api.telegram.org отсюда
  недоступен, поэтому отправка идёт через .147 по ssh (путь независим от Clash).

  Проверяет РЕАЛЬНЫЕ поломки: туннели, pxpipe через туннель, здоровье Service Mode
  Clash (ядро под SYSTEM, служба, локальный порт прокси). НЕ проверяет сам TUN/egress —
  его выключение это ваш штатный жест, а не авария.

  Запускается задачей pxpipe-canary раз в 5 минут.
#>
$ErrorActionPreference = 'Stop'

function Get-ContourValue($name, $default) {
    $v = [Environment]::GetEnvironmentVariable($name, 'Machine')
    if ([string]::IsNullOrWhiteSpace($v)) { $v = [Environment]::GetEnvironmentVariable($name) }
    if ([string]::IsNullOrWhiteSpace($v)) { return $default }
    return $v
}

$stateFile  = Join-Path $env:USERPROFILE 'bin\canary-state.txt'
$logFile    = Join-Path $env:USERPROFILE 'bin\canary.log'
$ssh        = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$key        = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
$server     = "{0}@{1}" -f (Get-ContourValue 'PXPIPE_GATEWAY_SSH_USER' 'root'),
                           (Get-ContourValue 'PXPIPE_GATEWAY_SSH_HOST' '185.177.219.147')
$hostLabel  = Get-ContourValue 'PXPIPE_CONTOUR_NAME' $env:COMPUTERNAME
$pxpipePort = [int](Get-ContourValue 'PXPIPE_CLIENT_PXPIPE_PORT' 47822)
$workPort   = [int](Get-ContourValue 'PXPIPE_CLIENT_WORK_PORT'   19443)
$clashPort  = [int](Get-ContourValue 'PXPIPE_CLIENT_CLASH_PORT'   7897)

function Log($m) {
    try { "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m | Add-Content -Path $logFile -Encoding UTF8 } catch {}
}
function Send-Telegram($text) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    $r = & $ssh '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=15' '-i' $key '-T' $server "/root/canary-notify.sh --b64 $b64" 2>&1
    return ($r | Out-String).Trim()
}

try {
    $problems = New-Object System.Collections.Generic.List[string]

    # --- туннели ---
    foreach ($p in $pxpipePort, $workPort) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)) {
            $problems.Add("туннель $p не слушает")
        }
    }

    # --- pxpipe через туннель (ответ про ключ = транспорт жив) ---
    $savedH = $env:HTTP_PROXY; $savedS = $env:HTTPS_PROXY
    $env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''
    try {
        $api = (& curl.exe -s --max-time 10 -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$pxpipePort/v1/messages" 2>$null) -join ' '
    } finally { $env:HTTP_PROXY = $savedH; $env:HTTPS_PROXY = $savedS }
    if ($api -notmatch 'authentication_error|x-api-key') { $problems.Add("pxpipe не отвечает через туннель $pxpipePort") }

    # --- здоровье Service Mode Clash (не сам TUN) ---
    $core = @(Get-CimInstance Win32_Process -Filter "Name='verge-mihomo.exe'" -ErrorAction SilentlyContinue)
    if ($core.Count -eq 0) {
        $problems.Add('Clash: ядро verge-mihomo не запущено')
    } else {
        $owner = ($core[0] | Invoke-CimMethod -MethodName GetOwner).User
        if ($owner -ne 'SYSTEM') { $problems.Add("Clash: ядро под $owner, а не SYSTEM (Service Mode сломан)") }
    }
    $svc = Get-Service clash_verge_service -ErrorAction SilentlyContinue
    if (-not ($svc -and $svc.Status -eq 'Running')) { $problems.Add('Clash: служба clash_verge_service не Running') }
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $clashPort -ErrorAction SilentlyContinue)) { $problems.Add("Clash: порт $clashPort не слушает") }

    $status = if ($problems.Count -eq 0) { 'OK' } else { 'FAIL' }
    $last   = if (Test-Path $stateFile) { (Get-Content $stateFile -Raw).Trim() } else { 'OK' }

    if ($status -ne $last) {
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm'
        if ($status -eq 'FAIL') {
            $text = "&#9888; <b>$hostLabel</b> — сбой ($ts)`n" + (($problems | ForEach-Object { "• $_" }) -join "`n")
        } else {
            $text = "&#9989; <b>$hostLabel</b> — всё восстановлено ($ts)"
        }
        $sent = Send-Telegram $text
        Log "переход $last -> $status; проблемы=[$($problems -join '; ')]; доставка=$sent"
        # состояние меняем только при успешной доставке — иначе повторим через 5 мин
        if ($sent -eq '200') { Set-Content -Path $stateFile -Value $status -Encoding ASCII }
    } else {
        Set-Content -Path $stateFile -Value $status -Encoding ASCII
    }
}
catch {
    Log "ОШИБКА канарейки: $($_.Exception.Message)"
}
