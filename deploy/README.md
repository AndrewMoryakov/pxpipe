# pxpipe — развёртывание контура под ключ

Комплект переносит рабочее состояние «claude code / codex ходят через pxpipe»
на новый набор машин. Всё, что отличает один контур от другого, вынесено в
один файл — `contour.env`. Скрипты идемпотентны: повторный запуск приводит
хост к тому же состоянию.

## Из чего состоит контур

```
  Windows-клиент            gateway-хост              egress-хост
  (claude code, codex)      (185.177.219.147)         (81.85.50.83)
  ─────────────────         ─────────────────         ─────────────
  ANTHROPIC_BASE_URL   SSH  pxpipe в docker      SSH   tinyproxy
  127.0.0.1:47822    ─────> 127.0.0.1:47821    ─────>  127.0.0.1:3128
                            + localhost-guard           │
  keeper держит туннель     (iptables)                  └─> api.anthropic.com
  (задача планировщика)                                     chatgpt.com
```

**egress-хост нужен не всегда.** Он появляется только когда IP gateway
заблокирован апстримом (Cloudflare отдаёт 403). Если gateway ходит наружу сам —
`EGRESS_MODE=direct`, и вся правая колонка из схемы исчезает.

Как выбрать — выполнить **на самом gateway**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 --noproxy '*' \
     https://api.anthropic.com/v1/messages
```

`405` (или `401`) → маршрут и TLS живы, ставь `direct`. `403` → заблокирован,
ставь `upstream-proxy`. 405 — это успех, а не ошибка: «метод не тот».

## Порядок развёртывания

### 0. Описать контур

```bash
cp deploy/contour.example.env deploy/contour.env
$EDITOR deploy/contour.env
```

`contour.env` не коммитится. Секретов в нём нет — только топология; ключи и
токены живут в `~/.ssh` и в `/opt/pxpipe/.env` на gateway.

### 1. Gateway

```bash
scp -r deploy root@NEW_HOST:/tmp/pxpipe-deploy
ssh root@NEW_HOST 'cd /tmp/pxpipe-deploy && ./bootstrap-gateway.sh contour.env'
```

Ставит исходники на пин `PXPIPE_REF`, поднимает compose, вешает
`pxpipe-localhost-guard` и (при `upstream-proxy`) systemd-юнит SSH-туннеля к
egress-хосту.

### 2. Приёмка серверной половины

```bash
ssh root@NEW_HOST 'cd /tmp/pxpipe-deploy && ./verify.sh contour.env'
```

Проверяет цепь, а не наличие конфигов: egress реально отвечает, pxpipe реально
слушает, guard реально стоит в таблице iptables.

### 3. Windows-клиент

Из-под администратора, **строго в этом порядке**:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\apply-contour.ps1 -ContourEnv deploy\contour.env -DryRun
powershell -ExecutionPolicy Bypass -File deploy\windows\apply-contour.ps1 -ContourEnv deploy\contour.env
powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1
```

`apply-contour.ps1` — единственный писатель контракта. Он раскладывает значения
`contour.env` в **машинные** (HKLM) переменные `PXPIPE_*`, которые читают
остальные скрипты. Scope именно Machine, потому что задачи планировщика идут
под S4U и пользовательское окружение сессии не наследуют.

Сначала всегда `-DryRun`: он не требует прав, не пишет в HKLM и показывает
`[нет]` для каждого ключа, которого не хватает в файле. Если хоть один `[нет]` —
останавливайся: без этого шага новый контур молча заработает на **чужих** хостах
и портах. Ошибки не будет — будет неверное поведение.

> **Перерегистрируй задачи после каждой смены контура.** Запущенные процессы
> держат старое окружение; `register-tasks.ps1` перечитывает его заново.

### 4. Ворота приёмки

```powershell
pwsh -File deploy\verify.ps1
```

Контур развёрнут **только** если получены `CLAUDE_OK` и `CODEX_OK` — то есть
реальный запрос реальной моделью прошёл через pxpipe. Намеренно не считается
успехом: «порт слушает», «docker ps healthy», «в конфиге нужный URL».

## Кодировка скриптов — не косметика

`.ps1` здесь лежат в **UTF-8 с BOM**, и это требование, а не стиль.

Задачи планировщика запускают скрипты через `powershell.exe -File`, то есть
Windows PowerShell 5.1. Без BOM он читает файл как ANSI: кириллица в
комментариях и строках превращается в мусор, и файл перестаёт **парситься** —
задача падает до выполнения первой строки. Проверено: `apply-contour.ps1` без
BOM даёт `ParserError` под 5.1 и работает под pwsh 7, поэтому баг не виден,
пока не запустишь ровно так, как его запускает планировщик.

`contour.env`, `*.sh` и шаблоны — наоборот, **без BOM**: этот же файл парсит
bash в `bootstrap-gateway.sh`. `apply-contour.ps1` читает его с явным
`-Encoding UTF8`. Закреплено в `deploy/.gitattributes`.

## Состав

| Файл | Где исполняется | Что делает |
|---|---|---|
| `contour.example.env` | — | шаблон описания контура |
| `bootstrap-gateway.sh` | gateway (root) | разворачивает gateway с нуля |
| `verify.sh` | gateway | приёмка серверной половины |
| `systemd/pxpipe-localhost-guard.*` | gateway | iptables-guard loopback-портов |
| `systemd/tashkent-proxy-tunnel.service.template` | gateway | SSH-туннель к egress |
| `windows/apply-contour.ps1` | клиент (admin) | contour.env → машинные `PXPIPE_*` |
| `windows/register-tasks.ps1` | клиент (admin) | задачи планировщика: keeper, canary, туннели |
| `windows/pxpipe-tunnel.ps1` | клиент (задача) | keeper SSH-туннеля с backoff |
| `windows/start-tashkent-tunnels.ps1` | клиент (задача) | рабочие SSH-туннели |
| `windows/canary.ps1` | клиент (задача) | периодическая проверка живости |
| `windows/claude-pxpipe.ps1` | клиент | запуск claude code через pxpipe |
| `verify.ps1` | клиент | ворота приёмки: CLAUDE_OK / CODEX_OK |

## Что проверено, а что нет

Проверено на контуре `frankfurt-147` (gateway `185.177.219.147`, egress
`81.85.50.83`):

* gateway стоит на пине `PXPIPE_REF`, туннель поднимается сам после
  перезагрузки, guard переживает reboot;
* claude code и codex реально ходят через pxpipe — запросы видны в dashboard;
* все семь `.ps1` парсятся под Windows PowerShell 5.1;
* `apply-contour.ps1 -DryRun` на `contour.example.env` резолвит все 15
  переменных контракта без единого `[нет]`.

Не проверено:

* полный `apply-contour.ps1` **без** `-DryRun` на живой машине — на
  `frankfurt-147` клиент работает на встроенных дефолтах скриптов, машинные
  `PXPIPE_*` там пусты. Путь проверен только вхолостую;
* второй контур с нуля не поднимался. Комплект собран из рабочего первого,
  но «развернулось на другом хосте» — ещё не наблюдалось.
