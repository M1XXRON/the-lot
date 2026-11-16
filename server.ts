// The Lot — один процесс: лендинг, комната, SSE-патчи Datastar, действия, статика.
import { resolve, normalize } from "node:path";
import * as engine from "./src/engine.js";
import * as content from "./src/content.js";
import * as store from "./src/store.ts";
import { judge, aiStatus, tmdbPoster, type DraftPayload } from "./src/ai.ts";
import { historyPage, landingPage, roomPage, renderRoom, patchFragments, setAssetVersion, toast } from "./src/render.ts";
import { isLang, makeT, type Lang } from "./src/i18n.ts";

const PORT = Number(process.env.PORT ?? 4173);

// Версия статики из mtime+size: после деплоя ссылки на CSS/JS меняются,
// поэтому старый кеш браузера не может смешаться с новой разметкой.
const ASSET_FILES = ["public/style.css", "public/redesign.css", "public/stages.css", "public/experience.js", "public/sound.js"];
{
  let seed = 0;
  for (const file of ASSET_FILES) {
    try {
      const stat = Bun.file(file);
      seed = (seed * 31 + (stat.size ?? 0) + Math.floor((stat.lastModified ?? 0) / 1000)) >>> 0;
    } catch {
      seed = (seed * 31 + 7) >>> 0;
    }
  }
  setAssetVersion(seed.toString(36));
}
const HOST = process.env.HOST?.trim() || "0.0.0.0";
const encoder = new TextEncoder();
const PID_MAX_AGE = 60 * 60 * 24 * 365;

type Session = { room: string | null; seat: number | null };
type Room = ReturnType<typeof engine.createRoom>;

const sessions = new Map<string, Session>();
/** @type {Map<string, any>} */
const rooms = new Map<string, any>();

for (const room of store.loadRooms()) {
  if (!room?.code) continue;
  rooms.set(room.code, room);
  store.registerRoom(room);
}
for (const row of store.loadSessions()) {
  const room = row.room ? rooms.get(row.room) : null;
  const seat = room && typeof row.seat === "number" ? engine.seatOf(room, row.id) : -1;
  sessions.set(row.id, { room: room ? room.code : null, seat: seat >= 0 ? seat : null });
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function originOf(request: Request) {
  const url = new URL(request.url);
  const proto = String(request.headers.get("x-forwarded-proto") ?? "").split(",")[0]!.trim() || url.protocol.replace(":", "");
  const host = String(request.headers.get("host") ?? url.host);
  return { origin: `${proto}://${host}`, proto, host };
}

function pidOf(request: Request): string {
  try {
    return new Bun.CookieMap(request.headers.get("cookie") ?? "").get("lot_pid") ?? "";
  } catch {
    return "";
  }
}

function langOf(request: Request): Lang {
  try {
    const value = new Bun.CookieMap(request.headers.get("cookie") ?? "").get("lot_lang");
    return isLang(value) ? value : "ru";
  } catch {
    return "ru";
  }
}

function sidOf(request: Request) {
  try {
    return new Bun.CookieMap(request.headers.get("cookie") ?? "").get("lot_sid") ?? "";
  } catch {
    return "";
  }
}

function sessionFor(sid: string): Session {
  let session = sessions.get(sid);
  if (!session) {
    session = { room: null, seat: null };
    sessions.set(sid, session);
    store.rememberSession(sid, null, null);
  }
  return session;
}

function cookieFor(sid: string, secure: boolean) {
  return `lot_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
}

function html(body: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/* ───────────────────────── SSE ───────────────────────── */

type Conn = { sid: string; origin: string; lang: Lang; controller: ReadableStreamDefaultController<Uint8Array>; alive: boolean };
/** @type {Map<string, Set<Conn>>} */
const conns = new Map();

function frame(selector: string, markup: string) {
  return `event: datastar-patch-elements\ndata: mode outer\ndata: selector ${selector}\ndata: elements ${markup.replace(/\r?\n/g, "")}\n\n`;
}

function send(conn: Conn, chunk: string) {
  if (!conn.alive) return;
  try {
    conn.controller.enqueue(encoder.encode(chunk));
  } catch {
    conn.alive = false;
  }
}

function viewer(room: any, conn: Conn): any {
  const view: any = engine.view(room, conn.sid, conn.origin);
  view.lang = conn.lang;
  return view;
}

function broadcast(room: any, scope: "full" | "lobby" | "toast" = "full", message = "") {
  const set = conns.get(room.code);
  if (!set || set.size === 0) return;
  for (const conn of [...set]) {
    const view = viewer(room, conn);
    if (scope === "full") {
      send(conn, frame("#room", renderRoom(view)));
    } else if (scope === "lobby") {
      const parts = patchFragments(view);
      send(conn, frame("#room-bar", parts.bar));
      if (parts.side) send(conn, frame("#lobby-side", parts.side));
    }
    if (message) send(conn, frame("#toast", toast(message)));
  }
}

function toastTo(sid: string, text: string) {
  for (const set of conns.values()) {
    for (const conn of set) {
      if (conn.sid === sid) send(conn, frame("#toast", toast(text)));
    }
  }
}

function say(room: any, sid: string, ru: string, en: string) {
  const text = room.lang === "en" ? en : ru;
  toastTo(sid, text);
}

function closeRoom(code: string) {
  const set = conns.get(code);
  if (set) {
    for (const conn of set) {
      conn.alive = false;
      try {
        conn.controller.close();
      } catch {
        /* уже закрыт */
      }
    }
    conns.delete(code);
  }
}

/* ─────────────────────── действия ─────────────────────── */

function roomOf(session: Session) {
  const room = session.room ? rooms.get(session.room) : null;
  return room ?? null;
}

function seatOfSession(room: any, sid: string) {
  const seat = engine.seatOf(room, sid);
  return seat >= 0 ? seat : null;
}

function requireHost(room: any, sid: string) {
  return engine.isHost(room, sid);
}

function persist(room: any) {
  engine.bump(room);
  store.saveRoom(room);
}

/** Черновик, который уходит модели. */
function payloadFor(room: any): DraftPayload {
  const pack = content.packById.get(room.packId) ?? content.packs[0]!;
  return {
    pack: { id: pack.id, name: pack.name },
    players: room.players.map((player: any) => ({
      name: player.name,
      budgetLeft: player.budget,
      picks: player.picks.map((pick: any) => ({ name: pick.name, price: pick.price, free: pick.auto === true })),
    })),
    auctions: room.history.map((round: any) => ({
      item: round.lot.name,
      outcome: round.skipped ? "skipped" : round.auto ? "automatic" : "awarded",
      winner: round.winner === null ? null : room.players[round.winner].name,
      price: round.price,
      bids: round.bids.map((bid: any) => ({ player: room.players[bid.seat].name, amount: bid.amount })),
      passes: round.passes.map((seat: number) => room.players[seat].name),
    })),
  };
}

async function runJudge(room: any) {
  if (room.phase !== "judging" || room.judging) return;
  const token = ++room.judgeToken;
  room.lastJudgeAt = Date.now();
  room.judging = true;
  store.saveRoom(room);
  broadcast(room, "full");

  const pack = content.packById.get(room.packId) ?? content.packs[0]!;
  try {
    const review = await judge(payloadFor(room), pack.profile, content.mediaTypeFor(pack.id), room.lang === "en" ? "en" : "ru");
    if (token !== room.judgeToken) return;
    engine.applyReview(room, review);
    store.saveRoom(room);
    store.recordGame(room, review);
    room.recorded = true;
    broadcast(room, "full");
  } catch (error) {
    if (token !== room.judgeToken) return;
    const message = error instanceof Error ? error.message : "Судья не смог оценить драфт.";
    engine.failReview(room, message);
    store.saveRoom(room);
    broadcast(room, "full");
  }
}

async function readBody(request: Request): Promise<any> {
  const type = String(request.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("application/json")) {
    const body = await request.json().catch(() => null);
    return body && typeof body === "object" ? body : {};
  }
  if (type.includes("form")) {
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  }
  return {};
}

function fail(request: Request, message: string, status = 400) {
  const wantsJson = String(request.headers.get("accept") ?? "").includes("application/json");
  return wantsJson ? json({ error: message }, status) : html(`<p>${message}</p>`, status);
}

/** @returns {Promise<Response>} */
async function handleAction(request: Request, cmd: string, sid: string, pid: string, origin: string, secure: boolean) {
  if (request.method !== "POST") return new Response("POST required", { status: 405, headers: SECURITY_HEADERS });
  const session = sessionFor(sid);

  const room = roomOf(session);

  if (cmd === "custom") {
    if (!room) return fail(request, "Комната не найдена.", 410);
    if (!engine.isHost(room, sid)) return fail(request, "Пак загружает хозяин стола.", 403);
    if (room.phase !== "lobby") return fail(request, "Драфт уже начался.", 409);
    const form = await request.formData().catch(() => null);
    const file = form?.get("pack");
    const back = `/r/${room.code}`;
    const redirect = (message?: string) => {
      if (message) say(room, sid, message, message);
      return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: back } });
    };
    if (!(file instanceof Blob)) return redirect("Прикрепите JSON-файл с паком.");
    if (file.size > 64 * 1024) return redirect("Файл больше 64 КБ.");
    let parsed: any;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return redirect("Это не валидный JSON.");
    }
    const items = (Array.isArray(parsed) ? parsed : parsed?.items) ?? null;
    if (!Array.isArray(items)) return redirect("Нужен массив items или массив строк.");
    const cleaned = [...new Set(
      items
        .filter((item: unknown): item is string => typeof item === "string")
        .map((item: string) => item.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80))
        .filter((item: string) => item.length > 0),
    )];
    if (cleaned.length < 5 || cleaned.length > 60) return redirect("Нужно от 5 до 60 уникальных предметов.");
    const name = typeof parsed?.name === "string" && parsed.name.trim()
      ? parsed.name.trim().replace(/[\u0000-\u001f]/g, "").slice(0, 40)
      : room.lang === "en" ? "Custom pack" : "Свой пак";
    const emoji = typeof parsed?.emoji === "string" && parsed.emoji.trim() ? [...parsed.emoji.trim()][0] : "🎲";
    engine.setCustomPack(room, {
      id: `custom-${room.code.toLowerCase()}`,
      name,
      emoji,
      tab: "CUSTOM",
      count: cleaned.length,
      items: cleaned,
      profile: "party",
    });
    persist(room);
    broadcast(room, "full");
    return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: back } });
  }

  if (cmd === "custom-clear") {
    if (!room) return fail(request, "Комната не найдена.", 410);
    if (!engine.isHost(room, sid)) return fail(request, "Пак меняет хозяин стола.", 403);
    if (room.phase !== "lobby") return fail(request, "Драфт уже начался.", 409);
    engine.clearCustomPack(room);
    persist(room);
    broadcast(room, "full");
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  const body = await readBody(request);

  if (cmd === "lang") {
    const lang: Lang = body.lang === "en" ? "en" : "ru";
    const raw = typeof body.next === "string" ? body.next : "/";
    const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
    const session = sessionFor(sid);
    const room = session.room ? rooms.get(session.room) : null;
    if (room && engine.isHost(room, sid)) {
      room.lang = lang;
      store.saveRoom(room);
    }
    return new Response(null, {
      status: 303,
      headers: {
        ...SECURITY_HEADERS,
        Location: next,
        "Set-Cookie": `lot_lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`,
      },
    });
  }

  // создание и вход приходят обычными формами с лендинга
  if (cmd === "create") {
    const mode = body.mode === "local" ? "local" : "online";
    const fallbackName = langOf(request) === "en" ? "PLAYER 1" : "ИГРОК 1";
    const name = String(body.name ?? fallbackName).slice(0, 16);
    let code = engine.roomCode();
    let guard = 0;
    while (rooms.has(code) && guard++ < 50) code = engine.roomCode();
    const room: any = engine.createRoom({ code, mode, sessionId: sid, name });
    room.lang = langOf(request);
    room.pids = [pid, mode === "local" ? pid : null];
    if (mode === "local") {
      engine.fillLocalSeat(room);
      const second = langOf(request) === "en" ? "PLAYER 2" : "ИГРОК 2";
      room.players[1].name = second;
      room.seats[1].name = second;
    }
    rooms.set(code, room);
    store.registerRoom(room);
    store.saveRoom(room);
    session.room = code;
    session.seat = 0;
    store.rememberSession(sid, code, 0);
    return new Response(null, {
      status: 303,
      headers: { ...SECURITY_HEADERS, Location: `/r/${code}`, "Set-Cookie": cookieFor(sid, secure) },
    });
  }

  if (cmd === "join") {
    const code = String(body.code ?? "").trim().toUpperCase().slice(0, 8);
    const fallbackGuest = langOf(request) === "en" ? "PLAYER 2" : "ИГРОК 2";
    const name = String(body.name ?? fallbackGuest).slice(0, 16);
    const room = rooms.get(code);
    if (!room) return html(`<p>Стол ${code} не найден. <a href="/">На главную</a></p>`, 404);
    const seat = engine.join(room, sid, name);
    if (typeof seat === "number") {
      room.pids = Array.isArray(room.pids) ? room.pids : [null, null];
      room.pids[seat] = pid;
      session.room = code;
      session.seat = seat;
      store.rememberSession(sid, code, seat);
      store.saveRoom(room);
      broadcast(room, "full");
    } else if (seat === "full" || seat === "closed") {
      session.room = code;
      session.seat = null;
    }
    return new Response(null, {
      status: 303,
      headers: { ...SECURITY_HEADERS, Location: `/r/${code}`, "Set-Cookie": cookieFor(sid, secure) },
    });
  }

  if (!room) return fail(request, "Комната не найдена — вернитесь на главную.", 410);
  const seat = seatOfSession(room, sid);
  const host = requireHost(room, sid);

  const lobbyOnly = room.phase !== "lobby";
  const touch = (scope: "full" | "lobby" = "full", message = "") => {
    persist(room);
    broadcast(room, scope, message);
  };

  switch (cmd) {
    case "pack": {
      if (!host) return fail(request, "Пак выбирает хозяин стола.", 403);
      if (lobbyOnly) return fail(request, "Драфт уже начался.", 409);
      engine.setPack(room, String(body.pack ?? ""));
      touch("lobby");
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "judge": {
      if (!host) return fail(request, "Судью меняет хозяин стола.", 403);
      if (room.phase !== "lobby" && room.phase !== "results") return fail(request, "Сейчас судью не поменять.", 409);
      engine.setJudge(room, body.mode === "human" ? "human" : "auto");
      room.judgeToken = (room.judgeToken ?? 0) + 1;
      room.judging = false;
      if (room.phase === "results") {
        room.reviewError = null;
        room.winner = undefined;
        room.manualVote = null;
        room.phase = room.judgeMode === "human" ? "results" : "judging";
        persist(room);
        broadcast(room, "full");
        if (room.phase === "judging") void runJudge(room);
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      }
      touch("lobby");
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "rename": {
      if (seat === null) return fail(request, "Сначала займите место.", 403);
      engine.rename(room, seat as 0 | 1, String(body.name ?? ""));
      touch("lobby");
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "toss": {
      if (!host) return fail(request, "Монету бросает хозяин стола.", 403);
      const result = engine.tossCoin(room);
      if (result !== "ok") return fail(request, "Нужны оба игрока за столом.", 409);
      touch("full");
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "begin": {
      if (!host) return fail(request, "Драфт начинает хозяин стола.", 403);
      const result = engine.beginDraft(room);
      if (result !== "ok") return fail(request, "Сначала бросьте монету.", 409);
      touch("full");
      void ensureLotPoster(room);
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "step": {
      if (seat === null) return fail(request, "Вы наблюдаете за столом.", 403);
      if (room.phase !== "auction") return fail(request, "Торги не идут.", 409);
      const result = engine.setStep(room, Number(body.step));
      if (result !== "ok") return fail(request, "Сейчас шаг не изменить.", 409);
      persist(room);
      broadcast(room, "full");
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "open":
    case "bid":
    case "pass": {
      if (seat === null) return fail(request, "Вы наблюдаете за столом.", 403);
      if (room.phase !== "auction") return fail(request, "Торги не идут.", 409);
      const turn = room.auction.turn as 0 | 1;
      const isLocal = room.mode === "local";
      if (!engine.controlsSeat(room, sid, turn) || (!isLocal && seat !== turn)) {
        return fail(request, "Сейчас не ваш ход.", 409);
      }
      // В локальном режиме хост ведёт оба места: действуем от имени того, чей ход.
      const actingSeat: 0 | 1 = isLocal ? turn : (seat as 0 | 1);
      let result: string = "ok";
      if (cmd === "open") result = engine.adjustOpening(room, actingSeat, Number(body.delta) < 0 ? -1 : 1);
      else if (cmd === "bid") result = engine.bid(room, actingSeat);
      else result = engine.pass(room, actingSeat);
      if (result === "no-money") return fail(request, "Не хватает монет на такую ставку.", 409);
      if (result === "wrong-turn") return fail(request, "Сейчас не ваш ход.", 409);
      if (result === "full") return fail(request, "У вас уже пять пиков.", 409);

      persist(room);
      broadcast(room, "full");
      if (room.phase === "auction") void ensureLotPoster(room);
      if (room.phase === "judging") {
        room.judgeMode = "auto";
        store.saveRoom(room);
        void runJudge(room);
      }
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "vote": {
      if (seat === null) return fail(request, "Голосуют только игроки за столом.", 403);
      if (room.phase !== "results" || room.judgeMode !== "human") return fail(request, "Голосование недоступно.", 409);
      const raw = body.vote;
      engine.vote(room, raw === "draw" ? "draw" : Number(raw) === 1 ? 1 : 0);
      persist(room);
      if (!room.recorded) {
        store.recordGame(room, null);
        room.recorded = true;
      }
      broadcast(room, "full");
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "again": {
      if (!host) return fail(request, "Новую партию начинает хозяин стола.", 403);
      engine.again(room);
      room.recorded = false;
      touch("full");
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    case "retry": {
      if (!host) return fail(request, "Повтор запускает хозяин стола.", 403);
      if (room.phase !== "results") return fail(request, "Сейчас нечего повторять.", 409);
      room.retries = (room.retries ?? 0) + 1;
      if (room.retries > 3) {
        say(room, sid, "Лимит повторов исчерпан — смените судью.", "Retry limit reached — switch the judge.");
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      }
      if (room.lastJudgeAt && Date.now() - room.lastJudgeAt < 8_000) {
        say(room, sid, "Подождите пару секунд перед повтором.", "Give it a couple of seconds before retrying.");
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      }
      room.review = null;
      room.reviewError = null;
      room.winner = undefined;
      room.manualVote = null;
      room.phase = "judging";
      room.judging = false;
      room.judgeMode = "auto";
      persist(room);
      broadcast(room, "full");
      void runJudge(room);
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    default:
      return fail(request, "Неизвестное действие.", 404);
  }
}

/* ─────────────────────── страницы ─────────────────────── */

function roomOr404(code: string) {
  const room = rooms.get(code.toUpperCase());
  return room ?? null;
}

/* ─────────────────────── статика ─────────────────────── */

const IMAGE_CACHE = new Map<string, { body: Uint8Array; type: string }>();
const IMAGE_LIMIT = 240;

async function tmdbImage(file: string) {
  const cached = IMAGE_CACHE.get(file);
  if (cached) return cached;
  const upstream = await fetch(`https://image.tmdb.org/t/p/w342/${file}`, { signal: AbortSignal.timeout(12_000) });
  if (!upstream.ok) return null;
  const type = upstream.headers.get("content-type") ?? "image/jpeg";
  if (!type.startsWith("image/")) return null;
  const body = new Uint8Array(await upstream.arrayBuffer());
  if (body.byteLength > 2_000_000) return null;
  if (IMAGE_CACHE.size > IMAGE_LIMIT) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value as string);
  const entry = { body, type };
  IMAGE_CACHE.set(file, entry);
  return entry;
}

/** Подтягиваем постер текущего лота для кино-паков (кэш в памяти процесса). */
async function ensureLotPoster(room: any) {
  const pack = content.packById.get(room.packId);
  if (!pack || pack.profile !== "internet-ratings") return;
  const lot = room.lots[room.lotIndex];
  if (!lot || lot.poster !== undefined) return;
  if (aiStatus().mock) {
    lot.poster = null;
    return;
  }
  const media = (content.mediaTypeFor(pack.id) ?? "movie") as "movie" | "tv";
  try {
    lot.poster = await tmdbPoster(lot.name, media);
    store.saveRoom(room);
    broadcast(room, "full");
    // подтягиваем постеры следующих лотов, чтобы не мигала плашка
    for (let step = 1; step <= 2; step += 1) {
      const next = room.lots[room.lotIndex + step];
      if (next && next.poster === undefined) {
        next.poster = await tmdbPoster(next.name, media).catch(() => null);
      }
    }
    store.saveRoom(room);
  } catch {
    lot.poster = null;
  }
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

async function serveStatic(pathname: string) {
  const relative = normalize(pathname.replace(/^\/public\/?/, "")).replace(/^(\.\.[/\\])+/, "");
  if (!relative || relative.startsWith("..")) return new Response("Not found", { status: 404 });
  const file = Bun.file(resolve("public", relative));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const ext = relative.slice(relative.lastIndexOf("."));
  return new Response(file, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".js" || ext === ".css" ? "no-cache" : "public, max-age=3600",
    },
  });
}

/* ─────────────────────── сервер ─────────────────────── */

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const { origin, proto } = originOf(request);
    const secure = proto === "https";
    const sidCookie = sidOf(request);
    const sid = sidCookie || crypto.randomUUID();
    const pidCookie = pidOf(request);
    const pid = pidCookie || crypto.randomUUID();
    const withSid = (response: Response) => {
      if (!sidCookie) response.headers.append("Set-Cookie", cookieFor(sid, secure));
      if (!pidCookie) {
        response.headers.append("Set-Cookie", `lot_pid=${pid}; Path=/; Max-Age=${PID_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
      }
      return response;
    };

    if (path === "/health") {
      return json({
        ok: true,
        uptime: Math.round(process.uptime()),
        rooms: rooms.size,
        sessions: sessions.size,
        db: store.dbStats(),
        ai: aiStatus(),
      });
    }

    if (path === "/api/games") {
      return json({ games: store.lastGames(10) });
    }

    if (path === "/manifest.webmanifest") {
      const manifest = {
        name: "The Lot",
        short_name: "The Lot",
        description: "A two-player draft house: five picks, twenty coins, one winner.",
        start_url: "/",
        display: "standalone",
        background_color: "#f4efe4",
        theme_color: "#f4efe4",
        icons: [{ src: "/public/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      };
      return new Response(JSON.stringify(manifest), {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "application/manifest+json; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    if (path === "/history") {
      const pidValue = pidOf(request);
      const emptyStats = { played: 0, wins: 0, ties: 0, losses: 0, best: null, favouritePack: null, games: [] };
      let stats: any = emptyStats;
      try {
        stats = pidValue ? store.historyFor(pidValue) : emptyStats;
      } catch (error) {
        console.error("[history] не удалось прочитать историю:", error instanceof Error ? error.message : error);
      }
      const packNames: Record<string, string> = {};
      for (const pack of content.packs) packNames[pack.id] = `${pack.emoji} ${pack.name}`;
      return withSid(html(historyPage({ lang: langOf(request), stats, packNames })));
    }

    if (path === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /$\nDisallow: /r/\nDisallow: /act/\nDisallow: /img/\n", {
        headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    if (path.startsWith("/img/tmdb/")) {
      const file = path.slice("/img/tmdb/".length);
      if (!/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(file)) return new Response("Not found", { status: 404 });
      const image = await tmdbImage(file).catch(() => null);
      if (!image) return new Response("Not found", { status: 404 });
      return new Response(image.body.slice().buffer, {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": image.type,
          "Cache-Control": "public, max-age=2592000, immutable",
        },
      });
    }

    if (path.startsWith("/public/")) {
      return withSid(await serveStatic(path));
    }

    if (path.startsWith("/act/")) {
      return withSid(await handleAction(request, path.slice(5), sid, pid, origin, secure));
    }

    if (path === "/") {
      const stats = store.dbStats();
      const live = [...rooms.values()].filter((room) => room.phase !== "results").length;
      const recent = store.lastGames(4).map((game) => ({
        pack: content.packById.get(game.pack)?.name ?? game.pack,
        emoji: content.packById.get(game.pack)?.emoji ?? "◆",
        winner: game.winner,
        winnerScore: game.winnerScore,
        rivalScore: game.rivalScore,
        lang: langOf(request),
      }));
      return withSid(html(landingPage({ live, games: stats.games, lang: langOf(request), recent })));
    }

    if (path === "/stream") {
      const session = sessionFor(sid);
      const room = roomOf(session);
      if (!room) return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      const seat = seatOfSession(room, sid);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const conn: Conn = { sid, origin, lang: langOf(request), controller, alive: true };
          let set = conns.get(room.code);
          if (!set) {
            set = new Set();
            conns.set(room.code, set);
          }
          set.add(conn);

          if (seat !== null && room.seats[seat] && room.seats[seat].connected === false) {
            room.seats[seat].connected = true;
            store.saveRoom(room);
            broadcast(room, "lobby");
          }

          // Если страница уже отрисована на этой версии комнаты, не дублируем
          // каталог на 250 КБ: клиент догонит патчем при первом же изменении.
          const clientVersion = Number(new URL(request.url ?? "/", "http://x").searchParams.get("v"));
          if (!Number.isFinite(clientVersion) || clientVersion !== room.version) {
            const initial: any = engine.view(room, sid, origin);
            initial.lang = conn.lang;
            send(conn, frame("#room", renderRoom(initial)));
          }
          void ensureLotPoster(room);
          const keepAlive = setInterval(() => send(conn, ": ping\n\n"), 20_000);
          const cleanup = () => {
            clearInterval(keepAlive);
            conn.alive = false;
            set?.delete(conn);
            if (seat !== null && room.seats[seat]) {
              room.seats[seat].connected = false;
              store.saveRoom(room);
              broadcast(room, "lobby");
            }
          };
          request.signal.addEventListener("abort", cleanup);
        },
        cancel() {
          /* cleanup уже вызван через abort */
        },
      });

      return withSid(
        new Response(stream, {
          headers: {
            ...SECURITY_HEADERS,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        }),
      );
    }

    const roomMatch = path.match(/^\/r\/([A-Za-z0-9]{2,8})$/);
    if (roomMatch) {
      const room = roomOr404(roomMatch[1]!);
      if (!room) return withSid(html(`<p>Стол не найден. <a href="/">На главную</a></p>`, 404));
      const session = sessionFor(sid);
      session.room = room.code;
      const seat = seatOfSession(room, sid);
      session.seat = seat;
      store.rememberSession(sid, room.code, seat);
      const pageView: any = engine.view(room, sid, origin);
      pageView.lang = langOf(request);
      return withSid(html(roomPage(pageView)));
    }

    if (path === "/favicon.ico") return new Response(null, { status: 204, headers: SECURITY_HEADERS });

    return withSid(html(`<p>Страница не найдена. <a href="/">На главную</a></p>`, 404));
  },
});

/* ─────────────────────── уборка ─────────────────────── */

const MAX_AGE = 12 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const stale = now - room.updatedAt > MAX_AGE;
    const empty = room.seats.every((seat: any) => seat.connected === false) && now - room.updatedAt > 45 * 60 * 1000;
    const finished = room.phase === "results" && now - room.updatedAt > 2 * 60 * 60 * 1000;
    if (!stale && !empty && !finished) continue;
    closeRoom(code);
    rooms.delete(code);
    store.unregisterRoom(code);
  }
  for (const [sid, session] of sessions) {
    if (session.room && !rooms.has(session.room)) sessions.delete(sid);
  }
}, 10 * 60 * 1000);

console.log(
  `The Lot · http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} · паков ${content.packs.length} · ` +
    `модель ${aiStatus().model}${aiStatus().mock ? " (mock)" : ""}${aiStatus().hasKey ? "" : " · ключ не задан"}` +
    `${aiStatus().hasTmdb ? "" : " · TMDb не настроен"}`,
);
