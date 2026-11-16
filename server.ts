// The Lot — один процесс: лендинг, комната, SSE-патчи Datastar, действия, статика.
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { resolve, normalize, join } from "node:path";
import { lookup } from "node:dns/promises";
import * as engine from "./src/engine.js";
import * as content from "./src/content.js";
import * as store from "./src/store.ts";
import { checkImage, imageCheckAvailable, judge, aiStatus, tmdbPoster, type DraftPayload } from "./src/ai.ts";
import { catalogFragment, historyPage, landingPage, roomPage, renderRoom, patchFragments, setAssetVersion, toast } from "./src/render.ts";
import { isLang, makeT, type Lang } from "./src/i18n.ts";

const PORT = Number(process.env.PORT ?? 4173);

// Версия статики из mtime+size: после деплоя ссылки на CSS/JS меняются,
// поэтому старый кеш браузера не может смешаться с новой разметкой.
const ASSET_FILES = [
  "public/style.css",
  "public/redesign.css",
  "public/stages.css",
  "public/experience.js",
  "public/sound.js",
  "public/sw.js",
  "public/favicon.svg",
  "public/vendor/datastar-1.0.5.js",
];
let ASSET_VERSION = "1";
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
  ASSET_VERSION = seed.toString(36);
  setAssetVersion(ASSET_VERSION);
}
const HOST = process.env.HOST?.trim() || "0.0.0.0";
/** Токен для детального /health: без него наружу видно только ok и uptime. */
const OPS_TOKEN = (process.env.LOT_OPS_TOKEN ?? "").trim();
const encoder = new TextEncoder();
const PID_MAX_AGE = 60 * 60 * 24 * 365;
/** Потолок живых столов: остальное все равно уберёт уборка. */
const ROOM_LIMIT = 400;

type Session = { room: string | null; seat: number | null; notice?: string };
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
    "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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

function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/* ─────────────────── ограничители частоты ─────────────────── */

/** Ведро токенов: burst — запас, rate — восстановление в секунду. */
type Bucket = { tokens: number; updated: number };
const buckets = new Map<string, Bucket>();

function allow(key: string, rate: number, burst: number) {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: burst, updated: now };
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.updated) / 1000) * rate);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

function tooMany(retryAfter = 3) {
  return json({ error: "Слишком много запросов." }, 429, { "Retry-After": String(retryAfter) });
}

function ipOf(request: Request) {
  const forwarded = String(request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return server.requestIP(request)?.address ?? "local";
  } catch {
    return "local";
  }
}

function tokenMatches(given: string) {
  if (!OPS_TOKEN || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(OPS_TOKEN);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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
      // Каталог на 250 КБ не гоняем по SSE: в лобби меняются только шапка,
      // пульт, карточка приглашения и свои паки.
      const parts = patchFragments(view);
      send(conn, frame("#room-bar", parts.bar));
      if (parts.side) send(conn, frame("#lobby-side", parts.side));
      if (parts.invite) send(conn, frame("#invite-card", parts.invite));
      if (parts.custom) send(conn, frame("#custom-packs", parts.custom));
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

/* ── картинки: обложки паков ── */

const IMAGE_DIR = resolve(process.env.LOT_IMAGES ?? "data/images");
mkdirSync(IMAGE_DIR, { recursive: true });
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
/** Только для e2e: разрешает http и локальные адреса тестового сервера. */
const IMAGE_ALLOW_LOCAL = process.env.LOT_IMAGE_ALLOW_LOCAL === "1";

class CoverError extends Error {
  constructor(readonly ru: string, readonly en: string) {
    super(ru);
  }
}

/** Приватные, петлевые и служебные диапазоны: через них нельзя ходить за картинкой. */
function privateAddress(address: string): boolean {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateAddress(mapped[1]!) : false;
  }
  return (
    /^(0|10|127|169\.254|192\.168)\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ||
    /^(22[4-9]|23\d|24\d|25[0-5])\./.test(address)
  );
}

/**
 * Ссылка должна вести в публичный https. DNS проверяем до запроса;
 * окно между проверкой и соединением (rebinding) осознанно оставлено —
 * для картинок цена атаки выше, чем риск.
 */
async function checkImageHost(url: URL) {
  if (url.protocol !== "https:" && !(IMAGE_ALLOW_LOCAL && url.protocol === "http:")) {
    throw new CoverError("Ссылка должна начинаться с https://.", "The link must start with https://.");
  }
  if (IMAGE_ALLOW_LOCAL) return;
  if (url.username || url.password) throw new CoverError("Ссылки с логином и паролем не подойдут.", "Links with credentials are not accepted.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = /^[\d.]+$/.test(host) || host.includes(":");
  const addresses = literal
    ? [host]
    : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((row) => row.address);
  if (addresses.length === 0) throw new CoverError("Не удалось найти этот адрес.", "That address could not be resolved.");
  if (addresses.some((address) => privateAddress(address))) {
    throw new CoverError("Локальные адреса закрыты.", "Local addresses are off limits.");
  }
}

/** Тип — по магии байтов, а не по заголовку источника. */
function sniffImageType(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  const ftyp = String.fromCharCode(...bytes.subarray(4, 12));
  if (ftyp.startsWith("ftyp") && /(avi[fs]|heic|heif)/.test(ftyp.slice(4))) return "image/avif";
  return null;
}

/**
 * Два профиля: обложка пака (квадратная плитка) и постер предмета (плашка 2:3).
 * Файлы разных профилей не конфликтуют: у них разные суффиксы.
 */
const IMAGE_PROFILES = {
  cover: { small: 96, large: 192 },
  item: { small: 92, large: 342 },
} as const;

type ImageProfile = keyof typeof IMAGE_PROFILES;

type ImageCredit = { author?: string; license?: string; page?: string };

/** Скачивает картинку по ссылке и раскладывает её в два webp-размера. */
async function ingestImage(raw: string, profile: ImageProfile, credit: ImageCredit = {}) {
  let current: URL;
  try {
    current = new URL(raw);
  } catch {
    throw new CoverError("Это не похоже на ссылку.", "That does not look like a link.");
  }

  for (let hop = 0; hop <= 3; hop += 1) {
    await checkImageHost(current);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        headers: { accept: "image/*", "user-agent": "TheLot/1.0 (+https://lot.bunker9.lol)" },
        signal: AbortSignal.timeout(9000),
      });
    } catch {
      throw new CoverError("Источник не ответил.", "The source did not respond.");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new CoverError("Источник перенаправил в пустоту.", "The source redirected nowhere.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new CoverError(`Источник ответил ${response.status}.`, `The source replied ${response.status}.`);
    if (Number(response.headers.get("content-length") ?? 0) > IMAGE_MAX_BYTES) {
      throw new CoverError("Картинка больше 6 МБ.", "The image is larger than 6 MB.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CoverError("Источник отдал пустой ответ.", "The source returned an empty response.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > IMAGE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new CoverError("Картинка больше 6 МБ.", "The image is larger than 6 MB.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (!sniffImageType(bytes)) {
      throw new CoverError("Это не картинка: нужен JPEG, PNG, WebP, GIF или AVIF.", "That is not an image: JPEG, PNG, WebP, GIF or AVIF only.");
    }
    let meta: { width?: number; height?: number; format?: string } | null = null;
    try {
      meta = await new Bun.Image(bytes).metadata();
    } catch {
      throw new CoverError("Картинка не читается.", "The image cannot be decoded.");
    }
    if (!meta?.width || !meta?.height) throw new CoverError("Картинка не читается.", "The image cannot be decoded.");

    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 24);
    const sizes = IMAGE_PROFILES[profile];
    const small = await new Bun.Image(bytes).resize(sizes.small, sizes.small, { fit: "inside" }).webp({ quality: 80 }).toBuffer();
    const large = await new Bun.Image(bytes).resize(sizes.large, sizes.large, { fit: "inside" }).webp({ quality: 82 }).toBuffer();
    await Bun.write(join(IMAGE_DIR, `${hash}-${sizes.small}.webp`), small);
    await Bun.write(join(IMAGE_DIR, `${hash}-${sizes.large}.webp`), large);
    store.saveImage({
      hash,
      source: current.toString(),
      mime: meta.format ?? "image",
      width: meta.width,
      height: meta.height,
      author: cleanCredit(credit.author, 80),
      license: cleanCredit(credit.license, 40),
      page: cleanCredit(credit.page, 400),
    });
    return { hash, source: current.toString() };
  }
  throw new CoverError("Слишком много перенаправлений.", "Too many redirects.");
}

/** Поиск картинок: Wikimedia Commons, при пустом ответе — Openverse. */
const COMMONS_API = process.env.LOT_COMMONS_API ?? "https://commons.wikimedia.org/w/api.php";
const OPENVERSE_API = process.env.LOT_OPENVERSE_API ?? "https://api.openverse.org/v1/images/";
const IMAGE_UA = "TheLot/1.0 (+https://lot.bunker9.lol)";
const SEARCH_TTL = 10 * 60 * 1000;
const SEARCH_CACHE_LIMIT = 120;
const searchCache = new Map<string, { expires: number; list: CoverCandidate[] }>();

type CoverCandidate = { thumb: string; url: string; title: string; author: string; license: string; page: string };

function plainText(value: unknown, max = 80) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function commonsCandidates(query: string): Promise<CoverCandidate[]> {
  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", "6");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata|size");
  url.searchParams.set("iiurlwidth", "240");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  const response = await fetch(url, {
    headers: { "user-agent": IMAGE_UA, accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return [];
  const body: any = await response.json().catch(() => null);
  const pages = Array.isArray(body?.query?.pages) ? body.query.pages : [];
  const out: CoverCandidate[] = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    if (!info?.thumburl || !info?.descriptionurl) continue;
    if (Number(info.width) > 0 && Number(info.width) < 300) continue;
    const meta = info.extmetadata ?? {};
    out.push({
      thumb: String(info.thumburl),
      url: String(info.thumburl),
      title: plainText(page.title, 80).replace(/^File:/, ""),
      author: plainText(meta.Artist?.value, 80),
      license: plainText(meta.LicenseShortName?.value, 40),
      page: String(info.descriptionurl),
    });
  }
  return out;
}

async function openverseCandidates(query: string): Promise<CoverCandidate[]> {
  const url = new URL(OPENVERSE_API);
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", "6");
  const response = await fetch(url, {
    headers: { "user-agent": IMAGE_UA, accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return [];
  const body: any = await response.json().catch(() => null);
  const results = Array.isArray(body?.results) ? body.results : [];
  const out: CoverCandidate[] = [];
  for (const item of results) {
    const thumb = item?.thumbnail ?? item?.url;
    if (!thumb || !item?.url) continue;
    out.push({
      thumb: String(thumb),
      url: String(item.url),
      title: plainText(item.title, 80) || plainText(query, 80),
      author: plainText(item.creator, 80),
      license: plainText([item.license, item.license_version].filter(Boolean).join(" ").toUpperCase(), 40),
      page: String(item.foreign_landing_url ?? item.url),
    });
  }
  return out;
}

/** Кандидаты кешируются и сразу скачиваются в наше хранилище — превью с чужого домена CSP не пустит. */
async function findCovers(query: string): Promise<CoverCandidate[]> {
  const key = query.trim().toLowerCase().slice(0, 80);
  if (!key) return [];
  const hit = searchCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.list;

  let list = await commonsCandidates(query).catch(() => [] as CoverCandidate[]);
  if (list.length === 0) list = await openverseCandidates(query).catch(() => [] as CoverCandidate[]);

  // Качаем кандидатов параллельно, но не ждём всех дольше трёх секунд:
  // кто успел — тот и в ответе, остальные догонят кеш уже после.
  const ready: CoverCandidate[] = [];
  const jobs = list.map(async (candidate) => {
    try {
      const image = await ingestImage(candidate.thumb, "cover", candidate);
      ready.push({ ...candidate, thumb: `/img/x/${image.hash}-192.webp` });
    } catch {
      /* кандидат не скачался — пропускаем */
    }
  });
  await Promise.race([Promise.all(jobs), new Promise((resolve) => setTimeout(resolve, 3000))]);
  ready.sort((a, b) => list.findIndex((item) => item.url === a.url) - list.findIndex((item) => item.url === b.url));

  // Пустой ответ не кешируем: сеть могла моргнуть, попробуем в следующий раз.
  if (ready.length > 0) {
    if (searchCache.size >= SEARCH_CACHE_LIMIT) searchCache.delete(searchCache.keys().next().value as string);
    searchCache.set(key, { expires: Date.now() + SEARCH_TTL, list: ready });
  }
  return ready;
}

/* ── авто-картинки предметов: ищем без участия игрока ── */

const WIKI_API = process.env.LOT_WIKI_API ?? "https://{lang}.wikipedia.org/w/api.php";
const ANILIST_API = process.env.LOT_ANILIST_API ?? "https://graphql.anilist.co";
/** Авто-картинки можно выключить (e2e без сети): LOT_AUTO_IMAGES=0. */
const AUTO_ENABLED = process.env.LOT_AUTO_IMAGES !== "0";
const AUTO_MISS_TTL = 30 * 24 * 60 * 60 * 1000;
const AUTO_CONCURRENCY = 3;
/** @type {Map<string, Promise<string | null>>} */
const autoInflight = new Map();
/** Общий потолок обращений к Википедии: комнат может быть много. */
let autoSlots = 6;
const autoWaiters: (() => void)[] = [];
const autoWaitersHigh: (() => void)[] = [];

async function autoSlot<T>(run: () => Promise<T>, high = false): Promise<T> {
  if (autoSlots <= 0) await new Promise<void>((resolve) => (high ? autoWaitersHigh : autoWaiters).push(resolve));
  autoSlots -= 1;
  try {
    return await run();
  } finally {
    autoSlots += 1;
    (autoWaitersHigh.shift() ?? autoWaiters.shift())?.();
  }
}

function autoKey(name: string) {
  return name.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Аниме-персонажи: официальный арт из AniList (Википедия несвободные картинки не отдаёт). */
let anilistChain: Promise<void> = Promise.resolve();

/** AniList держит 90 запросов в минуту — пропускаем не чаще одного в 450 мс. */
function anilistTick() {
  const wait = anilistChain.then(() => new Promise<void>((resolve) => setTimeout(resolve, 700)));
  anilistChain = wait;
  return wait;
}

function tokensOf(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

async function anilistPictures(name: string) {
  const query = name.replace(/\s+vs\.?\s+.*$/i, "").replace(/["'’]/g, "").trim().slice(0, 80);
  if (!query) return [];
  await anilistTick();
  const response = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": IMAGE_UA },
    body: JSON.stringify({
      query: "query($q:String){Page(perPage:5){characters(search:$q){name{full} image{large} siteUrl}}}",
      variables: { q: query },
    }),
    signal: AbortSignal.timeout(7000),
  }).catch(() => null);
  if (!response?.ok) return [];
  const body: any = await response.json().catch(() => null);
  const list = Array.isArray(body?.data?.Page?.characters) ? body.data.Page.characters : [];
  const wanted = tokensOf(query);
  return list
    .filter((character: any) => character?.image?.large)
    .filter((character: any) => {
      const got = tokensOf(String(character.name?.full ?? ""));
      return wanted.some((token) => got.includes(token));
    })
    .map((character: any) => ({
      url: String(character.image.large),
      license: "AniList",
      page: String(character.siteUrl ?? "https://anilist.co"),
      author: "",
    }));
}

/** Адрес, по которому картинку увидит проверяющая модель: только наш публичный origin. */
const PUBLIC_BASE = (process.env.LOT_PUBLIC_URL ?? "").replace(/\/+$/, "");
const IMAGE_CHECK = PUBLIC_BASE.length > 0 && imageCheckAvailable() && process.env.LOT_IMAGE_CHECK !== "0";
let checkSlots = 2;
const checkWaiters: (() => void)[] = [];

async function checkSlot<T>(run: () => Promise<T>): Promise<T> {
  if (checkSlots <= 0) await new Promise<void>((resolve) => checkWaiters.push(resolve));
  checkSlots -= 1;
  try {
    return await run();
  } finally {
    checkSlots += 1;
    checkWaiters.shift()?.();
  }
}

/**
 * Смотрит на скачанную картинку глазами модели. Без публичного адреса
 * или ключа проверка недоступна — тогда верим источникам (checker=heuristic).
 */
async function verifyPicture(hash: string, item: string, pack: string) {
  if (!IMAGE_CHECK) return { ok: true, what: "", checker: "heuristic" };
  const url = `${PUBLIC_BASE}/img/x/${hash}-342.webp`;
  const verdict = await checkSlot(() => checkImage(url, item, pack)).catch(() => null);
  if (!verdict) return { ok: true, what: "", checker: "heuristic" };
  if (!verdict.ok) console.log(`[image] отклонено «${item}» (${pack}): ${verdict.what || "не то"}`);
  return { ok: verdict.ok, what: verdict.what, checker: "vision" };
}

/** Статья Википедии с картинкой в карточке: сначала русская, потом английская. */
async function wikiPicture(name: string) {
  for (const lang of ["ru", "en"]) {
    const url = new URL(WIKI_API.replace("{lang}", lang));
    url.searchParams.set("action", "query");
    url.searchParams.set("generator", "search");
    url.searchParams.set("gsrsearch", name);
    url.searchParams.set("gsrlimit", "1");
    url.searchParams.set("prop", "pageimages|info");
    url.searchParams.set("piprop", "thumbnail");
    url.searchParams.set("pithumbsize", "400");
    url.searchParams.set("redirects", "1");
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    const response = await fetch(url, {
      headers: { "user-agent": IMAGE_UA, accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    }).catch(() => null);
    if (!response?.ok) continue;
    const body: any = await response.json().catch(() => null);
    const page = (Array.isArray(body?.query?.pages) ? body.query.pages : [])[0];
    const thumb = page?.thumbnail;
    if (!thumb?.source) continue;
    if (/disambiguation|значения/i.test(String(page.title ?? ""))) continue;
    if (Number(thumb.width ?? 0) > 0 && Number(thumb.width) < 180) continue;
    return {
      url: String(thumb.source),
      license: lang === "ru" ? "Википедия" : "Wikipedia",
      page: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(page.title ?? name).replace(/ /g, "_"))}`,
    };
  }
  return null;
}

/**
 * Одна картинка на предмет: Википедия → Commons. Результат (в том числе промах)
 * кешируется, поэтому пак прогревается один раз на всех игроков.
 */
async function resolveItemPicture(name: string, anime = false, high = false, packName = ""): Promise<string | null> {
  if (!AUTO_ENABLED) return null;
  const key = autoKey(name);
  if (!key) return null;
  const cached = store.autoImage(key);
  if (cached) return cached;
  if (store.autoMissed(key, AUTO_MISS_TTL)) return null;
  const running = autoInflight.get(key);
  if (running) return running;

  const job = autoSlot(async () => {
    try {
      // Кандидаты по порядку доверия: официальный арт, статья, свободные фото.
      const candidates: { url: string; author?: string; license?: string; page?: string }[] = [];
      if (anime) candidates.push(...(await anilistPictures(name).catch(() => [])));
      const wiki = await wikiPicture(name).catch(() => null);
      if (wiki) candidates.push(wiki);
      const commons = await commonsCandidates(name).catch(() => []);
      candidates.push(...commons.slice(0, 3));

      let checks = 0;
      for (const candidate of candidates.slice(0, 6)) {
        const image = await ingestImage(candidate.url, "item", {
          author: candidate.author,
          license: candidate.license,
          page: candidate.page,
        });
        // Не гоняем модель по кругу: три вердикта на предмет — потолок.
        if (checks >= 3) break;
        checks += 1;
        const verdict = await verifyPicture(image.hash, name, packName);
        if (!verdict.ok) continue;
        store.saveAutoImage(key, image.hash, verdict.checker);
        if (verdict.what) console.log(`[image] «${name}» ← ${verdict.what}`);
        return image.hash;
      }
      store.saveAutoMiss(key);
      return null;
    } catch {
      store.saveAutoMiss(key);
      return null;
    } finally {
      autoInflight.delete(key);
    }
  }, high);
  autoInflight.set(key, job);
  return job;
}

/** Подтянуть из кеша всё, что уже найдено для выбранного пака. */
function autoFor(room: any) {
  const pack = room.customPack ?? content.packById.get(room.packId);
  const auto: Record<string, string> = {};
  for (const name of pack?.items ?? []) {
    const hash = store.autoImage(autoKey(name));
    if (hash) auto[name] = hash;
  }
  room.auto = auto;
  return auto;
}

/** Прогреваем пак заранее: к началу торгов картинки уже лежат в комнате. */
async function prefetchPack(room: any) {
  if (!AUTO_ENABLED) return;
  const pack = room.customPack ?? content.packById.get(room.packId);
  if (!pack || pack.profile === "internet-ratings") return;
  const queue = (pack.items as string[]).filter(
    (name) => !room.auto?.[name] && !room.items?.[pack.id]?.[name] && !store.autoMissed(autoKey(name), AUTO_MISS_TTL),
  );
  if (queue.length === 0) return;
  room.prefetchQueue = queue;
  let last = 0;
  const worker = async () => {
    for (;;) {
      const name = queue.shift();
      if (!name) return;
      const hash = await resolveItemPicture(name, pack.tab === "ANIME", false, pack.name);
      if (!hash) continue;
      room.auto = { ...(room.auto ?? {}), [name]: hash };
      creditsFor(room);
      if (room.phase === "auction" && Date.now() - last > 900) {
        last = Date.now();
        persist(room);
        broadcast(room, "full");
      }
    }
  };
  await Promise.all(Array.from({ length: AUTO_CONCURRENCY }, worker));
  if (room.prefetchQueue === queue) room.prefetchQueue = null;
  if (room.phase === "auction") {
    persist(room);
    broadcast(room, "full");
  }
}

/** Пак выбирают кликами — прогреваем только после паузы. */
function schedulePrefetch(room: any, delay = 1500) {
  if (!AUTO_ENABLED) return;
  clearTimeout(room.prefetchTimer);
  room.prefetchTimer = setTimeout(() => {
    room.prefetchTimer = null;
    void prefetchPack(room);
  }, delay);
  room.prefetchTimer?.unref?.();
}

/** Текущий лот важнее остальных: если картинки нет, ищем именно его. */
async function ensureLotPicture(room: any) {
  if (!AUTO_ENABLED || room.phase !== "auction") return;
  const pack = room.customPack ?? content.packById.get(room.packId);
  const lot = room.lots[room.lotIndex];
  if (!pack || !lot || pack.profile === "internet-ratings") return;
  if (room.items?.[pack.id]?.[lot.name] || room.auto?.[lot.name] || lot.poster) return;
  // Текущий лот — вне очереди прогрева и вне общей очереди источников.
  if (Array.isArray(room.prefetchQueue)) room.prefetchQueue.unshift(lot.name);
  const hash = await resolveItemPicture(lot.name, pack.tab === "ANIME", true, pack.name);
  if (!hash) return;
  room.auto = { ...(room.auto ?? {}), [lot.name]: hash };
  creditsFor(room);
  persist(room);
  broadcast(room, "full");
}

/** Атрибуция — обычный текст без разметки и управляющих символов. */
function cleanCredit(value: unknown, max: number) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Картинки предметов качаем после ответа: пака из 60 предметов никто не должен ждать.
 * Готовые падают в комнату патчами, так что постеры появляются по мере скачивания.
 */
async function ingestItemPictures(room: any, packId: string, entries: { item: string; url: string }[], owner: string) {
  const queue = [...entries];
  let ok = 0;
  let last = 0;
  const ping = () => {
    if (Date.now() - last < 700) return;
    last = Date.now();
    persist(room);
    broadcast(room, "full");
  };
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        const image = await ingestImage(next.url, "item");
        store.setItemImage(owner, packId, next.item, image.hash);
        room.items = store.itemImages(owner);
        creditsFor(room);
        ok += 1;
        ping();
      } catch {
        /* битая ссылка — просто нет постера */
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  persist(room);
  broadcast(room, "full");
  if (room.hostSession) {
    say(
      room,
      room.hostSession,
      `Картинки предметов: ${ok} из ${entries.length}.`,
      `Item images: ${ok} of ${entries.length}.`,
    );
  }
}

/** Обложки принадлежат хозяину стола: у гостя они просто видны. */
function coversFor(room: any) {
  const owner = hostPidOf(room);
  room.covers = owner ? store.packCovers(owner) : {};
  return room.covers;
}

/** Постеры предметов из своих паков: pack → item → hash. */
function itemsFor(room: any) {
  const owner = hostPidOf(room);
  room.items = owner ? store.itemImages(owner) : {};
  return room.items;
}

/** Подписи к картинкам, которые сейчас видны в комнате. */
function creditsFor(room: any) {
  const hashes = new Set<string>(Object.values(room.covers ?? {}) as string[]);
  for (const pack of Object.values(room.items ?? {}) as Record<string, string>[]) {
    for (const hash of Object.values(pack)) hashes.add(hash);
  }
  for (const hash of Object.values(room.auto ?? {}) as string[]) hashes.add(hash);
  const credits: Record<string, { author: string; license: string; page: string }> = {};
  for (const image of store.imagesByHashes([...hashes])) {
    if (!image.author && !image.license) continue;
    credits[image.hash] = { author: image.author, license: image.license, page: image.page };
  }
  room.credits = credits;
  return credits;
}

/* ── свои паки ── */

/** Хозяин стола — первый pid комнаты (в локальном режиме pid один на двоих). */
function hostPidOf(room: any) {
  const owner = Array.isArray(room.pids) ? room.pids[0] : null;
  return typeof owner === "string" ? owner : "";
}

/** Пак из каталога или свой — только для них можно ставить обложку. */
function knownPackId(room: any, id: string) {
  return content.packById.has(id) || room.customPack?.id === id;
}

/** Список сохранённых паков живёт в комнате: он же уходит в патчи лобби. */
function libraryFor(room: any) {
  room.customLib = hostPidOf(room) ? store.listCustomPacks(hostPidOf(room)) : [];
  return room.customLib;
}

/** Пак из хранилища → пак комнаты: id остаётся за столом, содержимое — из записи. */
function useSavedPack(room: any, pack: store.FullPack) {
  engine.setCustomPack(room, {
    id: `custom-${room.code.toLowerCase()}`,
    name: pack.name,
    emoji: pack.emoji,
    tab: "CUSTOM",
    count: pack.items.length,
    items: pack.items,
    profile: "party",
    libId: pack.id,
  });
  room.customPackLibId = pack.id;
  store.touchCustomPack(hostPidOf(room), pack.id);
  libraryFor(room);
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
    if (!allow(`upload:${pid}`, 1 / 5, 6)) return redirect(room.lang === "en" ? "Too often — give it a moment." : "Слишком часто — подождите немного.");
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
    // Предмет — строка или объект { name, image }: во втором случае картинку скачаем после загрузки.
    const cleanItem = (value: string) =>
      value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    const names: string[] = [];
    const pictures = new Map<string, string>();
    for (const entry of items) {
      if (typeof entry === "string") {
        const name = cleanItem(entry);
        if (name) names.push(name);
        continue;
      }
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string") continue;
      const name = cleanItem(entry.name);
      if (!name) continue;
      names.push(name);
      if (typeof entry.image === "string" && /^https?:\/\//i.test(entry.image.trim())) {
        pictures.set(name, entry.image.trim().slice(0, 2000));
      }
    }
    const cleaned = [...new Set(names)];
    if (cleaned.length < 5 || cleaned.length > 60) return redirect("Нужно от 5 до 60 уникальных предметов.");
    const itemPictures = cleaned
      .filter((name) => pictures.has(name))
      .map((name) => ({ item: name, url: pictures.get(name)! }));
    const name = typeof parsed?.name === "string" && parsed.name.trim()
      ? parsed.name.trim().replace(/[\u0000-\u001f]/g, "").slice(0, 40)
      : room.lang === "en" ? "Custom pack" : "Свой пак";
    const emoji = typeof parsed?.emoji === "string" && parsed.emoji.trim() ? [...parsed.emoji.trim()][0] : "🎲";
    // Свой пак остаётся у игрока: id — от содержимого, поэтому повтор загрузки не плодит копий.
    const saved = store.saveCustomPack(hostPidOf(room) || pid, { name, emoji, items: cleaned });
    engine.setCustomPack(room, {
      id: `custom-${room.code.toLowerCase()}`,
      name,
      emoji,
      tab: "CUSTOM",
      count: cleaned.length,
      items: cleaned,
      profile: "party",
    });
    room.customPackLibId = saved.id;
    libraryFor(room);
    const owner = hostPidOf(room) || pid;
    store.clearItemImages(owner, `custom-${room.code.toLowerCase()}`);
    itemsFor(room);
    persist(room);
    broadcast(room, "full");
    if (itemPictures.length) void ingestItemPictures(room, room.packId, itemPictures, owner);
    return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: back } });
  }

  if (cmd === "custom-load" || cmd === "custom-forget") {
    if (!room) return fail(request, "Комната не найдена.", 410);
    if (!engine.isHost(room, sid)) return fail(request, "Пак меняет хозяин стола.", 403);
    if (room.phase !== "lobby") return fail(request, "Драфт уже начался.", 409);
    const body = await readBody(request);
    const id = typeof body.id === "string" ? body.id.slice(0, 40) : "";
    const owner = hostPidOf(room) || pid;
    if (cmd === "custom-load") {
      const pack = store.getCustomPack(owner, id);
      if (!pack) return fail(request, "Такого пака больше нет.", 404);
      useSavedPack(room, pack);
    } else {
      store.forgetCustomPack(owner, id);
      if (room.customPackLibId === id) engine.clearCustomPack(room);
      libraryFor(room);
    }
    persist(room);
    broadcast(room, "full");
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
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
    libraryFor(room);
    coversFor(room);
    itemsFor(room);
    autoFor(room);
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
      // Приход второго игрока меняет только шапку и пульт: каталог не пересылаем.
      broadcast(room, "lobby");
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
    case "cover": {
      if (!host) return fail(request, "Обложку ставит хозяин стола.", 403);
      if (room.phase !== "lobby") return fail(request, "Драфт уже начался.", 409);
      const back = `/r/${room.code}`;
      const redirect = (message?: { ru: string; en: string } | string) => {
        if (message) {
          session.notice =
            typeof message === "string" ? message : room.lang === "en" ? message.en : message.ru;
        }
        return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: back } });
      };
      if (!allow(`cover:${pid}`, 1 / 3, 8)) {
        return redirect(room.lang === "en" ? "Too often — give it a moment." : "Слишком часто — подождите немного.");
      }
      const packId = typeof body.pack === "string" && body.pack ? String(body.pack).slice(0, 60) : room.packId;
      if (!knownPackId(room, packId)) return redirect(room.lang === "en" ? "Unknown pack." : "Неизвестный пак.");
      const url = typeof body.url === "string" ? body.url.trim().slice(0, 2000) : "";
      if (!/^https?:\/\//i.test(url)) return redirect(room.lang === "en" ? "Paste a link to an image." : "Вставьте ссылку на картинку.");
      try {
        const credit: ImageCredit = { author: body.author, license: body.license, page: body.page };
        const image = await ingestImage(url, "cover", credit);
        const owner = hostPidOf(room) || pid;
        store.setPackCover(owner, packId, image.hash);
        room.covers = store.packCovers(owner);
        creditsFor(room);
        persist(room);
        broadcast(room, "full");
        return redirect(room.lang === "en" ? "Cover updated." : "Обложка обновлена.");
      } catch (error) {
        if (error instanceof CoverError) return redirect({ ru: error.ru, en: error.en });
        console.error("[cover]", error instanceof Error ? error.message : error);
        return redirect(room.lang === "en" ? "Could not take that image." : "Не получилось взять картинку.");
      }
    }
    case "cover-find": {
      if (!host) return fail(request, "Искать картинку может хозяин стола.", 403);
      if (room.phase !== "lobby") return fail(request, "Драфт уже начался.", 409);
      if (!allow(`find:${pid}`, 1 / 2, 6)) return tooMany(4);
      const packId = typeof body.pack === "string" && body.pack ? String(body.pack).slice(0, 60) : room.packId;
      const pack = room.customPack?.id === packId ? room.customPack : content.packById.get(packId);
      if (!pack) return json({ candidates: [] }, 404);
      const query = cleanCredit(body.q, 80) || cleanCredit(pack.name, 80);
      const candidates = await findCovers(query);
      return json({ candidates });
    }
    case "lot-find": {
      if (!host) return fail(request, "Искать картинку может хозяин стола.", 403);
      if (room.phase !== "auction") return fail(request, "Сейчас не торги.", 409);
      if (!allow(`find:${pid}`, 1 / 2, 6)) return tooMany(4);
      const lot = room.lots[room.lotIndex];
      if (!lot) return json({ candidates: [] }, 409);
      const query = cleanCredit(body.q, 80) || cleanCredit(lot.name, 80);
      const candidates = await findCovers(query);
      return json({ candidates });
    }
    case "lot-image": {
      if (!host) return fail(request, "Картинку ставит хозяин стола.", 403);
      if (room.phase !== "auction") return fail(request, "Сейчас не торги.", 409);
      const back = `/r/${room.code}`;
      const redirect = (message?: { ru: string; en: string } | string) => {
        if (message) session.notice = typeof message === "string" ? message : room.lang === "en" ? message.en : message.ru;
        return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: back } });
      };
      if (!allow(`cover:${pid}`, 1 / 3, 8)) {
        return redirect(room.lang === "en" ? "Too often — give it a moment." : "Слишком часто — подождите немного.");
      }
      const lot = room.lots[room.lotIndex];
      const item = typeof body.item === "string" ? body.item.slice(0, 80) : lot?.name;
      if (!lot || item !== lot.name) return redirect(room.lang === "en" ? "That lot is gone." : "Этот лот уже ушёл.");
      const url = typeof body.url === "string" ? body.url.trim().slice(0, 2000) : "";
      if (!/^https?:\/\//i.test(url)) return redirect(room.lang === "en" ? "Paste a link to an image." : "Вставьте ссылку на картинку.");
      try {
        const image = await ingestImage(url, "item", { author: body.author, license: body.license, page: body.page });
        const owner = hostPidOf(room) || pid;
        store.setItemImage(owner, room.packId, item, image.hash);
        room.items = store.itemImages(owner);
        creditsFor(room);
        persist(room);
        broadcast(room, "full");
        return redirect(room.lang === "en" ? "Lot image set." : "Картинка лота поставлена.");
      } catch (error) {
        if (error instanceof CoverError) return redirect({ ru: error.ru, en: error.en });
        console.error("[lot-image]", error instanceof Error ? error.message : error);
        return redirect(room.lang === "en" ? "Could not take that image." : "Не получилось взять картинку.");
      }
    }
    case "lot-clear": {
      if (!host) return fail(request, "Картинку меняет хозяин стола.", 403);
      if (room.phase !== "auction") return fail(request, "Сейчас не торги.", 409);
      const lot = room.lots[room.lotIndex];
      const item = typeof body.item === "string" ? body.item.slice(0, 80) : lot?.name;
      const owner = hostPidOf(room) || pid;
      if (item) store.clearItemImage(owner, room.packId, item);
      room.items = store.itemImages(owner);
      creditsFor(room);
      persist(room);
      broadcast(room, "full");
      session.notice = room.lang === "en" ? "Lot image removed." : "Картинка лота убрана.";
      return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: `/r/${room.code}` } });
    }
    case "cover-clear": {
      if (!host) return fail(request, "Обложку меняет хозяин стола.", 403);
      if (room.phase !== "lobby") return fail(request, "Драфт уже начался.", 409);
      const packId = typeof body.pack === "string" && body.pack ? String(body.pack).slice(0, 60) : room.packId;
      const owner = hostPidOf(room) || pid;
      store.clearPackCover(owner, packId);
      room.covers = store.packCovers(owner);
      creditsFor(room);
      persist(room);
      broadcast(room, "full");
      session.notice = room.lang === "en" ? "Cover removed." : "Обложка убрана.";
      return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: `/r/${room.code}` } });
    }
    case "pack": {
      if (!host) return fail(request, "Пак выбирает хозяин стола.", 403);
      if (lobbyOnly) return fail(request, "Драфт уже начался.", 409);
      engine.setPack(room, String(body.pack ?? ""));
      autoFor(room);
      touch("lobby");
      schedulePrefetch(room);
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
      clearTimeout(room.prefetchTimer);
      void ensureLotPoster(room);
      void prefetchPack(room);
      void ensureLotPicture(room);
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
      if (room.phase === "auction") {
        void ensureLotPoster(room);
        void ensureLotPicture(room);
      }
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
/** Байты статики в памяти процесса: отдаём без чтения с диска. */
const STATIC_CACHE = new Map<string, { mtime: number; size: number; body: Uint8Array }>();

/** Допустимые превью TMDb: миниатюра в отчёте — w92, плашка лота — w342. */
const POSTER_SIZES = new Set(["w92", "w154", "w342"]);

async function tmdbImage(file: string, size: string) {
  const key = `${size}/${file}`;
  const cached = IMAGE_CACHE.get(key);
  if (cached) return cached;
  const upstream = await fetch(`https://image.tmdb.org/t/p/${size}/${file}`, { signal: AbortSignal.timeout(12_000) });
  if (!upstream.ok) return null;
  const type = upstream.headers.get("content-type") ?? "image/jpeg";
  if (!type.startsWith("image/")) return null;
  const body = new Uint8Array(await upstream.arrayBuffer());
  if (body.byteLength > 2_000_000) return null;
  if (IMAGE_CACHE.size > IMAGE_LIMIT) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value as string);
  const entry = { body, type };
  IMAGE_CACHE.set(key, entry);
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

/**
 * Статика неизменяема: ссылки в HTML всегда с ?v=<версия сборки>.
 * Такие ответы кешируются браузером и Cloudflare на год, без Set-Cookie и перепроверок.
 */
async function serveStatic(pathname: string, version: string | null) {
  const relative = normalize(pathname.replace(/^\/public\/?/, "")).replace(/^(\.\.[/\\])+/, "");
  if (!relative || relative.startsWith("..")) return new Response("Not found", { status: 404 });
  const absolute = resolve("public", relative);
  const file = Bun.file(absolute);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const ext = relative.slice(relative.lastIndexOf("."));

  // Файлы вендора версионированы именем, остальные — параметром ?v=.
  const immutable = version === ASSET_VERSION || relative.startsWith("vendor/");
  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
  };

  // Байты держим в памяти: у продакшена статика не меняется без перезапуска,
  // а mtime-проверка не даёт отдавать старое при разработке.
  const mtime = file.lastModified ?? 0;
  const cached = STATIC_CACHE.get(absolute);
  if (cached && cached.mtime === mtime && cached.size === file.size) {
    return new Response(cached.body.slice().buffer, { headers });
  }
  const body = new Uint8Array(await file.arrayBuffer());
  STATIC_CACHE.set(absolute, { mtime, size: body.byteLength, body });
  return new Response(body.slice().buffer, { headers });
}

/* ─────────────────────── сервер ─────────────────────── */

const server = Bun.serve({
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
      // Публично — только жизнь процесса. Счётчики и наличие ключей — только с токеном.
      const brief = { ok: true, uptime: Math.round(process.uptime()) };
      const ops = request.headers.get("x-lot-ops") ?? url.searchParams.get("token") ?? "";
      if (!tokenMatches(ops)) return json(brief);
      return json({
        ...brief,
        rooms: rooms.size,
        sessions: sessions.size,
        db: store.dbStats(),
        ai: aiStatus(),
        assets: ASSET_VERSION,
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
      const body = `User-agent: *\nAllow: /$\nDisallow: /r/\nDisallow: /act/\nDisallow: /img/\nSitemap: ${origin}/sitemap.xml\n`;
      return new Response(body, {
        headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    if (path === "/sitemap.xml") {
      const lastmod = new Date().toISOString().slice(0, 10);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${origin}/</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`;
      return new Response(xml, {
        headers: { ...SECURITY_HEADERS, "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    if (path === "/sw.js") {
      // Токен версии подставляем на отдаче: новый деплой = новый кеш у клиента.
      const source = await Bun.file(resolve("public/sw.js")).text().catch(() => "");
      if (!source) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
      return new Response(source.replaceAll("__LOT_ASSET_VERSION__", ASSET_VERSION), {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "Service-Worker-Allowed": "/",
        },
      });
    }

    if (path.startsWith("/img/x/")) {
      const file = path.slice("/img/x/".length);
      if (!/^[a-f0-9]{24}-(92|96|192|342)\.webp$/.test(file)) return new Response("Not found", { status: 404 });
      const image = Bun.file(join(IMAGE_DIR, file));
      if (!(await image.exists())) return new Response("Not found", { status: 404 });
      return new Response(image, {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (path.startsWith("/img/tmdb/")) {
      const rest = path.slice("/img/tmdb/".length);
      const [head, ...tail] = rest.split("/");
      const sized = POSTER_SIZES.has(head ?? "");
      const size = sized ? (head as string) : "w342";
      const file = sized ? tail.join("/") : rest;
      if (!/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(file)) return new Response("Not found", { status: 404 });
      const image = await tmdbImage(file, size).catch(() => null);
      if (!image) return new Response("Not found", { status: 404 });
      return new Response(image.body.slice().buffer, {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": image.type,
          "Cache-Control": "public, max-age=2592000, immutable",
        },
      });
    }

    if (path === "/catalog") {
      // Каталог неизменяем: версия в ссылке, поэтому кеш на год и без cookie.
      const lang: Lang = url.searchParams.get("lang") === "en" ? "en" : "ru";
      const immutable = url.searchParams.get("v") === ASSET_VERSION;
      return new Response(catalogFragment(lang), {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
        },
      });
    }

    if (path.startsWith("/public/")) {
      return serveStatic(path, url.searchParams.get("v"));
    }

    if (path.startsWith("/act/")) {
      const cmd = path.slice(5);
      if (!allow(`act:${sid}`, 8, 60)) return withSid(tooMany(2));
      if (cmd === "create") {
        if (rooms.size >= ROOM_LIMIT) return withSid(html("<p>Столы заняты — попробуйте через минуту. <a href=\"/\">На главную</a></p>", 503));
        if (!allow(`create:${ipOf(request)}`, 1 / 6, 20)) return withSid(tooMany(60));
      }
      if (cmd === "join" && !allow(`join:${ipOf(request)}`, 1 / 2, 40)) return withSid(tooMany(5));
      return withSid(await handleAction(request, cmd, sid, pid, origin, secure));
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
          void ensureLotPicture(room);
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
      libraryFor(room);
      coversFor(room);
      itemsFor(room);
      autoFor(room);
      creditsFor(room);
      const pageView: any = engine.view(room, sid, origin);
      pageView.lang = langOf(request);
      const notice = session.notice ?? "";
      session.notice = undefined;
      return withSid(html(roomPage(pageView, notice)));
    }

    if (path === "/favicon.ico") return new Response(null, { status: 204, headers: SECURITY_HEADERS });

    return withSid(html(`<p>Страница не найдена. <a href="/">На главную</a></p>`, 404));
  },
});

/* ─────────────────────── уборка ─────────────────────── */

const MAX_AGE = 12 * 60 * 60 * 1000;
const IMAGE_TTL = 90 * 24 * 60 * 60 * 1000;
setInterval(async () => {
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
  const stale = now - 10 * 60 * 1000;
  for (const [key, bucket] of buckets) {
    if (bucket.updated < stale) buckets.delete(key);
  }
  store.pruneAutoMisses(now - AUTO_MISS_TTL);
  // Картинки, на которые больше никто не ссылается, живут 90 дней.
  for (const hash of store.pruneImages(now - IMAGE_TTL)) {
    await unlink(join(IMAGE_DIR, `${hash}-96.webp`)).catch(() => {});
    await unlink(join(IMAGE_DIR, `${hash}-192.webp`)).catch(() => {});
  }
}, 10 * 60 * 1000);

console.log(
  `The Lot · http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} · паков ${content.packs.length} · ` +
    `модель ${aiStatus().model}${aiStatus().mock ? " (mock)" : ""}${aiStatus().hasKey ? "" : " · ключ не задан"}` +
    `${aiStatus().hasTmdb ? "" : " · TMDb не настроен"}`,
);
