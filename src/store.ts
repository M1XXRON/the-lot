// Хранилище на bun:sqlite: комнаты переживают рестарт, партии остаются в истории.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.env.LOT_DB ?? "data/lot.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 4000;

  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    room TEXT,
    seat INTEGER,
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    pack TEXT NOT NULL,
    profile TEXT NOT NULL,
    judge TEXT NOT NULL,
    payload TEXT NOT NULL,
    pids TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS games_created ON games(created_at DESC);

  CREATE TABLE IF NOT EXISTS custom_packs (
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    items TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (owner, id)
  );

  CREATE INDEX IF NOT EXISTS custom_packs_owner ON custom_packs(owner, used_at DESC);

  CREATE TABLE IF NOT EXISTS images (
    hash TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    mime TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pack_covers (
    owner TEXT NOT NULL,
    pack TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, pack)
  );

  CREATE TABLE IF NOT EXISTS auto_items (
    name TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    checker TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auto_misses (
    name TEXT PRIMARY KEY,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS item_images (
    owner TEXT NOT NULL,
    pack TEXT NOT NULL,
    item TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, pack, item)
  );
`);

// Миграция для баз, созданных до появления истории игрока.
try {
  const columns = db.query("PRAGMA table_info(games)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "pids")) db.exec("ALTER TABLE games ADD COLUMN pids TEXT");
} catch {
  /* база только создана */
}

// Проверка картинок появилась позже: старые записи без метки считаем непроверенными.
try {
  const columns = db.query("PRAGMA table_info(auto_items)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "checker")) db.exec("ALTER TABLE auto_items ADD COLUMN checker TEXT NOT NULL DEFAULT ''");
} catch {
  /* база только создана */
}

// Атрибуция картинок появилась позже: догоняем существующие базы.
try {
  const columns = db.query("PRAGMA table_info(images)").all() as { name: string }[];
  for (const [name, type] of [["author", "TEXT"], ["license", "TEXT"], ["page", "TEXT"]]) {
    if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE images ADD COLUMN ${name} ${type} NOT NULL DEFAULT ''`);
  }
} catch {
  /* база только создана */
}

const upsertRoom = db.prepare(
  "INSERT INTO rooms (code, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
);
const removeRoomStmt = db.prepare("DELETE FROM rooms WHERE code = ?");
const upsertSession = db.prepare(
  "INSERT INTO sessions (id, room, seat, created_at, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET room = excluded.room, seat = excluded.seat, seen_at = excluded.seen_at",
);
const insertGame = db.prepare(
  "INSERT INTO games (code, pack, profile, judge, payload, pids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

const upsertPack = db.prepare(
  "INSERT INTO custom_packs (owner, id, name, emoji, items, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(owner, id) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, items = excluded.items, used_at = excluded.used_at",
);
const listPacksStmt = db.prepare("SELECT id, name, emoji, items FROM custom_packs WHERE owner = ? ORDER BY used_at DESC LIMIT ?");
const getPackStmt = db.prepare("SELECT id, name, emoji, items FROM custom_packs WHERE owner = ? AND id = ?");
const dropPackStmt = db.prepare("DELETE FROM custom_packs WHERE owner = ? AND id = ?");
const trimPacksStmt = db.prepare(
  "DELETE FROM custom_packs WHERE owner = ? AND id NOT IN (SELECT id FROM custom_packs WHERE owner = ? ORDER BY used_at DESC LIMIT ?)",
);

/** Сколько своих паков держим у игрока. */
export const CUSTOM_PACK_LIMIT = 12;

/** @type {Set<string>} */
const dirty = new Set<string>();
/** @type {Map<string, { sessionId: string; room: string | null; seat: number | null }>} */
const sessionRows = new Map<string, { sessionId: string; room: string | null; seat: number | null }>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** @param {{ code: string }} room */
export function saveRoom(room: { code: string }) {
  dirty.add(room.code);
  if (!timer) timer = setTimeout(flush, 450);
}

/** @param {string} code */
export function deleteRoom(code: string) {
  dirty.delete(code);
  removeRoomStmt.run(code);
}

export function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (dirty.size === 0) return;
  db.transaction(() => {
    for (const code of dirty) {
      const row = rooms.get(code);
      if (!row) continue;
      upsertRoom.run(code, JSON.stringify(row), Date.now());
    }
  })();
  dirty.clear();
  for (const [sid, row] of sessionRows) {
    upsertSession.run(sid, row.room, row.seat, Date.now(), Date.now());
  }
}

/** @type {Map<string, any>} */
const rooms = new Map<string, any>();

/** @returns {any[]} */
export function loadRooms() {
  const rows = db.query("SELECT code, state FROM rooms").all() as { code: string; state: string }[];
  const out: any[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.state));
    } catch {
      removeRoomStmt.run(row.code);
    }
  }
  return out;
}

export function registerRoom(room: { code: string }) {
  rooms.set(room.code, room);
}

export function unregisterRoom(code: string) {
  rooms.delete(code);
  deleteRoom(code);
}

/** @returns {{ id: string; room: string | null; seat: number | null }[]} */
export function loadSessions() {
  return db.query("SELECT id, room, seat FROM sessions").all() as {
    id: string;
    room: string | null;
    seat: number | null;
  }[];
}

/* ─────────────── свои паки: храним за постоянным id игрока ─────────────── */

export type SavedPack = { id: string; name: string; emoji: string; count: number };
export type FullPack = { id: string; name: string; emoji: string; items: string[] };

/** Устойчивый id: одинаковый набор с тем же именем не плодит дубликаты. */
function packId(name: string, items: string[]) {
  const source = `${name}\u0001${items.join("\u0000")}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `cp-${hash.toString(36)}`;
}

/** @param {string} owner @param {{ name: string; emoji: string; items: string[] }} pack */
export function saveCustomPack(owner: string, pack: { name: string; emoji: string; items: string[] }): SavedPack {
  const id = packId(pack.name, pack.items);
  const now = Date.now();
  upsertPack.run(owner, id, pack.name, pack.emoji, JSON.stringify(pack.items), now, now);
  trimPacksStmt.run(owner, owner, CUSTOM_PACK_LIMIT);
  return { id, name: pack.name, emoji: pack.emoji, count: pack.items.length };
}

/** @param {string} owner */
export function listCustomPacks(owner: string): SavedPack[] {
  if (!owner) return [];
  const rows = listPacksStmt.all(owner, CUSTOM_PACK_LIMIT) as { id: string; name: string; emoji: string; items: string }[];
  const out: SavedPack[] = [];
  for (const row of rows) {
    try {
      const items = JSON.parse(row.items);
      if (!Array.isArray(items) || items.length === 0) continue;
      out.push({ id: row.id, name: row.name, emoji: row.emoji, count: items.length });
    } catch {
      /* битая строка — пропускаем */
    }
  }
  return out;
}

/** @param {string} owner @param {string} id */
export function getCustomPack(owner: string, id: string): FullPack | null {
  if (!owner || !id) return null;
  const row = getPackStmt.get(owner, id) as { id: string; name: string; emoji: string; items: string } | null;
  if (!row) return null;
  try {
    const items = JSON.parse(row.items);
    if (!Array.isArray(items) || items.length === 0) return null;
    return { id: row.id, name: row.name, emoji: row.emoji, items: items.filter((item: unknown): item is string => typeof item === "string") };
  } catch {
    return null;
  }
}

/** Отметить, что паком только что играли: он поднимется в списке. */
export function touchCustomPack(owner: string, id: string) {
  const pack = getCustomPack(owner, id);
  if (pack) saveCustomPack(owner, pack);
}

/** @param {string} owner @param {string} id */
export function forgetCustomPack(owner: string, id: string): boolean {
  if (!owner || !id) return false;
  const result = dropPackStmt.run(owner, id);
  return Number(result.changes ?? 0) > 0;
}

/* ─────────────── картинки: обложки паков ─────────────── */

export type StoredImage = {
  hash: string;
  source: string;
  mime: string;
  width: number;
  height: number;
  author: string;
  license: string;
  page: string;
};

const insertImage = db.prepare(
  "INSERT INTO images (hash, source, mime, width, height, author, license, page, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(hash) DO UPDATE SET " +
    "author = CASE WHEN images.author = '' THEN excluded.author ELSE images.author END, " +
    "license = CASE WHEN images.license = '' THEN excluded.license ELSE images.license END, " +
    "page = CASE WHEN images.page = '' THEN excluded.page ELSE images.page END",
);
const getImage = db.prepare("SELECT hash, source, mime, width, height, author, license, page FROM images WHERE hash = ?");
const getImages = db.prepare("SELECT hash, source, mime, width, height, author, license, page FROM images WHERE hash IN (SELECT value FROM json_each(?))");
const setCoverStmt = db.prepare(
  "INSERT INTO pack_covers (owner, pack, hash, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner, pack) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at",
);
const dropCoverStmt = db.prepare("DELETE FROM pack_covers WHERE owner = ? AND pack = ?");
const coversStmt = db.prepare("SELECT pack, hash FROM pack_covers WHERE owner = ?");
const setItemStmt = db.prepare(
  "INSERT INTO item_images (owner, pack, item, hash, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner, pack, item) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at",
);
const dropItemStmt = db.prepare("DELETE FROM item_images WHERE owner = ? AND pack = ?");
const dropOneItemStmt = db.prepare("DELETE FROM item_images WHERE owner = ? AND pack = ? AND item = ?");
const autoItemStmt = db.prepare("SELECT hash FROM auto_items WHERE name = ? AND checker != ''");
const autoInfoStmt = db.prepare("SELECT hash, checker, updated_at FROM auto_items WHERE name = ?");
const putAutoItemStmt = db.prepare(
  "INSERT INTO auto_items (name, hash, checker, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, checker = excluded.checker, updated_at = excluded.updated_at",
);
const dropAutoItemStmt = db.prepare("DELETE FROM auto_items WHERE name = ?");
const autoMissStmt = db.prepare("SELECT updated_at FROM auto_misses WHERE name = ?");
const putAutoMissStmt = db.prepare(
  "INSERT INTO auto_misses (name, updated_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at",
);
const dropAutoMissStmt = db.prepare("DELETE FROM auto_misses WHERE name = ?");
const itemStmt = db.prepare("SELECT pack, item, hash FROM item_images WHERE owner = ?");
const pruneImagesStmt = db.prepare(
  "DELETE FROM images WHERE created_at < ? AND hash NOT IN (SELECT hash FROM pack_covers) " +
    "AND hash NOT IN (SELECT hash FROM item_images) AND hash NOT IN (SELECT hash FROM auto_items) RETURNING hash",
);

/** @param {StoredImage} image */
export function saveImage(image: StoredImage) {
  insertImage.run(
    image.hash,
    image.source,
    image.mime,
    image.width,
    image.height,
    image.author ?? "",
    image.license ?? "",
    image.page ?? "",
    Date.now(),
  );
}

/** @param {string} hash */
export function imageByHash(hash: string): StoredImage | null {
  return (getImage.get(hash) as StoredImage | null) ?? null;
}

/** @param {string[]} hashes */
export function imagesByHashes(hashes: string[]): StoredImage[] {
  if (hashes.length === 0) return [];
  return getImages.all(JSON.stringify(hashes)) as StoredImage[];
}

/** @param {string} owner @param {string} pack @param {string} item @param {string} hash */
export function setItemImage(owner: string, pack: string, item: string, hash: string) {
  setItemStmt.run(owner, pack, item, hash, Date.now());
}

/** @param {string} owner @param {string} pack */
export function clearItemImages(owner: string, pack: string) {
  dropItemStmt.run(owner, pack);
}

/** @param {string} owner @param {string} pack @param {string} item */
export function clearItemImage(owner: string, pack: string, item: string) {
  dropOneItemStmt.run(owner, pack, item);
}

/** @param {string} owner @returns {Record<string, Record<string, string>>} */
export function itemImages(owner: string): Record<string, Record<string, string>> {
  if (!owner) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const row of itemStmt.all(owner) as { pack: string; item: string; hash: string }[]) {
    (out[row.pack] ??= {})[row.item] = row.hash;
  }
  return out;
}

/** @param {string} owner @param {string} pack @param {string} hash */
export function setPackCover(owner: string, pack: string, hash: string) {
  setCoverStmt.run(owner, pack, hash, Date.now());
}

/** @param {string} owner @param {string} pack */
export function clearPackCover(owner: string, pack: string) {
  dropCoverStmt.run(owner, pack);
}

/** @param {string} owner @returns {Record<string, string>} */
export function packCovers(owner: string): Record<string, string> {
  if (!owner) return {};
  const out: Record<string, string> = {};
  for (const row of coversStmt.all(owner) as { pack: string; hash: string }[]) out[row.pack] = row.hash;
  return out;
}

/* ── автоматические картинки предметов: общий кеш по названию ── */

/** @param {string} name @returns {string | null} */
export function autoImage(name: string): string | null {
  const row = autoItemStmt.get(name) as { hash: string } | null;
  return row?.hash ?? null;
}

/** @param {string} name */
export function autoImageInfo(name: string): { hash: string; checker: string; updated_at: number } | null {
  return (autoInfoStmt.get(name) as { hash: string; checker: string; updated_at: number } | null) ?? null;
}

/** @param {string} name @param {string} hash @param {string} checker */
export function saveAutoImage(name: string, hash: string, checker: string) {
  putAutoItemStmt.run(name, hash, checker, Date.now());
  dropAutoMissStmt.run(name);
}

/** @param {string} name */
export function dropAutoImage(name: string) {
  dropAutoItemStmt.run(name);
}

/** @param {string} name @param {number} ttl */
export function autoMissed(name: string, ttl: number): boolean {
  const row = autoMissStmt.get(name) as { updated_at: number } | null;
  return Boolean(row && Date.now() - row.updated_at < ttl);
}

/** @param {string} name */
export function saveAutoMiss(name: string) {
  putAutoMissStmt.run(name, Date.now());
}

/** Удаляет картинки, на которые больше никто не ссылается. @returns {string[]} */
export function pruneImages(olderThan: number): string[] {
  const rows = pruneImagesStmt.all(olderThan) as { hash: string }[];
  return rows.map((row) => row.hash);
}

export function clearAutoMisses() {
  db.query("DELETE FROM auto_misses").run();
}

/** @param {number} olderThan */
export function pruneAutoMisses(olderThan: number) {
  db.query("DELETE FROM auto_misses WHERE updated_at < ?").run(olderThan);
}

/** @param {string} sid @param {string | null} room @param {number | null} seat */
export function rememberSession(sid: string, room: string | null, seat: number | null) {
  sessionRows.set(sid, { sessionId: sid, room, seat });
}

/** @param {any} room @param {any} review */
export function recordGame(room: any, review: any) {
  const payload: any = {
    room: room.code,
    mode: room.mode,
    pack: room.packId,
    judge: room.judgeMode,
    profile: review?.profile ?? null,
    players: room.players.map((player: any) => ({
      name: player.name,
      budget: player.budget,
      picks: player.picks.map((pick: any) => ({
        name: pick.name,
        price: pick.price,
        auto: pick.auto,
        rating: pick.aiRating ?? null,
      })),
    })),
    winner: room.winner ?? null,
    review: review ?? null,
    history: room.history,
  };
  const pids = Array.isArray(room.pids) ? room.pids.filter(Boolean) : [];
  payload.pids = pids;
  insertGame.run(
    room.code,
    room.packId,
    review?.profile ?? "party",
    room.judgeMode,
    JSON.stringify(payload),
    pids.length ? JSON.stringify(pids) : null,
    Date.now(),
  );
}

export type PlayerGame = {
  code: string;
  pack: string;
  profile: string;
  createdAt: number;
  result: "win" | "loss" | "tie";
  score: number | null;
  rivalScore: number | null;
  picks: number;
  rivalName: string;
};

export type PlayerStats = {
  played: number;
  wins: number;
  ties: number;
  losses: number;
  best: number | null;
  favouritePack: string | null;
  games: PlayerGame[];
};

/** История конкретного игрока: игры, где встречается его постоянный id. */
export function historyFor(pid: string, limit = 12): PlayerStats {
  const rows = db
    .query("SELECT code, pack, profile, payload, created_at FROM games WHERE pids LIKE ? ORDER BY created_at DESC LIMIT 200")
    .all(`%${pid}%`) as { code: string; pack: string; profile: string; payload: string; created_at: number }[];

  const games: PlayerGame[] = [];
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let best: number | null = null;
  const packCount = new Map<string, number>();

  for (const row of rows) {
    let data: any;
    try {
      data = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const pids: string[] = Array.isArray(data.pids) ? data.pids : [];
    const seat = pids.indexOf(pid);
    if (seat < 0 || !data.players?.[seat]) continue;
    const rivalSeat = 1 - seat;
    const review = data.review;
    const score = review?.scores?.[seat] ?? null;
    const rivalScore = review?.scores?.[rivalSeat] ?? null;
    let result: "win" | "loss" | "tie" = "tie";
    if (typeof data.winner === "number") result = data.winner === seat ? "win" : "loss";
    if (result === "win") wins += 1;
    else if (result === "loss") losses += 1;
    else ties += 1;
    if (score !== null) best = best === null ? score : Math.max(best, score);
    packCount.set(row.pack, (packCount.get(row.pack) ?? 0) + 1);
    games.push({
      code: row.code,
      pack: row.pack,
      profile: row.profile,
      createdAt: row.created_at,
      result,
      score,
      rivalScore,
      picks: data.players?.[seat]?.picks?.length ?? 0,
      rivalName: data.players?.[rivalSeat]?.name ?? "",
    });
  }

  const favouritePack = [...packCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { played: games.length, wins, ties, losses, best, favouritePack, games: games.slice(0, limit) };
}

export function dbStats() {
  const counts = db
    .query("SELECT (SELECT COUNT(*) FROM rooms) AS rooms, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM games) AS games")
    .get() as { rooms: number; sessions: number; games: number };
  return counts;
}

export type GameSummary = {
  code: string;
  pack: string;
  profile: string;
  judge: string;
  createdAt: number;
  winner: string | null;
  winnerScore: number | null;
  rivalScore: number | null;
};

export function lastGames(limit = 10): GameSummary[] {
  const rows = db
    .query("SELECT code, pack, profile, judge, payload, created_at FROM games ORDER BY created_at DESC LIMIT ?")
    .all(limit) as { code: string; pack: string; profile: string; judge: string; payload: string; created_at: number }[];
  return rows.map((row) => {
    let winner: string | null = null;
    let winnerScore: number | null = null;
    let rivalScore: number | null = null;
    try {
      const data = JSON.parse(row.payload);
      const index = typeof data.winner === "number" ? data.winner : null;
      const review = data.review;
      if (index !== null && review?.players?.[index]) {
        winner = review.players[index].picks ? data.players?.[index]?.name ?? null : null;
        winnerScore = review.scores?.[index] ?? null;
        rivalScore = review.scores?.[1 - index] ?? null;
      }
    } catch {
      /* старая запись без счёта */
    }
    return {
      code: row.code,
      pack: row.pack,
      profile: row.profile,
      judge: row.judge,
      createdAt: row.created_at,
      winner,
      winnerScore,
      rivalScore,
    };
  });
}

process.on("exit", flush);
process.on("SIGINT", () => {
  flush();
  process.exit(0);
});
process.on("SIGTERM", () => {
  flush();
  process.exit(0);
});
