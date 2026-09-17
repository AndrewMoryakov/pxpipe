# pxpipe — развёртывание бэкенда

Инструкция для агента (Claude Code / Codex), который поднимает контур с нуля.
Подключение клиентов — отдельный документ: **[CLIENT.md](CLIENT.md)**.

Скрипты в `deploy/` — необязательный ускоритель. Ниже каждый шаг выполним руками;
где скрипт делает ровно то же, это указано.

---

## Что вообще строим

```
агент (Claude Code) ──► 127.0.0.1:47822 ──SSH──► gateway 127.0.0.1:47821 ──► pxpipe
  Windows-машина          локальный порт          VPS, только loopback        (docker)
                                                                                 │
                                          если IP gateway забанен Cloudflare     │
                                          172.30.250.1:3128 ◄──SSH── egress-хост │
                                             (docker bridge)      (свой tinyproxy)
```

**Единственный порт, открытый наружу на gateway, — 22.** pxpipe слушает только
loopback; попасть в него можно лишь через SSH-туннель. Отсюда следует главное:

> **pxpipe не хранит ни одного ключа и ни одного токена.** Проверено: в `/opt/pxpipe/.env`
> только `OPENAI_UPSTREAM` и `PXPIPE_MODELS`, `sk-` нет нигде. Он сквозной — клиент
> шлёт свои credentials, pxpipe их пересылает.
>
> **Поэтому добавление клиента не создаёт состояния на бэкенде.** Нужны только строка
> в `authorized_keys` и туннель. Ничего «регистрировать» не надо.

---

## 0. Что нужно получить у человека

Топология — можно коммитить, секретов нет. Заполненный рабочий пример:
[`contour.example.env`](contour.example.env).

| Параметр | Пример | Зачем |
|---|---|---|
| `GATEWAY_SSH_HOST` / `_USER` | `185.177.219.147` / `root` | где живёт бэкенд |
| `GATEWAY_PXPIPE_PORT` | `47821` | loopback-порт pxpipe **на gateway** |
| `PXPIPE_REPO` / `PXPIPE_REF` | форк + SHA | пин исходников |
| `OPENAI_UPSTREAM` | `https://chatgpt.com` | апстрим для codex |
| `PXPIPE_MODELS` | `claude-opus-5,...` | какие модели проксируются |
| `EGRESS_MODE` | `direct` \| `upstream-proxy` | **определяется тестом в §2, не спрашивается** |
| `EGRESS_SSH_HOST` / `_USER` / `_KEY` | `81.85.50.83` / `hopt` / … | только при `upstream-proxy` |

Секреты (SSH-ключи, токены) — **не сюда**. Они живут в `~/.ssh` и в окружении клиента.

### Канонические порты — не перепутай

Это самый вероятный способ сломать развёртывание:

| | порт | где |
|---|---|---|
| pxpipe слушает | **47821** | на gateway, `127.0.0.1` |
| клиент слушает | **47822** | на машине агента, `127.0.0.1` |
| туннель | `127.0.0.1:47822` → `gateway:47821` | |
| агент ходит в | `http://127.0.0.1:47822` | |

Проверено на живой системе: `docker-proxy` держит `127.0.0.1:47821` на gateway,
keeper держит `127.0.0.1:47822` и `::1:47822` на клиенте.

---

## 1. Бэкенд

Требуется Ubuntu, root, docker + compose plugin.

```bash
# 1.1 исходники, пин на проверенный SHA
git clone https://github.com/AndrewMoryakov/pxpipe.git /opt/pxpipe
cd /opt/pxpipe && git checkout <PXPIPE_REF>

# 1.2 конфиг
cat > .env <<'EOF'
OPENAI_UPSTREAM=https://chatgpt.com
PXPIPE_MODELS=claude-opus-5,claude-opus-4-8,claude-sonnet-5,claude-fable-5,gpt-5.6-terra,gpt-5.6-sol,gpt-5.6-lun
EOF

# 1.3 подъём
docker compose up -d
```

**Проверка — обязательна перед следующим шагом:**

```bash
ss -lntp | grep 47821
# ОЖИДАЕТСЯ: LISTEN 127.0.0.1:47821 users:(("docker-proxy",...))
# Если адрес 0.0.0.0 — pxpipe торчит наружу. Останови и чини compose, не продолжай.

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47821/v1/messages
# ОЖИДАЕТСЯ: 405
```

> **405 — это успех, не ошибка.** Значит «метод не тот», т.е. маршрут и TLS живы.
> Этот же признак используется дальше везде.

Скрипт: `bootstrap-gateway.sh` делает 1.1–1.3.

---

## 2. Сеть: как pxpipe выходит наружу

**Сначала тест, потом решение.** Выполнить на самом gateway:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 --noproxy '*' \
     https://api.anthropic.com/v1/messages
```

| Ответ | Значение | Что делать |
|---|---|---|
| `405` | хост ходит наружу сам | `EGRESS_MODE=direct` → **§2 закончен, переходи к §3** |
| `403` | IP забанен Cloudflare | `EGRESS_MODE=upstream-proxy` → §2.1 |
| таймаут | нет маршрута/DNS | чинить сеть хоста, это не про pxpipe |

### 2.1 Режим upstream-proxy

Нужен второй хост, у которого egress не забанен и который держит tinyproxy.

**SSH-туннель gateway → egress-хост**, поднимается systemd-юнитом
(шаблон: [`systemd/tashkent-proxy-tunnel.service.template`](systemd/tashkent-proxy-tunnel.service.template)):

```ini
[Service]
ExecStart=/usr/bin/ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes \
  -L 172.30.250.1:3128:127.0.0.1:3128 \
  -i /root/.ssh/id_ed25519_tashkent_tunnel hopt@81.85.50.83
Restart=always
RestartSec=15
```

Две вещи здесь неочевидны и обе стоили простоя:

> **Биндить на адрес docker-моста (`172.30.250.1`), а не на overlay/NetBird.**
> Overlay-адрес сменился сам по себе, туннель встал в неподнимаемое состояние.
> `172.30.250.1` — это шлюз docker-сети `pxpipe-local`, оттуда контейнер и ходит.

> **`RestartSec` обязателен.** Без паузы юнит насобирал **14409** перезапусков:
> fail2ban на egress-хосте увидел шквал SSH-коннектов и забанил gateway,
> после чего туннель не поднимался уже принципиально. Лечится с двух сторон —
> backoff здесь **и** `ignoreip` там (§2.2).

Передать прокси контейнеру (`compose.override.yml`):

```yaml
services:
  pxpipe:
    environment:
      HTTP_PROXY:  http://172.30.250.1:3128
      HTTPS_PROXY: http://172.30.250.1:3128
      NO_PROXY:    localhost,127.0.0.1,172.30.250.0/24
```

**Проверка:**
```bash
systemctl is-active tashkent-proxy-tunnel.service   # active
ss -lntp | grep 3128                                # LISTEN 172.30.250.1:3128 (ssh)
docker compose exec pxpipe curl -s -o /dev/null -w '%{http_code}\n' \
     --max-time 15 https://api.anthropic.com/v1/messages   # 405
```

### 2.2 На egress-хосте: не дать fail2ban забанить gateway

```bash
# /etc/fail2ban/jail.local
[DEFAULT]
ignoreip = 127.0.0.1/8 <GATEWAY_IP>
```
```bash
systemctl restart fail2ban
fail2ban-client status sshd      # IP gateway не должен быть в Banned IP list
```

### 2.3 Закрыть loopback-порты от чужих

pxpipe на `127.0.0.1` ещё не значит «недоступен»: контейнеры и overlay-интерфейсы
могут достать loopback. Нужен guard
([`systemd/pxpipe-localhost-guard.service`](systemd/pxpipe-localhost-guard.service)):

```bash
iptables -t raw -I PREROUTING -d 127.0.0.0/8 ! -i lo -j DROP
for p in 33080 33081 47821; do
  iptables -I INPUT -p tcp --dport $p ! -i lo -j DROP
done
```

> **Правила iptables не переживают ребут сами.** Ставь `netfilter-persistent`
> **и** systemd-юнит, применяющий их до `docker.service`. Проверяется это только
> настоящей перезагрузкой (§3), а не `iptables -L`.

---

## 3. Приёмка бэкенда

Не «настроено», а **проверено**. Порядок важен: сначала ребут, потом проверки.

```bash
reboot
```

После возврата машины (ждать ~60 с):

```bash
systemctl is-active tashkent-proxy-tunnel.service     # active   (если upstream-proxy)
docker ps --format '{{.Names}}\t{{.Status}}' | grep pxpipe   # Up
ss -lntp | grep -E '47821|3128'                       # оба слушают, 47821 на 127.0.0.1
iptables -S | grep -c 'dport 4782'                    # > 0  ← правила пережили ребут
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47821/v1/messages   # 405
```

Скрипт: `verify.sh` прогоняет это же.

Всё зелено → бэкенд готов, иди в **[CLIENT.md](CLIENT.md)**.

---

## 4. Каталог отказов (по симптому)

### `docker compose` поднялся, но `47821` слушает `0.0.0.0`
Порт-маппинг без `127.0.0.1`. Правь compose на `127.0.0.1:47821:...`. Не оставляй так:
это открытый прокси наружу.

### Контейнер отвечает 403 на api.anthropic.com
IP gateway забанен Cloudflare. Это §2.1, `upstream-proxy`. Не пытайся чинить DNS —
403 приходит после успешного TLS.

### Туннель до egress «active», но контейнер всё равно не ходит
Проверь **адрес бинда**: `ss -lntp | grep 3128`. Должен быть `172.30.250.1`, а не
overlay-адрес и не `127.0.0.1` (на `127.0.0.1` контейнер не достучится).

### `ssh: connect to host … Connection reset` в логе юнита, растёт счётчик перезапусков
fail2ban на egress-хосте забанил gateway. Разбанить (`fail2ban-client set sshd unbanip <IP>`),
добавить `ignoreip` (§2.2), убедиться что `RestartSec=15` стоит — иначе забанит снова.

### После ребута всё работает, кроме iptables
Правила не персистятся. `netfilter-persistent save` + юнит с `Before=docker.service`.
Проверять **только** ребутом.

### Юнит падает в рестарт-луп и забивает journal
Смотри `journalctl --disk-usage`. Был случай: `xray`/`zram` умерли после того, как
ядро уехало на новую версию, и рестарт-луп съедал диск. Модули, привязанные к ядру,
ставить как `linux-modules-extra-$(uname -r)` и перепроверять после обновления ядра.

### В дашборде видны 401
Почти наверняка **не** проблема бэкенда — см. раздел «401» в [CLIENT.md](CLIENT.md).
pxpipe не хранит учёток и не может отдать 401 «от себя».

---

## 5. Что проверено, а что нет

**Проверено на живом контуре `frankfurt-147`:**
- бэкенд, egress через upstream-proxy, guard, переживание ребута;
- keeper на клиенте — поймал реальный обрыв и поднял туннель за 5 с;
- сквозной запрос агента: HTTP 405 через `127.0.0.1:47822`.

**Не проверено — не считай это рабочим:**
- **второй контур с нуля никто не поднимал.** Слой параметризации
  (`contour.env` + `apply-contour.ps1`) прогонялся только вхолостую, `-DryRun`.
  Эта инструкция — источник истины; скрипты вторичны.
- `EGRESS_MODE=direct` — ветка не исполнялась ни разу (рабочий контур забанен).
- канарейка с уведомлениями в Telegram — **не входит в развёртывание**, бот не создан.
  Работающая канарейка при этом генерирует 401-шум, см. CLIENT.md.
