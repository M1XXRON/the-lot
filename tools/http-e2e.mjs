// HTTP-e2e: полная партия без браузера. Формы, экшены, проверка HTML на каждом шаге.
import { assert, client, roomCodeFrom, startServer } from "./lib.mjs";

const marker = (html, text) => html.includes(text);

/* ── тестовый источник картинок: локальный сервер с валидным PNG ── */

function makePng(width, height) {
  const raw = new Uint8Array((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[offset++] = Math.round((x * 255) / width);
      raw[offset++] = Math.round((y * 255) / height);
      raw[offset++] = 96;
    }
  }
  const ihdr = new Uint8Array(13);
  const head = new DataView(ihdr.buffer);
  head.setUint32(0, width);
  head.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0);
    return out;
  };
  // PNG требует zlib-обёртку, а Bun.deflateSync даёт голый deflate: добавляем заголовок и adler32.
  const deflated = new Uint8Array(Bun.deflateSync(raw));
  const zlib = new Uint8Array(deflated.length + 6);
  zlib[0] = 0x78;
  zlib[1] = 0x9c;
  zlib.set(deflated, 2);
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  new DataView(zlib.buffer).setUint32(zlib.length - 4, ((b << 16) | a) >>> 0);

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib),
    chunk("IEND", new Uint8Array()),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    png.set(part, cursor);
    cursor += part.length;
  }
  return png;
}

const PNG = makePng(240, 180);
const PNG_ALT = makePng(120, 90);
const imageSource = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/cover.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
    if (url.pathname === "/cover2.png") return new Response(PNG_ALT, { headers: { "content-type": "image/png" } });
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/cover2.png" } });
    if (url.pathname === "/text") return new Response("not an image at all", { headers: { "content-type": "image/png" } });
    if (url.pathname === "/big") return new Response(new Uint8Array(7 * 1024 * 1024), { headers: { "content-type": "image/png" } });
    if (url.pathname === "/anilist") {
      const raw = await request.text().catch(() => "");
      let q = "";
      try { q = String(JSON.parse(raw)?.variables?.q ?? ""); } catch { /* пусто */ }
      // настоящий AniList не находит персонажа, если в запросе есть название пака
      const characters = q.toLowerCase().includes("anime characters")
        ? []
        : [{ name: { full: q || "Test" }, image: { large: `${IMAGE_BASE}/cover2.png` }, siteUrl: "https://anilist.co/character/1" }];
      return new Response(JSON.stringify({ data: { Page: { characters } } }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/w/api.php")) {
      const q = (url.searchParams.get("gsrsearch") || "").toLowerCase();
      const pages = q.startsWith("soda ")
        ? [{ title: "Soda", thumbnail: { source: `${IMAGE_BASE}/cover2.png`, width: 400, height: 600 } }]
        : [];
      return new Response(JSON.stringify({ query: { pages } }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/commons") {
      const body = {
        query: {
          pages: [
            {
              title: "File:Test pizza.jpg",
              imageinfo: [
                {
                  thumburl: `${IMAGE_BASE}/cover.png`,
                  descriptionurl: "https://example.org/wiki/File:Test_pizza.jpg",
                  width: 1200,
                  extmetadata: {
                    Artist: { value: "<a href='#'>Jane Doe</a>" },
                    LicenseShortName: { value: "CC BY-SA 4.0" },
                  },
                },
              ],
            },
          ],
        },
      };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    return new Response("nope", { status: 404 });
  },
});
const IMAGE_BASE = `http://127.0.0.1:${imageSource.port}`;
/** Токен для проверки операторского /health: тест не зависит от окружения. */
const OPS_TOKEN = "ops-test";

async function playLocal(server) {
  const host = client(server.base);
  const landing = await host.html("/");
  assert(landing.status === 200, "лендинг не отдался");
  assert(marker(landing.html, "Открыть дом"), "на лендинге нет формы создания");

  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  assert(created.status === 303, `создание комнаты вернуло ${created.status}`);
  const { code } = roomCodeFrom(created);

  const room = await host.html(`/r/${code}`);
  assert(room.status === 200, "комната не открылась");
  assert(room.html.includes('id="room"'), "нет корня комнаты");
  assert(room.html.includes("Выберите пак"), "лобби не отрисовано");
  assert(room.html.includes("ALEX") && (room.html.includes("ИГРОК 2") || room.html.includes("PLAYER 2")), "локальный режим не занял два места");
  assert(room.html.includes("Передавайте устройство после ставки"), "нет подсказки локального режима");

  const packed = await host.actJson("pack", { pack: "free-fast-food" });
  assert(packed.status === 204, `выбор пака вернул ${packed.status}`);

  const toss = await host.act("toss");
  assert(toss.status === 204, `бросок монеты вернул ${toss.status}`);
  const tossPage = await host.html(`/r/${code}`);
  assert(tossPage.html.includes('data-phase="toss"'), "фаза после монеты не toss");
  assert(/ПЕРВЫЙ ХОД/.test(tossPage.html), "монета не выбрала первого");

  const begin = await host.act("begin");
  assert(begin.status === 204, `старт драфта вернул ${begin.status}`);

  let actions = 0;
  let finished = false;
  for (let i = 0; i < 120; i += 1) {
    const page = await host.html(`/r/${code}`);
    if (page.html.includes('data-phase="results"')) {
      finished = true;
      break;
    }
    assert(page.html.includes('data-phase="auction"'), "партия застряла вне торгов");
    const bidDisabled = /id="bid-button"[^>]*disabled/.test(page.html);
    const response = bidDisabled ? await host.act("pass") : await host.act("bid");
    assert(response.status === 204, `торг вернул ${response.status}`);
    actions += 1;
  }
  assert(finished, `партия не завершилась за ${actions} действий`);

  const results = await host.html(`/r/${code}`);
  assert(results.html.includes("ПОСЛЕ ИГРЫ"), "нет отчёта после партии");
  assert(results.html.includes("ПОЛНЫЙ ПРОТОКОЛ"), "нет журнала торгов");
  assert((results.html.match(/result-pick-rating/g) ?? []).length >= 10, "меньше десяти оценок");
  assert(results.html.includes("ПИКОВ"), "нет статистики партии");
  assert(results.html.includes("data-copy="), "нет кнопки копирования итога");
  assert(results.html.includes("norms"), "нет блока норм оценивания");
  assert(results.html.includes("1–2"), "в нормах нет нижней полосы");

  const again = await host.act("again");
  assert(again.status === 204, "повтор партии не сработал");
  const lobbyAgain = await host.html(`/r/${code}`);
  assert(lobbyAgain.html.includes('data-phase="lobby"'), "после повтора не лобби");

  return { code, actions };
}

async function playOnline(server) {
  const host = client(server.base);
  const guest = client(server.base);

  const created = await host.form("/act/create", { mode: "online", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  await host.actJson("pack", { pack: "free-soda" });

  const guestLobby = await guest.html(`/r/${code}`);
  assert(guestLobby.html.includes("ЗАНЯТЬ МЕСТО"), "гость не увидел свободное место");

  const joined = await guest.form("/act/join", { code, name: "MARIA" });
  assert(joined.status === 303, "вход по коду не сработал");
  const lobby = await host.html(`/r/${code}`);
  assert(lobby.html.includes("MARIA"), "хозяин не увидел второго игрока");

  const toss = await host.act("toss");
  assert(toss.status === 204, "хозяин не бросил монету");
  await host.act("begin");

  const guestPage = await guest.html(`/r/${code}`);
  assert(guestPage.html.includes('data-phase="auction"'), "гость не попал в торги");

  // играем от лица того, чей ход: активная карточка подсказывает место
  for (let i = 0; i < 120; i += 1) {
    const page = await host.html(`/r/${code}`);
    if (page.html.includes('data-phase="results"')) break;
    const seatOneActive = /player-card--one[^"]*is-active/.test(page.html);
    const seatTwoActive = /player-card--two[^"]*is-active/.test(page.html);
    assert(seatOneActive || seatTwoActive, "нет активного игрока");
    const actor = seatOneActive ? host : guest;
    const bidDisabled = /id="bid-button"[^>]*disabled/.test(page.html);
    const response = bidDisabled ? await actor.act("pass") : await actor.act("bid");
    assert(response.status === 204, `действие вернуло ${response.status}`);
  }

  const results = await host.html(`/r/${code}`);
  assert(results.html.includes('data-phase="results"'), "онлайн-партия не завершилась");
  return { code };
}

async function humanJudge(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  await host.actJson("judge", { mode: "human" });
  await host.act("toss");
  await host.act("begin");
  for (let i = 0; i < 120; i += 1) {
    const page = await host.html(`/r/${code}`);
    if (page.html.includes('data-phase="results"')) break;
    const bidDisabled = /id="bid-button"[^>]*disabled/.test(page.html);
    await (bidDisabled ? host.act("pass") : host.act("bid"));
  }
  const waiting = await host.html(`/r/${code}`);
  assert(waiting.html.includes("ВЕРДИКТ ЗА ВАМИ"), "нет ручного судейства");
  const vote = await host.actJson("vote", { vote: 1 });
  assert(vote.status === 204, "голос не принят");
  const voted = await host.html(`/r/${code}`);
  assert(/ПОБЕЖДАЕТ|WINS/i.test(voted.html), "после голоса нет победителя");
  return { code };
}

async function languageSwitch(server) {
  const guest = client(server.base);
  const ru = await guest.html("/");
  assert(ru.html.includes("Открыть дом"), "русский лендинг не отрисован");
  const switched = await guest.form("/act/lang", { lang: "en", next: "/" });
  assert(switched.status === 303, `переключение языка вернуло ${switched.status}`);
  const en = await guest.html("/");
  assert(en.html.includes("Open the house"), "английский лендинг не отрисован");
  assert(en.html.includes('<html lang="en">'), "не выставился lang=en");
  assert(!en.html.includes("СОЗДАТЬ КОМНАТУ"), "русские строки остались в английской версии");
  const back = await guest.form("/act/lang", { lang: "ru", next: "/" });
  assert(back.status === 303, "обратное переключение не сработало");
  return { code: "lang" };
}

async function posterPlate(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  await host.act("toss");
  await host.act("begin");
  const page = await host.html(`/r/${code}`);
  assert(page.html.includes("lot-plate"), "у лота нет визуальной плашки");
  assert(page.html.includes("band-main"), "полоса лота не отрисована");
  return { code };
}

async function bidLadder(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  await host.act("toss");
  await host.act("begin");
  await host.act("bid");
  const step = await host.actJson("step", { step: 3 });
  assert(step.status === 204, `шаг ставки вернул ${step.status}`);
  const page = await host.html(`/r/${code}`);
  assert(/BID|СТАВКА/.test(page.html) && page.html.includes("$4"), "ставка не поднялась на выбранный шаг");
  assert(page.html.includes("ladder-chip is-selected"), "нет активного шага");
  const tooMuch = await host.actJson("step", { step: 99 });
  assert(tooMuch.status === 204, "шаг вне диапазона не обработан");
  const clamped = await host.html(`/r/${code}`);
  assert(clamped.html.includes("$6"), "шаг не ограничился пятью");
  return { code };
}

async function customPack(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  const payload = { name: "Cosmos", emoji: "🚀", items: ["Moon", "Mars", "Venus", "Jupiter", "Saturn", "Neptune"] };
  const uploaded = await host.upload("/act/custom", { body: JSON.stringify(payload) });
  assert(uploaded.status === 303, `загрузка пака вернула ${uploaded.status}`);
  const lobby = await host.html(`/r/${code}`);
  assert(lobby.html.includes("Cosmos"), "свой пак не появился в лобби");
  assert(lobby.html.includes("custom-pack-card is-loaded"), "нет плашки загруженного пака");
  const reset = await host.act("custom-clear");
  assert(reset.status === 204, "сброс своего пака не сработал");
  const afterReset = await host.html(`/r/${code}`);
  assert(!afterReset.html.includes("custom-pack-card is-loaded"), "свой пак не сбросился");
  assert(afterReset.html.includes("СОХРАНЁННЫЕ ПАКИ"), "сброс стёр сохранённый пак игрока");

  await host.upload("/act/custom", { body: JSON.stringify(payload) });
  await host.act("toss");
  await host.act("begin");
  const page = await host.html(`/r/${code}`);
  const lotMatch = page.html.match(/id="auction-title"[^>]*>([^<]+)</);
  const lot = lotMatch?.[1]?.trim();
  assert(payload.items.includes(lot), `лот «${lot}» не из своего пака`);
  return { code };
}

/** Сохранённые паки переезжают в новый стол и загружаются одним кликом. */
async function savedPacks(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  const items = ["Moon", "Mars", "Venus", "Jupiter", "Saturn"];
  await host.upload("/act/custom", { body: JSON.stringify({ name: "Orbits", emoji: "🪐", items }) });

  // второй стол того же игрока в другом клиенте-сессии видит только свою библиотеку
  const second = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code: fresh } = roomCodeFrom(second);
  const lobby = await host.html(`/r/${fresh}`);
  assert(lobby.html.includes("Orbits"), "сохранённый пак не переехал в новый стол");
  const id = lobby.html.match(/custom-load'[^)]*id: '([^']+)'/)?.[1];
  assert(id, "в списке нет кнопки загрузки пака");

  const missing = await host.actJson("custom-load", { id: "cp-nope" });
  assert(missing.status === 404, `загрузка несуществующего пака вернула ${missing.status}`);
  const load = await host.actJson("custom-load", { id });
  assert(load.status === 204, `загрузка сохранённого пака вернула ${load.status}`);
  const loaded = await host.html(`/r/${fresh}`);
  assert(loaded.html.includes("custom-pack-card is-loaded"), "пак не встал на стол");
  assert(loaded.html.includes("custom-library-row is-active"), "активный пак не отмечен в списке");

  await host.act("toss");
  await host.act("begin");
  const auction = await host.html(`/r/${fresh}`);
  const lot = auction.html.match(/id="auction-title"[^>]*>([^<]+)</)?.[1]?.trim();
  assert(items.includes(lot), `лот «${lot}» не из сохранённого пака`);

  // первый стол того же игрока тоже видит библиотеку
  const first = await host.html(`/r/${code}`);
  assert(first.html.includes("Orbits"), "в первом столе нет списка паков");
  return { code: fresh };
}

/** /health без токена — только жизнь процесса; детали — по операторскому токену. */
async function opsHealth(server) {
  const open = await (await fetch(`${server.base}/health`)).json();
  assert(open.ok === true, "health не ok");
  assert(open.rooms === undefined && open.ai === undefined && open.db === undefined, "публичный health раскрывает внутренние счётчики");
  const wrong = await (await fetch(`${server.base}/health?token=nope`)).json();
  assert(wrong.rooms === undefined, "health отдал детали по неверному токену");
  const ops = await (await fetch(`${server.base}/health`, { headers: { "x-lot-ops": OPS_TOKEN } })).json();
  assert(typeof ops.rooms === "number" && typeof ops.ai?.model === "string", "операторский health без деталей");
  return { code: "health" };
}

/** Витрина для поисковиков и офлайн-оболочка. */
async function discoverability(server) {
  const sitemap = await fetch(`${server.base}/sitemap.xml`);
  const xml = await sitemap.text();
  assert(sitemap.status === 200, `sitemap вернул ${sitemap.status}`);
  assert(xml.includes("<loc>") && /<loc>http:\/\/[^<]+\/<\/loc>/.test(xml), "sitemap без адреса дома");
  const robots = await (await fetch(`${server.base}/robots.txt`)).text();
  assert(/Sitemap: http:\/\/[^\s]+\/sitemap\.xml/.test(robots), "robots без ссылки на sitemap");

  const sw = await fetch(`${server.base}/sw.js`);
  const js = await sw.text();
  assert(sw.status === 200, `sw.js вернул ${sw.status}`);
  assert((sw.headers.get("content-type") ?? "").includes("javascript"), "sw.js без js-типа");
  assert(!js.includes("__LOT_ASSET_VERSION__"), "в sw.js не подставилась версия");
  assert((sw.headers.get("cache-control") ?? "").includes("no-store"), "sw.js кешируется");
  return { code: "sitemap" };
}

/** Обложка: ссылка → скачивание → webp в хранилище → плитка в каталоге. */
async function packCover(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);

  const upload = await host.form("/act/cover", { pack: "free-soda", url: `${IMAGE_BASE}/cover.png` });
  assert(upload.status === 303, `обложка вернула ${upload.status}`);
  const lobby = await host.html(`/r/${code}`);
  const hash = lobby.html.match(/\/img\/x\/([a-f0-9]{24})-192\.webp/)?.[1];
  assert(hash, "обложка не попала в лобби");
  const coversJson = lobby.html.match(/id="pack-covers">([^<]*)</)?.[1];
  assert(coversJson, "нет JSON обложек для каталога");
  const covers = JSON.parse(coversJson);
  assert(covers["free-soda"] === hash, "каталог не узнал обложку");

  const image = await fetch(`${server.base}/img/x/${hash}-192.webp`);
  assert(image.status === 200, `картинка вернула ${image.status}`);
  assert((image.headers.get("content-type") ?? "") === "image/webp", "картинка не webp");
  assert((image.headers.get("cache-control") ?? "").includes("immutable"), "картинка без immutable");
  assert(image.headers.get("set-cookie") === null, "картинка ставит cookie");
  const bytes = new Uint8Array(await image.arrayBuffer());
  assert(bytes[0] === 0x52 && bytes[8] === 0x57, "в ответе не webp");
  assert(bytes.length < 40 * 1024, `обложка слишком тяжёлая: ${bytes.length}`);

  // редирект источника и враньё в content-type: решает магия байтов
  await host.form("/act/cover", { pack: "free-candy", url: `${IMAGE_BASE}/redirect` });
  const redirected = await host.html(`/r/${code}`);
  const coversAfterRedirect = JSON.parse(redirected.html.match(/id="pack-covers">([^<]*)</)?.[1] ?? "{}");
  assert(coversAfterRedirect["free-candy"] && coversAfterRedirect["free-candy"] !== hash, "обложка после редиректа не встала");
  const afterText = await host.form("/act/cover", { pack: "free-soda", url: `${IMAGE_BASE}/text` });
  assert(afterText.status === 303, "мусорный источник не обработан");
  const kept = await host.html(`/r/${code}`);
  assert(kept.html.includes(hash), "мусор затёр обложку");
  await host.form("/act/cover", { pack: "free-soda", url: `${IMAGE_BASE}/big` });
  const stillKept = await host.html(`/r/${code}`);
  assert(stillKept.html.includes(hash), "файл больше лимита затёр обложку");

  // обложка принадлежит игроку: новый стол её видит
  const second = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code: fresh } = roomCodeFrom(second);
  const freshLobby = await host.html(`/r/${fresh}`);
  assert(freshLobby.html.includes(hash), "обложка не переехала в новый стол");

  const clear = await host.form("/act/cover-clear", { pack: "free-soda" });
  assert(clear.status === 303, "сброс обложки не сработал");
  const cleared = await host.html(`/r/${fresh}`);
  assert(!cleared.html.includes(`/img/x/${hash}-192.webp`), "обложка не сбросилась");
  return { code };
}

/** Подбор обложки: кандидаты из поиска, превью уже у нас, подпись автора. */
async function coverSearch(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  await host.actJson("pack", { pack: "free-candy" });

  const found = await host.actJson("cover-find", { pack: "free-candy" });
  assert(found.status === 200, `поиск картинок вернул ${found.status}`);
  const data = await found.json();
  assert(Array.isArray(data.candidates) && data.candidates.length === 1, `кандидатов: ${data.candidates?.length}`);
  const [candidate] = data.candidates;
  assert(candidate.thumb.startsWith("/img/x/"), "превью кандидата не локальное");
  assert(candidate.author === "Jane Doe", `автор не очистился от разметки: ${candidate.author}`);
  assert(candidate.license === "CC BY-SA 4.0", "лицензия не разобралась");
  const preview = await fetch(`${server.base}${candidate.thumb}`);
  assert(preview.status === 200, "превью кандидата не отдалось");

  const applied = await host.form("/act/cover", {
    pack: "free-candy",
    url: candidate.url,
    author: candidate.author,
    license: candidate.license,
    page: candidate.page,
  });
  assert(applied.status === 303, `применение кандидата вернуло ${applied.status}`);
  const lobby = await host.html(`/r/${code}`);
  assert(lobby.html.includes("Фото: Jane Doe · CC BY-SA 4.0"), "подпись к обложке не попала в диалог");
  return { code };
}

/** Картинки появляются сами, как только объявлен лот: ни поиска, ни клика. */
async function autoPictures(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  await host.actJson("pack", { pack: "free-soda" });
  await host.act("toss");
  await host.act("begin");

  let page = "";
  let plate = "";
  for (let i = 0; i < 60; i += 1) {
    page = (await host.html(`/r/${code}`)).html;
    plate = page.match(/lot-plate--photo"><img src="(\/img\/x\/[a-f0-9]{24}-342\.webp)"/)?.[1] ?? "";
    if (plate) break;
    await Bun.sleep(100);
  }
  assert(plate, "картинка лота не появилась сама");
  assert(/Фото: (Википедия|Wikipedia)/.test(page), "нет подписи к авто-картинке");
  assert(page.includes('data-image="'), "кнопка не видит авто-картинку");
  const image = await fetch(`${server.base}${plate}`);
  assert(image.status === 200, `авто-постер вернул ${image.status}`);
  assert((image.headers.get("content-type") ?? "") === "image/webp", "авто-постер не webp");

  // следующий стол с тем же паком отдаёт картинку из кеша сразу
  const second = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code: fresh } = roomCodeFrom(second);
  await host.actJson("pack", { pack: "free-soda" });
  await host.act("toss");
  await host.act("begin");
  const freshPage = (await host.html(`/r/${fresh}`)).html;
  assert(/lot-plate--photo"><img src="\/img\/x\//.test(freshPage), "кеш не отдал картинку сразу");
  return { code: fresh };
}

/** Постер лота вручную: поиск по названию, плашка, подпись, снятие. */
async function lotImage(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  await host.actJson("pack", { pack: "anime-characters" });
  await host.act("toss");
  await host.act("begin");

  let page = await host.html(`/r/${code}`);
  const lot = page.html.match(/id="auction-title"[^>]*>([^<]+)</)?.[1]?.trim();
  assert(lot, "у торгов нет названия лота");

  // ждём авто-постер: он тоже приходит сам, ручной должен его перекрыть
  let autoHash = "";
  for (let i = 0; i < 150; i += 1) {
    page = await host.html(`/r/${code}`);
    autoHash = page.html.match(/lot-plate--photo"><img src="\/img\/x\/([a-f0-9]{24})-342\.webp"/)?.[1] ?? "";
    if (autoHash) break;
    await Bun.sleep(100);
  }
  assert(autoHash, "авто-постер не появился перед ручной правкой");

  const found = await host.actJson("lot-find", { q: lot });
  assert(found.status === 200, `поиск постера вернул ${found.status}`);
  const data = await found.json();
  assert(data.candidates?.length === 1, `кандидатов постера: ${data.candidates?.length}`);
  const candidate = data.candidates[0];

  const applied = await host.form("/act/lot-image", {
    item: lot,
    url: candidate.url,
    author: candidate.author,
    license: candidate.license,
    page: candidate.page,
  });
  assert(applied.status === 303, `постер лота вернул ${applied.status}`);

  page = await host.html(`/r/${code}`);
  const manual = page.html.match(/lot-plate--photo"><img src="(\/img\/x\/[a-f0-9]{24})-342\.webp"/)?.[1];
  assert(manual, "постер не встал на плашку лота");
  assert(page.html.includes("Фото: Jane Doe · CC BY-SA 4.0"), "нет подписи к постеру лота");
  assert(page.html.includes(`data-image="${manual.slice("/img/x/".length)}"`), "кнопка картинки потеряла текущий постер");

  const again = await host.html(`/r/${code}`);
  assert(again.html.includes("Фото: Jane Doe"), "подпись пропала при повторной загрузке");

  const cleared = await host.form("/act/lot-clear", { item: lot });
  assert(cleared.status === 303, "сброс постера лота не сработал");
  let back = "";
  for (let i = 0; i < 40; i += 1) {
    page = await host.html(`/r/${code}`);
    back = page.html.match(/lot-plate--photo"><img src="\/img\/x\/([a-f0-9]{24})-342\.webp"/)?.[1] ?? "";
    if (back === autoHash) break;
    await Bun.sleep(100);
  }
  assert(!page.html.includes("Фото: Jane Doe"), "ручная подпись осталась после снятия");
  assert(back === autoHash, "после снятия не вернулась авто-картинка");
  return { code };
}

/** Картинки предметов из своего пака: постер лота и миниатюра. */
async function itemPictures(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  const names = ["Moon", "Mars", "Venus", "Jupiter", "Saturn", "Neptune"];
  const payload = {
    name: "Pictures",
    emoji: "🖼",
    items: names.map((name) => ({ name, image: `${IMAGE_BASE}/cover.png` })),
  };
  const uploaded = await host.upload("/act/custom", { body: JSON.stringify(payload) });
  assert(uploaded.status === 303, `загрузка пака с картинками вернула ${uploaded.status}`);

  await host.act("toss");
  await host.act("begin");
  let plate = "";
  for (let i = 0; i < 50; i += 1) {
    const page = await host.html(`/r/${code}`);
    plate = page.html.match(/lot-plate--photo"><img src="(\/img\/x\/[a-f0-9]{24}-342\.webp)"/)?.[1] ?? "";
    if (plate) break;
    await Bun.sleep(100);
  }
  assert(plate, "постер предмета не появился на плашке лота");
  const image = await fetch(`${server.base}${plate}`);
  assert(image.status === 200, `постер вернул ${image.status}`);
  assert((image.headers.get("content-type") ?? "") === "image/webp", "постер не webp");
  const thumb = plate.replace("-342.webp", "-92.webp");
  const small = await fetch(`${server.base}${thumb}`);
  assert(small.status === 200, "миниатюра постера не отдалась");
  return { code };
}

/** Каталог едет отдельным кешируемым ответом, а комната остаётся лёгкой. */
async function catalog(server) {
  const host0 = client(server.base);
  const created0 = await host0.form("/act/create", { mode: "local", name: "ALEX" });
  const { code: lobbyCode } = roomCodeFrom(created0);
  const room0 = await host0.html(`/r/${lobbyCode}`);
  const catalogUrl = room0.html.match(/data-catalog="([^"]+)"/)?.[1];
  assert(catalogUrl?.startsWith("/public/catalog/ru-"), `каталог не под /public: ${catalogUrl}`);
  const catalog = await fetch(`${server.base}${catalogUrl}`);
  const html = await catalog.text();
  assert(catalog.status === 200, `каталог вернул ${catalog.status}`);
  assert((html.match(/class="category-card/g) ?? []).length > 200, "в каталоге меньше двухсот карточек");
  assert((catalog.headers.get("cache-control") ?? "").includes("immutable"), "каталог без immutable");
  assert(catalog.headers.get("set-cookie") === null, "каталог ставит cookie");

  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  const room = await host.html(`/r/${code}`);
  assert(room.html.includes('data-catalog="/public/catalog/'), "в лобби нет ссылки на каталог");
  assert(!/class="category-card/.test(room.html), "карточки каталога всё ещё едут внутри комнаты");
  assert(room.html.length < 40_000, `страница лобби всё ещё тяжёлая: ${room.html.length} байт`);
  return { code };
}

/** Версионированная статика кешируется на год и не трогает cookie. */
async function staticCache(server) {
  const landing = await (await fetch(`${server.base}/`)).text();
  const version = landing.match(/style\.css\?v=([a-z0-9]+)/)?.[1];
  assert(version, "в HTML нет версии статики");

  const versioned = await fetch(`${server.base}/public/style.css?v=${version}`);
  assert(versioned.status === 200, `версионированный CSS вернул ${versioned.status}`);
  assert((versioned.headers.get("cache-control") ?? "").includes("immutable"), "версионированный CSS не immutable");
  assert(versioned.headers.get("set-cookie") === null, "статика ставит cookie — край Cloudflare её не закеширует");

  const plain = await fetch(`${server.base}/public/style.css`);
  assert(!(plain.headers.get("cache-control") ?? "").includes("immutable"), "CSS без версии отдан как immutable");

  const vendor = await fetch(`${server.base}/public/vendor/datastar-1.0.5.js`);
  assert((vendor.headers.get("cache-control") ?? "").includes("immutable"), "вендор отдан без immutable");

  const second = await fetch(`${server.base}/public/style.css?v=${version}`);
  assert((second.headers.get("content-type") ?? "").includes("text/css"), "CSS потерял тип при кешировании в памяти");
  return { code: "cache" };
}

/** Флуд действиями упирается в 429. */
async function rateLimit(server) {
  const host = client(server.base);
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  let limited = false;
  for (let i = 0; i < 140; i += 1) {
    const response = await host.actJson("step", { step: 1 });
    if (response.status === 429) {
      limited = true;
      assert((response.headers.get("retry-after") ?? "") !== "", "429 без Retry-After");
      break;
    }
  }
  assert(limited, "нет ограничителя частоты на /act");
  const page = await host.html(`/r/${code}`);
  assert(page.status === 200, "после 429 комната перестала открываться");
  return { code: "limiter" };
}

async function history(server) {
  const host = client(server.base);
  await playLocalWith(host, "free-candy");
  const page = await host.html("/history");
  assert(page.status === 200, "история не открылась");
  assert(page.html.includes("МОЯ ИСТОРИЯ") || page.html.includes("Моя история"), "нет заголовка истории");
  assert((page.html.match(/history-row/g) ?? []).length >= 1, "в истории нет партий");
  return { code: "history" };
}

async function playLocalWith(host, packId) {
  const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
  const { code } = roomCodeFrom(created);
  await host.actJson("pack", { pack: packId });
  await host.act("toss");
  await host.act("begin");
  for (let i = 0; i < 120; i += 1) {
    const page = await host.html(`/r/${code}`);
    if (page.html.includes('data-phase="results"')) break;
    const bidDisabled = /id="bid-button"[^>]*disabled/.test(page.html);
    await (bidDisabled ? host.act("pass") : host.act("bid"));
  }
  return code;
}

const server = await startServer({
  env: {
    LOT_OPS_TOKEN: OPS_TOKEN,
    LOT_IMAGE_ALLOW_LOCAL: "1",
    LOT_IMAGES: "/tmp/lot-e2e-images",
    LOT_COMMONS_API: `${IMAGE_BASE}/commons`,
    LOT_WIKI_API: `${IMAGE_BASE}/{lang}/w/api.php`,
    LOT_AUTO_IMAGES: "1",
    LOT_ANILIST_API: `${IMAGE_BASE}/anilist`,
  },
});
let failures = 0;
const checks = [
  ["pack cover", () => packCover(server)],
  ["cover search", () => coverSearch(server)],
  ["item pictures", () => itemPictures(server)],
  ["auto pictures", () => autoPictures(server)],
  ["lot image", () => lotImage(server)],
  ["local game", () => playLocal(server)],
  ["online game", () => playOnline(server)],
  ["human judge", () => humanJudge(server)],
  ["language switch", () => languageSwitch(server)],
  ["lot plate", () => posterPlate(server)],
  ["bid ladder", () => bidLadder(server)],
  ["custom pack", () => customPack(server)],
  ["saved packs", () => savedPacks(server)],
  ["ops health", () => opsHealth(server)],
  ["sitemap & sw", () => discoverability(server)],
  ["catalog", () => catalog(server)],
  ["static cache", () => staticCache(server)],
  ["rate limit", () => rateLimit(server)],
  ["player history", () => history(server)],
];

for (const [name, run] of checks) {
  const started = Date.now();
  try {
    const info = await run();
    console.log(`  ✓ ${name} (${Date.now() - started} мс)`, info);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

await server.stop();
imageSource.stop(true);
if (failures) {
  console.error(`http-e2e: провалено ${failures}`);
  process.exit(1);
}
console.log("http-e2e: всё зелёное");
