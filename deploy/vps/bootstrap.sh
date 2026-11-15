#!/bin/bash
# Идемпотентная серверная часть: пользователь, каталоги, юнит, Caddy. Запускается на VPS.
set -euo pipefail

DOMAIN="${DOMAIN:-lot.bunker9.lol}"
APP=/opt/lot/app
DEPLOY=/opt/lot/deploy

id lot >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin lot

mkdir -p "$APP/data" "$APP/dist" "$DEPLOY"
chown -R lot:lot /opt/lot
chmod 750 /opt/lot "$APP"
chmod 750 "$APP/data"
chmod 755 "$DEPLOY"

install -m 644 "$DEPLOY/lot.service" /etc/systemd/system/lot.service

if ! grep -q "^${DOMAIN} {" /etc/caddy/Caddyfile; then
	cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
	cat >> /etc/caddy/Caddyfile <<CADDY

$(sed "s/lot\.bunker9\.lol/${DOMAIN}/g" "$DEPLOY/Caddyfile")
CADDY
fi

caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl daemon-reload
systemctl enable lot.service >/dev/null 2>&1 || true
systemctl reload caddy

echo "  каталог: $APP (lot:lot)"
echo "  юнит:    /etc/systemd/system/lot.service"
echo "  домен:   $DOMAIN → 127.0.0.1:3102"
