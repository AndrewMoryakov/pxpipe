#!/usr/bin/env bash
# =============================================================================
# pxpipe — развёртывание gateway-контура с нуля.
#
#   scp -r deploy root@NEW_HOST:/tmp/pxpipe-deploy
#   ssh root@NEW_HOST 'cd /tmp/pxpipe-deploy && ./bootstrap-gateway.sh contour.env'
#
# Идемпотентно: повторный запуск приводит хост к тому же состоянию.
# =============================================================================
set -euo pipefail

CONTOUR="${1:-contour.env}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f "$CONTOUR" ] || { echo "нет файла контура: $CONTOUR (см. contour.example.env)" >&2; exit 2; }
# Приводим к абсолютному пути СРАЗУ: ниже скрипт делает cd в $PXPIPE_DIR, после
# чего относительное имя контура перестаёт резолвиться (ломало шаг приёмки).
CONTOUR="$(cd "$(dirname "$CONTOUR")" && pwd)/$(basename "$CONTOUR")"
# shellcheck disable=SC1090
set -a; . "$CONTOUR"; set +a

say() { printf '\n\033[36m=== %s ===\033[0m\n' "$*"; }
die() { printf '\033[31mОШИБКА: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Предусловия ---------------------------------------------------------
say "0. Предусловия"
command -v docker >/dev/null || die "docker не установлен"
docker compose version >/dev/null 2>&1 || die "docker compose v2 недоступен"
command -v iptables >/dev/null || die "iptables не установлен"
echo "  docker  $(docker --version | awk '{print $3}' | tr -d ,)"
echo "  compose $(docker compose version --short)"

# --- 1. Проверка egress ДО установки ---------------------------------------
# Смысл: если хост и так ходит наружу, а мы поставим upstream-proxy, мы
# добавим лишнюю точку отказа. Если наоборот — контур не заработает вообще.
say "1. Проверка egress (EGRESS_MODE=$EGRESS_MODE)"
direct_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --noproxy '*' \
    https://api.anthropic.com/v1/messages || echo 000)"
echo "  прямой запрос к api.anthropic.com -> HTTP $direct_code"
case "$direct_code:$EGRESS_MODE" in
  40[15]:direct)          echo "  ok: прямой выход работает" ;;
  40[15]:upstream-proxy)  echo "  ВНИМАНИЕ: хост ходит наружу сам, upstream-proxy избыточен." ;;
  403:direct)             die "хост заблокирован (403). Поставь EGRESS_MODE=upstream-proxy" ;;
  403:upstream-proxy)     echo "  ok: прямой выход заблокирован (403), идём через upstream" ;;
  *:direct)               die "нет связи с апстримом (код $direct_code), а режим direct" ;;
  *)                      echo "  код $direct_code — продолжаю, решает сквозная проверка" ;;
esac

# --- 2. Исходники на пиннутом SHA -------------------------------------------
say "2. Исходники -> $PXPIPE_DIR @ $PXPIPE_REF"
if [ -d "$PXPIPE_DIR/.git" ]; then
    git -C "$PXPIPE_DIR" fetch --all --tags --quiet
else
    git clone --quiet "$PXPIPE_REPO" "$PXPIPE_DIR"
fi
git -C "$PXPIPE_DIR" checkout --quiet "$PXPIPE_REF"
echo "  HEAD = $(git -C "$PXPIPE_DIR" rev-parse HEAD)"

# --- 3. .env (трекается compose, не git) ------------------------------------
say "3. $PXPIPE_DIR/.env"
cat > "$PXPIPE_DIR/.env" <<EOF
OPENAI_UPSTREAM=${OPENAI_UPSTREAM}
PXPIPE_MODELS=${PXPIPE_MODELS}
EOF
echo "  записан"

# --- 4. compose.override.yml -------------------------------------------------
# Намеренно untracked: переживает 'git reset --hard origin/master'.
say "4. compose.override.yml (режим: $EGRESS_MODE)"
if [ "$EGRESS_MODE" = "upstream-proxy" ]; then
    cat > "$PXPIPE_DIR/compose.override.yml" <<EOF
# Сгенерирован bootstrap-gateway.sh для контура ${CONTOUR_NAME}. Untracked.
# Egress через внешний tinyproxy: IP этого хоста заблокирован апстримом (403).
# ${EGRESS_BIND_ADDR} = gateway docker-сети pxpipe-local = host-сторона
# SSH-туннеля (unit: tashkent-proxy-tunnel.service).
# NODE_USE_ENV_PROXY=1 обязателен: Node 24 (undici) иначе игнорирует HTTPS_PROXY.
services:
  pxpipe:
    environment:
      - NODE_USE_ENV_PROXY=1
      - HTTPS_PROXY=http://${EGRESS_BIND_ADDR}:${EGRESS_PROXY_PORT}
      - HTTP_PROXY=http://${EGRESS_BIND_ADDR}:${EGRESS_PROXY_PORT}
      - NO_PROXY=${EGRESS_NO_PROXY}
EOF
else
    cat > "$PXPIPE_DIR/compose.override.yml" <<EOF
# Сгенерирован bootstrap-gateway.sh для контура ${CONTOUR_NAME}. Untracked.
# EGRESS_MODE=direct: хост ходит к апстриму сам, прокси не нужен.
services:
  pxpipe: {}
EOF
fi
echo "  записан"

# --- 5. SSH-туннель до egress-хоста -----------------------------------------
say "5. tashkent-proxy-tunnel.service"
if [ "$EGRESS_MODE" = "upstream-proxy" ]; then
    [ -f "$EGRESS_SSH_KEY" ] || die "нет ключа $EGRESS_SSH_KEY — положи его до запуска"
    # StrictHostKeyChecking=yes требует известного хоста. Прописываем заранее,
    # иначе unit будет молча падать в рестарт-петлю.
    ssh-keyscan -H "$EGRESS_SSH_HOST" >> /root/.ssh/known_hosts 2>/dev/null || true
    sort -u -o /root/.ssh/known_hosts /root/.ssh/known_hosts

    sed -e "s|@EGRESS_BIND_ADDR@|${EGRESS_BIND_ADDR}|g" \
        -e "s|@EGRESS_PROXY_PORT@|${EGRESS_PROXY_PORT}|g" \
        -e "s|@EGRESS_SSH_KEY@|${EGRESS_SSH_KEY}|g" \
        -e "s|@EGRESS_SSH_USER@|${EGRESS_SSH_USER}|g" \
        -e "s|@EGRESS_SSH_HOST@|${EGRESS_SSH_HOST}|g" \
        "$HERE/systemd/tashkent-proxy-tunnel.service.template" \
        > /etc/systemd/system/tashkent-proxy-tunnel.service
    systemctl daemon-reload
    systemctl enable --now tashkent-proxy-tunnel.service
    echo "  $(systemctl is-enabled tashkent-proxy-tunnel.service) / $(systemctl is-active tashkent-proxy-tunnel.service)"
else
    systemctl disable --now tashkent-proxy-tunnel.service 2>/dev/null || true
    echo "  не нужен (EGRESS_MODE=direct), выключен"
fi

# --- 6. Защита loopback-портов ----------------------------------------------
# На хосте может НЕ быть netfilter-persistent. Тогда этот unit — единственное,
# что возвращает raw/PREROUTING DROP после перезагрузки. Ставим всегда.
say "6. pxpipe-localhost-guard.service"
sed -e "s|@GUARD_PORTS@|${GUARD_PORTS}|g" \
    "$HERE/systemd/pxpipe-localhost-guard.sh.template" \
    > /usr/local/sbin/pxpipe-localhost-guard.sh
chmod 0755 /usr/local/sbin/pxpipe-localhost-guard.sh
cp "$HERE/systemd/pxpipe-localhost-guard.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pxpipe-localhost-guard.service
echo "  $(systemctl is-enabled pxpipe-localhost-guard.service) / $(systemctl is-active pxpipe-localhost-guard.service)"
if ! command -v netfilter-persistent >/dev/null; then
    echo "  (netfilter-persistent отсутствует — guard единственный механизм, это ожидаемо)"
fi

# --- 7. Подъём стека ---------------------------------------------------------
say "7. docker compose up"
cd "$PXPIPE_DIR"
docker compose up -d
docker compose ps --format '  {{.Name}} | {{.Status}} | {{.Ports}}'

# --- 8. Приёмка --------------------------------------------------------------
say "8. Приёмка"
exec "$HERE/verify.sh" "$CONTOUR"
