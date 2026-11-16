# Деплой на VPS

Тот же сервер, что и `bunker9.lol`, отдельный процесс и отдельный пользователь.

```
интернет → Cloudflare → Caddy (TLS) → lot.service :3102 → бинарник Bun
                                                  ↓
                                        /opt/lot/app/data/lot.db
```

## Что на сервере

| Что | Значение |
| --- | --- |
| Каталог | `/opt/lot/app` (`lot:lot`, `750`) |
| Бинарник | `/opt/lot/app/dist/lot` (собран `bun build --compile --bytecode`) |
| Данные | `/opt/lot/app/data/lot.db` (`lot:lot`, единственное место для записи) |
| Секреты | `/opt/lot/app/.env` (`root:lot`, `640`) |
| Юнит | `/etc/systemd/system/lot.service` |
| Caddy | блок `lot.bunker9.lol` → `reverse_proxy 127.0.0.1:3102` |
| DNS | Cloudflare `A lot.bunker9.lol → <IP сервера>`, proxied |

Соседний `bunker9.lol` работает на своём `:3100` и не затрагивается.

## Выкладка

```sh
VPS_HOST=<IP сервера> ./deploy/vps/deploy.sh
SKIP_VERIFY=1 VPS_HOST=<IP сервера> ./deploy/vps/deploy.sh   # без проверок
```

Скрипт: проверки (`tools/verify.mjs`) → сборка linux-бинарника → rsync кода и статики →
`.env` из `~/.config/draft-party/opencode.env` → `bootstrap.sh` (юнит, Caddy) →
`systemctl restart lot` → `deploy/smoke.sh`.

`bootstrap.sh` идемпотентен: пользователь, каталоги, юнит, блок Caddy (если его ещё нет), `caddy validate`, reload.

## Эксплуатация

```sh
journalctl -u lot.service -n 50 --no-pager   # логи
systemctl restart lot.service                # перезапуск
systemctl status lot caddy bunker9 --no-pager
curl -sS https://lot.bunker9.lol/health
BASE=https://lot.bunker9.lol ./deploy/smoke.sh
```

## Откат

```sh
# предыдущий бинарник держим рядом
ssh root@<IP сервера> 'cp /opt/lot/app/dist/lot /opt/lot/app/dist/lot.prev'
# вернуть
ssh root@<IP сервера> 'cp /opt/lot/app/dist/lot.prev /opt/lot/app/dist/lot && systemctl restart lot'
```

База: `data/lot.db` + `-wal`/`-shm`. Перед рискованным обновлением:

```sh
ssh root@<IP сервера> 'systemctl stop lot && cp /opt/lot/app/data/lot.db* /root/ && systemctl start lot'
```

## Секреты

`TMDB_READ_ACCESS_TOKEN` создаётся на <https://www.themoviedb.org/settings/api>.
Без токена паки фильмов и сериалов отвечают «TMDb не настроен» — это ожидаемо.
Ключи не попадают в браузер: клиент общается только со своим `/api`-подобным `/act/:cmd`.

## Сжатие и SSE

| Слой | Что сжимается | Порядок |
| --- | --- | --- |
| Caddy (origin) | CSS, JS, HTML, JSON | **zstd → gzip** (brotli в стоковом Caddy отсутствует) |
| Cloudflare (edge) | то, что пришло несжатым | **brotli** — когда origin отдал `identity` |

`text/event-stream` намеренно **не сжимается**: Caddy его пропускает, чтобы чанки уходили без буферизации. Проверка:

```sh
curl -sSI -H 'Accept-Encoding: zstd, br, gzip' https://lot.bunker9.lol/public/style.css   # gzip от CF
curl -sS -D - -o /dev/null -N -b jar https://lot.bunker9.lol/stream                        # без content-encoding
```

Первичный патч больше не дублирует уже отрисованную страницу: `#app` несёт `data-version`, и `/stream?v=N` молчит, пока версия комнаты не изменится.

## Ограничения CSP

Datastar исполняет выражения (`@post`, `data-*`) через `new Function`, поэтому в CSP есть
`'unsafe-eval'`. В bunker9 CSP нет совсем; здесь остальные директивы строгие, а весь
пользовательский текст экранируется на сервере.
