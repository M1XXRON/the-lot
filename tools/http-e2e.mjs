// HTTP-e2e: полная партия без браузера. Формы, экшены, проверка HTML на каждом шаге.
import { assert, client, roomCodeFrom, startServer } from "./lib.mjs";

const marker = (html, text) => html.includes(text);
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

const server = await startServer({ env: { LOT_OPS_TOKEN: OPS_TOKEN } });
let failures = 0;
const checks = [
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
if (failures) {
  console.error(`http-e2e: провалено ${failures}`);
  process.exit(1);
}
console.log("http-e2e: всё зелёное");
