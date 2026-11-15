#!/bin/bash
# Выкладка «The Lot» на VPS. Запускать из корня проекта:
#
#   VPS_HOST=<IP сервера> ./deploy/vps/deploy.sh
#   SKIP_VERIFY=1 VPS_HOST=… ./deploy/vps/deploy.sh   # быстрый повтор без проверок
set -euo pipefail

HOST="${VPS_HOST:?укажи адрес сервера: VPS_HOST=1.2.3.4 ./deploy/vps/deploy.sh}"
DOMAIN="${DOMAIN:-lot.bunker9.lol}"
USER_AT="${VPS_USER:-root}@$HOST"
KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
APP=/opt/lot/app
ENV_FILE="${ENV_FILE:-$HOME/.config/draft-party/opencode.env}"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
BUN="${BUN:-$HOME/.bun/bin/bun}"

cd "$(dirname "$0")/../.."
echo "· проект: $(pwd)"
echo "· сервер: $USER_AT"

if [ "${SKIP_VERIFY:-0}" != "1" ]; then
	echo "· проверки перед выкладкой"
	"$BUN" tools/verify.mjs || { echo "  проверки не прошли — деплой остановлен"; exit 1; }
fi

echo "· собираю linux-бинарник"
rm -rf dist
"$BUN" build ./server.ts --compile --bytecode --target=bun-linux-x64 --outfile dist/lot >/dev/null
file dist/lot | sed 's/^/  /'
du -h dist/lot | sed 's/^/  /'

echo "· ssh"
ssh "${SSH_OPTS[@]}" "$USER_AT" "echo '  ok · ' \$(hostname)"

echo "· каталоги и пользователь"
ssh "${SSH_OPTS[@]}" "$USER_AT" "mkdir -p $APP/data $APP/dist /opt/lot/deploy && chown -R lot:lot /opt/lot"

echo "· код и статика"
rsync -az -e "ssh ${SSH_OPTS[*]}" public packs.json judge-profiles.json "$USER_AT:$APP/"

echo "· серверные файлы"
rsync -az -e "ssh ${SSH_OPTS[*]}" deploy/vps/ "$USER_AT:/opt/lot/deploy/"

if [ -f "$ENV_FILE" ]; then
	echo "· секреты"
	ssh "${SSH_OPTS[@]}" "$USER_AT" 'umask 077; cat > /opt/lot/app/.env' < "$ENV_FILE"
	ssh "${SSH_OPTS[@]}" "$USER_AT" "chown root:lot $APP/.env; chmod 640 $APP/.env"
else
	echo "· $ENV_FILE не найден — оставляю прежний .env"
fi

echo "· бинарник"
rsync -az -e "ssh ${SSH_OPTS[*]}" dist/lot "$USER_AT:$APP/dist/lot.new"
ssh "${SSH_OPTS[@]}" "$USER_AT" "set -e
install -m 750 -o lot -g lot $APP/dist/lot.new $APP/dist/lot
rm -f $APP/dist/lot.new
DOMAIN=$DOMAIN bash /opt/lot/deploy/bootstrap.sh
systemctl restart lot.service
sleep 1.5
systemctl is-active lot.service"

echo "· уборка старых файлов Node-версии"
ssh "${SSH_OPTS[@]}" "$USER_AT" "rm -f $APP/index.html $APP/app.js $APP/server.mjs $APP/styles.css $APP/README.md; chown -R lot:lot /opt/lot"

echo "· прогон smoke"
BASE="https://$DOMAIN" bash deploy/smoke.sh

echo "готово: https://$DOMAIN"
