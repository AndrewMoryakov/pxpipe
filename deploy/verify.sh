#!/usr/bin/env bash
# =============================================================================
# pxpipe — приёмка gateway-контура со стороны сервера.
#
#   ./verify.sh contour.env
#
# Проверяет ЦЕПЬ, а не наличие конфигов: egress реально отвечает, pxpipe реально
# слушает, guard реально стоит в таблице. Клиентская половина приёмки —
# deploy/verify.ps1 (она и есть окончательные ворота: CLAUDE_OK / CODEX_OK).
# =============================================================================
set -uo pipefail

CONTOUR="${1:-contour.env}"
# Запасной путь: контур ищем и рядом со скриптом — иначе запуск из любого
# другого каталога (или после cd в вызывающем скрипте) падает на пустом месте.
if [ ! -f "$CONTOUR" ]; then
    _here="$(cd "$(dirname "$0")" && pwd)"
    [ -f "$_here/$CONTOUR" ] && CONTOUR="$_here/$CONTOUR"
fi
[ -f "$CONTOUR" ] || { echo "нет файла контура: $CONTOUR" >&2; exit 2; }
# shellcheck disable=SC1090
set -a; . "$CONTOUR"; set +a

fails=0
pass() { printf '  \033[32m[PASS]\033[0m %-24s %s\n' "$1" "$2"; }
fail() { printf '  \033[31m[FAIL]\033[0m %-24s %s\n' "$1" "$2"; fails=$((fails+1)); }
warn() { printf '  \033[33m[WARN]\033[0m %-24s %s\n' "$1" "$2"; }

printf '\n\033[36m=== ПРИЁМКА GATEWAY (%s) ===\033[0m\n\n' "${CONTOUR_NAME:-?}"

# --- 1. Исходники на ожидаемом коммите --------------------------------------
head_sha="$(git -C "$PXPIPE_DIR" rev-parse HEAD 2>/dev/null || echo none)"
if [ "$head_sha" = "$PXPIPE_REF" ]; then
    pass "source-pin" "HEAD = $PXPIPE_REF"
else
    fail "source-pin" "HEAD=$head_sha, ожидался $PXPIPE_REF"
fi

# --- 2. pxpipe слушает на loopback ------------------------------------------
if ss -lnt "( sport = :$GATEWAY_PXPIPE_PORT )" 2>/dev/null | grep -q "127.0.0.1:$GATEWAY_PXPIPE_PORT"; then
    pass "pxpipe-listen" "127.0.0.1:$GATEWAY_PXPIPE_PORT"
else
    fail "pxpipe-listen" "порт $GATEWAY_PXPIPE_PORT не слушает на loopback"
fi

# --- 3. Контейнер жив --------------------------------------------------------
status="$(docker inspect -f '{{.State.Status}}' pxpipe-pxpipe-1 2>/dev/null || echo none)"
if [ "$status" = "running" ]; then
    pass "container" "pxpipe-pxpipe-1 running"
else
    fail "container" "pxpipe-pxpipe-1 status=$status"
fi

# --- 4. Цепь egress реально отвечает ----------------------------------------
# 405 = апстрим принял TLS и отверг метод GET. Это доказательство маршрута.
if [ "$EGRESS_MODE" = "upstream-proxy" ]; then
    if systemctl is-active --quiet tashkent-proxy-tunnel.service; then
        pass "egress-tunnel" "tashkent-proxy-tunnel.service active"
    else
        fail "egress-tunnel" "unit не active"
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
        -x "http://${EGRESS_BIND_ADDR}:${EGRESS_PROXY_PORT}" \
        https://api.anthropic.com/v1/messages || echo 000)"
    if [ "$code" = "405" ] || [ "$code" = "401" ]; then
        pass "egress-chain" "через прокси -> HTTP $code (апстрим достижим)"
    else
        fail "egress-chain" "через прокси -> HTTP $code (ожидался 405/401)"
    fi
else
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --noproxy '*' \
        https://api.anthropic.com/v1/messages || echo 000)"
    if [ "$code" = "405" ] || [ "$code" = "401" ]; then
        pass "egress-chain" "напрямую -> HTTP $code (апстрим достижим)"
    else
        fail "egress-chain" "напрямую -> HTTP $code (ожидался 405/401)"
    fi
fi

# --- 5. Guard стоит в таблице ------------------------------------------------
missing=""
for p in $GUARD_PORTS; do
    iptables -t raw -C PREROUTING -d 127.0.0.1/32 ! -i lo -p tcp -m tcp --dport "$p" -j DROP 2>/dev/null \
        || missing="$missing $p"
done
if [ -z "$missing" ]; then
    pass "loopback-guard" "raw/PREROUTING DROP стоит для: $GUARD_PORTS"
else
    fail "loopback-guard" "нет правил для портов:$missing"
fi

# --- 6. Переживёт ли перезагрузку -------------------------------------------
# Разделяем "работает сейчас" и "поднимется само". Это разные утверждения.
for u in pxpipe-localhost-guard docker; do
    if systemctl is-enabled --quiet "$u.service" 2>/dev/null; then
        pass "boot-$u" "enabled"
    else
        fail "boot-$u" "НЕ enabled — после перезагрузки не поднимется"
    fi
done
if [ "$EGRESS_MODE" = "upstream-proxy" ]; then
    systemctl is-enabled --quiet tashkent-proxy-tunnel.service \
        && pass "boot-tunnel" "enabled" \
        || fail "boot-tunnel" "НЕ enabled"
fi

printf '\n'
if [ "$fails" -eq 0 ]; then
    printf '\033[32mСЕРВЕРНАЯ ЧАСТЬ ПРИНЯТА.\033[0m Теперь клиент: pwsh -File deploy/verify.ps1\n'
    exit 0
else
    printf '\033[31mСЕРВЕРНАЯ ЧАСТЬ НЕ ПРИНЯТА, провалено: %s\033[0m\n' "$fails"
    printf 'Разбор по слоям — deploy/docs/RATIONALE.md\n'
    exit 1
fi
