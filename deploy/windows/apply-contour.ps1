<#
.SYNOPSIS
  Записывает параметры контура в машинные переменные окружения Windows.

.DESCRIPTION
  Единственный писатель контракта, который читают остальные скрипты клиента
  (pxpipe-tunnel.ps1, canary.ps1, claude-pxpipe.ps1, verify.ps1) через свою
  Get-ContourValue: сначала scope 'Machine', потом процесс, потом дефолт.

  ПОЧЕМУ это отдельный обязательный шаг:
    Дефолты внутри скриптов — это значения контура frankfurt-147. Без этого
    шага новый контур молча заработает на ЧУЖОМ хосте и портах: ошибки не
    будет, будет неверное поведение. Поэтому в конце идёт проверка, что все
    переменные контракта действительно проставлены.

  Scope = Machine, ПОЧЕМУ: задачи планировщика идут под S4U и не наследуют
  пользовательское окружение сессии; User-scope им не виден.

  Требует запуска от администратора (запись в HKLM).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\apply-contour.ps1 -ContourEnv deploy\contour.env

.EXAMPLE
  # посмотреть, что изменится, ничего не записывая
  powershell -ExecutionPolicy Bypass -File deploy\windows\apply-contour.ps1 -ContourEnv deploy\contour.env -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ContourEnv,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ContourEnv)) {
    throw "Не найден файл контура: $ContourEnv (возьми за основу deploy\contour.example.env)"
}

if (-not $DryRun) {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Нужны права администратора: запись машинных переменных идёт в HKLM."
    }
}

# --- разбор contour.env (тот же файл, что читает bootstrap-gateway.sh) -----
# -Encoding UTF8 обязателен: Windows PowerShell 5.1 иначе читает файл как ANSI.
# У самого contour.env BOM нет намеренно — его же парсит bash в bootstrap.
$contour = @{}
foreach ($line in Get-Content $ContourEnv -Encoding UTF8) {
    $l = $line.Trim([char]0xFEFF).Trim()
    if (-not $l -or $l.StartsWith('#')) { continue }
    $i = $l.IndexOf('=')
    if ($i -lt 1) { continue }
    $k = $l.Substring(0, $i).Trim()
    $v = $l.Substring($i + 1).Trim().Trim('"').Trim("'")
    $contour[$k] = $v
}

# --- контракт: ключ contour.env -> машинная переменная --------------------
# Полный список того, что реально читают скрипты клиента. Если добавляешь
# Get-ContourValue в скрипт — добавь строку сюда, иначе переменная не доедет.
$map = [ordered]@{
    'CONTOUR_NAME'           = 'PXPIPE_CONTOUR_NAME'
    'GATEWAY_SSH_USER'       = 'PXPIPE_GATEWAY_SSH_USER'
    'GATEWAY_SSH_HOST'       = 'PXPIPE_GATEWAY_SSH_HOST'
    'GATEWAY_PXPIPE_PORT'    = 'PXPIPE_GATEWAY_PXPIPE_PORT'
    'CLIENT_PXPIPE_PORT'     = 'PXPIPE_CLIENT_PXPIPE_PORT'
    'CLIENT_WORK_PORT'       = 'PXPIPE_CLIENT_WORK_PORT'
    'CLIENT_CLASH_PORT'      = 'PXPIPE_CLIENT_CLASH_PORT'
    'CLIENT_LOG_DIR'         = 'PXPIPE_CLIENT_LOG_DIR'
    'KEEPER_HEARTBEAT_SEC'   = 'PXPIPE_KEEPER_HEARTBEAT_SEC'
    'KEEPER_PROBE_SEC'       = 'PXPIPE_KEEPER_PROBE_SEC'
    'KEEPER_PROBE_FAIL_MAX'  = 'PXPIPE_KEEPER_PROBE_FAIL_MAX'
    'KEEPER_PROBE_GRACE_SEC' = 'PXPIPE_KEEPER_PROBE_GRACE_SEC'
    'KEEPER_BACKOFF_MIN'     = 'PXPIPE_KEEPER_BACKOFF_MIN'
    'KEEPER_BACKOFF_MAX'     = 'PXPIPE_KEEPER_BACKOFF_MAX'
    'KEEPER_STABLE_SEC'      = 'PXPIPE_KEEPER_STABLE_SEC'
}

Write-Host "Контур: $ContourEnv" -ForegroundColor Cyan
$missingInFile = @()
foreach ($src in $map.Keys) {
    $dst = $map[$src]
    if (-not $contour.ContainsKey($src) -or [string]::IsNullOrWhiteSpace($contour[$src])) {
        $missingInFile += $src
        Write-Host ("  [нет ] {0,-24} -> {1}" -f $src, $dst) -ForegroundColor DarkYellow
        continue
    }
    $val = $contour[$src]
    $old = [Environment]::GetEnvironmentVariable($dst, 'Machine')
    $verb = if ($DryRun) { 'план' } elseif ($old -eq $val) { 'ок  ' } else { 'пишу' }
    if (-not $DryRun) {
        [Environment]::SetEnvironmentVariable($dst, $val, 'Machine')
        # чтобы текущая сессия тоже видела новое значение
        [Environment]::SetEnvironmentVariable($dst, $val, 'Process')
    }
    Write-Host ("  [{0}] {1,-28} = {2}" -f $verb, $dst, $val) -ForegroundColor Gray
}

if ($missingInFile.Count) {
    Write-Host ''
    Write-Host "В $ContourEnv не заданы: $($missingInFile -join ', ')" -ForegroundColor Yellow
    Write-Host "Скрипты подставят дефолты контура frankfurt-147 — для другого контура это почти наверняка неверно." -ForegroundColor Yellow
}

if ($DryRun) { Write-Host "`nDryRun: ничего не записано." -ForegroundColor DarkGray; return }

# --- проверка: читаем ровно то, что читают скрипты ------------------------
Write-Host "`nПроверка машинного окружения:" -ForegroundColor Cyan
$bad = 0
foreach ($dst in $map.Values) {
    $v = [Environment]::GetEnvironmentVariable($dst, 'Machine')
    $ok = -not [string]::IsNullOrWhiteSpace($v)
    if (-not $ok) { $bad++ }
    Write-Host ("  [{0}] {1,-28} = {2}" -f $(if($ok){'ok  '}else{'ПУСТО'}), $dst, $v) `
        -ForegroundColor $(if($ok){'Green'}else{'Red'})
}

Write-Host ''
if ($bad -eq 0) {
    Write-Host "Контур применён. Дальше: register-tasks.ps1, затем deploy\verify.ps1" -ForegroundColor Green
    Write-Host "ВАЖНО: перерегистрируй задачи после смены контура — процессы держат старое окружение." -ForegroundColor DarkGray
} else {
    Write-Host "ВНИМАНИЕ: $bad переменных контракта пусты — клиент пойдёт на дефолты frankfurt-147." -ForegroundColor Red
    exit 1
}
