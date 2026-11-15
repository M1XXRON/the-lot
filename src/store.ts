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
`);

// Миграция для баз, созданных до появления истории игрока.
try {
  const columns = db.query("PRAGMA table_info(games)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "pids")) db.exec("ALTER TABLE games ADD COLUMN pids TEXT");
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
