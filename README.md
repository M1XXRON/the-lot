# The Lot

![Bun](https://img.shields.io/badge/Bun-1.4.4-000?logo=bun&logoColor=fff)
![Datastar](https://img.shields.io/badge/Datastar-1.0.5-ff3500)
![SQLite](https://img.shields.io/badge/SQLite-bun%3Asqlite-003B57?logo=sqlite&logoColor=fff)
![Players](https://img.shields.io/badge/2_players-one_winner-9e7830)
![License](https://img.shields.io/badge/license-MIT-245245)
[![verify](https://github.com/M1XXRON/the-lot/actions/workflows/verify.yml/badge.svg)](https://github.com/M1XXRON/the-lot/actions/workflows/verify.yml)

Дом драфта на двоих: пять пиков, двадцать монет, один победитель. Сервер на Bun, состояние на сервере, UI обновляется HTML-патчами по SSE через Datastar.

**Прод:** <https://lot.bunker9.lol> · **Код:** <https://github.com/M1XXRON/the-lot> · **Лицензия:** MIT

## Стек

| Слой | Что |
| --- | --- |
| Рантайм | Bun 1.4 (`Bun.serve`, `bun:sqlite`, `bun build --compile`) |
| Транспорт | SSE `/stream` + `POST /act/:cmd`, патчи `datastar-patch-elements` |
| Клиент | Datastar 1.0.5 (вендор), `public/experience.js`, `public/sound.js` |
| Стили | `public/style.css` (токены, база), `redesign.css` (лендинг, каталог), `stages.css` (торги) |
| Данные | `packs.json` (222 пака), `judge-profiles.json`, SQLite `data/lot.db` |
| Судья | OpenCodeGo (`gpt-6-luna`) + TMDb + mock |
| Деплой | systemd `lot.service`, Caddy, Cloudflare |

## Структура

```
server.ts          лендинг, комната, /stream, /act/:cmd, статика, уборка комнат
src/engine.js      комнаты, фазы, раскрытие, экономика, ставки, голосование
src/render.ts      состояние → HTML (патчи по id)
src/store.ts       bun:sqlite: rooms, sessions, games; отложенная запись
src/ai.ts          OpenAI-совместимый клиент, три режима судьи, TMDb, mock
src/content.js     паки и профили судейства
public/            style.css + redesign.css + stages.css, experience.js, sound.js, vendor/
tools/             verify, http-e2e, ui-e2e, balance-sim, shot, lib
test/sim-bun.mjs   боты по HTTP
deploy/            smoke.sh, vps/ (bootstrap, deploy, lot.service, Caddyfile)
data/              lot.db (в git не попадает)
screenshots/       актуальные кадры десктопа и телефона
```

## Локально

```sh
bun install          # только dev-типы и tsc
bun run dev          # http://localhost:4173
LOT_MOCK=1 bun run dev   # судья без внешних вызовов
```

Секреты читаются из `~/.config/draft-party/opencode.env` (или `LOT_ENV`), на проде — из `EnvironmentFile` юнита:

```
OPENCODEGO_BASE_URL=https://opencode.ai/inference/openai/v1
OPENCODEGO_MODEL=gpt-6-luna
OPENCODEGO_API_KEY=...
TMDB_READ_ACCESS_TOKEN=...
```

## Проверки

```sh
bun run check        # tsc --noEmit
bun run verify       # типы + экономика + HTTP-e2e + UI-e2e
bun run sim          # 3000 партий ботов по экономике
bun run test         # боты по HTTP, N партий
bun run test:http    # полная партия без браузера
bun run test:ui      # два браузера + скриншоты
bun run shots        # обновить screenshots/
```

## CI

`.github/workflows/verify.yml` на каждый пуш и PR гоняет две задачи:

- **check** — `bun install --frozen-lockfile`, `tsc --noEmit`, экономическая симуляция (4 320 партий) и HTTP-e2e (8 сценариев);
- **ui** — ставит Chromium для Playwright и прогоняет UI-e2e на двух браузерах, обновляя снимки.

Локально то же самое: `bun run verify`.

## Как идёт партия

`lobby → toss → auction → judging → results`

- Хост выбирает пак и судью, монета решает, кто открывает торги.
- Ставка: `opening` (1–5) или `+$1` к текущей; перебитая ставка возвращается.
- Пас при чужой ставке отдаёт лот лидеру; два паса — лот пропущен.
- Пятый пик закрывает драфт; оставшиеся лоты уходят второму игроку бесплатно.
- Судья: `party` (Luna), `character-power` (только каноничная сила), `athlete-performance` (только статистика), `internet-ratings` (TMDb как есть).

## Инварианты

- Бюджет 20 монет: `остаток + потрачено = 20` в любой момент.
- Максимум 5 пиков на игрока, 10 лотов в партии.
- Если все пасуют, недостающие пики раздаются из пропущенных лотов — у обоих всегда ровно пять предметов.
- Загруженный пак проверяется на сервере: ≤64 КБ, 5–60 уникальных предметов, управляющие символы вырезаются; в общий каталог он не попадает.
- Повтор оценки ограничен: не больше 3 раз и не чаще раза в 8 секунд; смена судьи отменяет незавершённый запрос к модели.
- Действия валидируются на сервере: ход, бюджет, фаза, место.
- Комнаты и сессии переживают рестарт; партии пишутся в `games`.

## Ограничения

- Datastar исполняет выражения через `new Function`, поэтому CSP содержит `'unsafe-eval'` (как в bunker9, где CSP нет вовсе). Остальные директивы строгие: `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
- TMDb-оценки кешируются в памяти процесса на 7 дней.
- Комнаты без активности живут 12 часов; пустые лобби убираются раньше.
