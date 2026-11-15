// Игровое ядро: комнаты, фазы, торги, экономика. Без HTTP и без рендера.
import { BUDGET, PICKS, JUDGE_LABEL, packOrFallback, packs, profileFor, tabs } from "./content.js";

/** @typedef {0|1} Seat */

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** @param {number} length */
export function roomCode(length = 4) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return out;
}

const DESCRIPTIONS = [
  "A classic with a little extra fizz.",
  "Bold pick. Somebody will argue.",
  "The safe choice — or the boring one?",
  "Cheap, loud, and hard to ignore.",
  "A late-round steal if it lands.",
  "This one splits the table.",
  "Quietly the best thing in the pack.",
  "Every house needs one of these.",
];

/** @param {string} name */
function describe(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return DESCRIPTIONS[hash % DESCRIPTIONS.length];
}

/** @param {string[]} list */
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * @param {{ code: string, mode: "local"|"online", sessionId: string, name: string }} options
 */
export function createRoom({ code, mode, sessionId, name }) {
  const now = Date.now();
  return {
    code,
    mode,
    createdAt: now,
    updatedAt: now,
    version: 0,
    hostSession: sessionId,
    seats: [{ sessionId, name: cleanName(name), connected: true, joinedAt: now }],
    packId: packOrFallback("free-soda").id,
    customPack: /** @type {null | {id:string,name:string,emoji:string,tab:string,count:number,items:string[],profile:"party"}} */ (null),
    tab: "ALL",
    judgeMode: /** @type {"auto"|"human"} */ ("auto"),
    phase: /** @type {"lobby"|"toss"|"auction"|"judging"|"results"} */ ("lobby"),
    toss: { flipped: false, first: /** @type {Seat|null} */ (null) },
    players: [newPlayer(name), newPlayer("PLAYER 2")],
    lots: /** @type {{name:string, emoji:string, description:string}[]} */ ([]),
    skippedLots: /** @type {any[]} */ ([]),
    lotIndex: 0,
    auction: newAuction(),
    history: /** @type {any[]} */ ([]),
    review: /** @type {any|null} */ (null),
    reviewError: /** @type {string|null} */ (null),
    judging: false,
    judgeToken: 0,
    manualVote: /** @type {Seat|"draw"|null} */ (null),
    winner: /** @type {Seat|null|undefined} */ (undefined),
    playedGames: 0,
  };
}

/** @param {string} name */
function cleanName(name) {
  const trimmed = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 16);
  return trimmed || "PLAYER";
}

/** @param {string} name */
function newPlayer(name) {
  return { name: cleanName(name), budget: BUDGET, picks: /** @type {any[]} */ ([]) };
}

function newAuction() {
  return {
    number: 0,
    turn: /** @type {Seat} */ (0),
    opening: 1,
    highBidder: /** @type {Seat|null} */ (null),
    currentBid: 0,
    step: 1,
    passes: 0,
    bids: /** @type {{seat:Seat, amount:number}[]} */ ([]),
    passesBy: /** @type {Seat[]} */ ([]),
  };
}

/** @param {any} room @param {string} sessionId */
export function seatOf(room, sessionId) {
  const index = room.seats.findIndex((/** @type {any} */ seat) => seat.sessionId === sessionId);
  return index >= 0 ? /** @type {Seat} */ (index) : -1;
}

/** @param {any} room @param {string} sessionId */
export function isHost(room, sessionId) {
  return room.hostSession === sessionId;
}

/**
 * Хост в локальном режиме управляет обоими местами, в онлайне — только своим.
 * @param {any} room @param {string} sessionId @param {Seat} seat
 */
export function controlsSeat(room, sessionId, seat) {
  if (room.mode === "local") return isHost(room, sessionId);
  return room.seats[seat]?.sessionId === sessionId;
}

/** @param {any} room @param {string} sessionId @param {string} name */
export function join(room, sessionId, name) {
  const existing = seatOf(room, sessionId);
  if (existing >= 0) return existing;
  if (room.mode === "local") return null;
  if (room.phase !== "lobby") return "closed";
  if (room.seats.length >= 2) return "full";
  room.seats.push({ sessionId, name: cleanName(name), connected: true, joinedAt: Date.now() });
  room.players[room.seats.length - 1].name = cleanName(name);
  bump(room);
  return /** @type {Seat} */ (room.seats.length - 1);
}

/** Второй игрок на этом же устройстве: место принадлежит хосту. */
export function fillLocalSeat(room) {
  if (room.mode !== "local" || room.seats.length >= 2) return;
  room.seats.push({ sessionId: room.hostSession, name: "PLAYER 2", connected: true, joinedAt: Date.now() });
  room.players[1].name = "PLAYER 2";
  bump(room);
}

/** @param {any} room */
export function bump(room) {
  room.version += 1;
  room.updatedAt = Date.now();
}

/** Загруженный пак живёт в комнате, а не в общем каталоге. */
export function setCustomPack(room, pack) {
  room.customPack = pack;
  room.packId = pack.id;
  bump(room);
}

/** @param {any} room */
export function clearCustomPack(room) {
  room.customPack = null;
  room.packId = packOrFallback("free-soda").id;
  bump(room);
}

/** @param {any} room @param {string} packId */
export function setPack(room, packId) {
  const pack = packOrFallback(packId);
  room.packId = pack.id;
  bump(room);
}

/** @param {any} room @param {"auto"|"human"} mode */
export function setJudge(room, mode) {
  room.judgeMode = mode === "human" ? "human" : "auto";
  bump(room);
}

/** @param {any} room @param {string} tab */
export function setTab(room, tab) {
  room.tab = tab;
  bump(room);
}

/** @param {any} room @param {Seat} seat @param {string} name */
export function rename(room, seat, name) {
  const clean = cleanName(name);
  room.seats[seat].name = clean;
  room.players[seat].name = clean;
  bump(room);
}

/** @param {any} room */
export function tossCoin(room) {
  if (room.phase !== "lobby" || room.seats.length < 2) return "waiting";
  room.toss = { flipped: true, first: Math.random() < 0.5 ? 0 : 1 };
  room.phase = "toss";
  bump(room);
  return "ok";
}

/** @param {any} room */
export function beginDraft(room) {
  if (room.phase !== "toss") return "wrong-phase";
  const pack = room.customPack ?? packOrFallback(room.packId);
  room.lots = shuffle(pack.items).map((name) => ({ name, emoji: pack.emoji, description: describe(name) }));
  room.skippedLots = [];
  room.players = [newPlayer(room.players[0].name), newPlayer(room.players[1].name)];
  room.history = [];
  room.review = null;
  room.reviewError = null;
  room.manualVote = null;
  room.winner = undefined;
  room.judging = false;
  room.lotIndex = 0;
  room.auction = newAuction();
  room.phase = "auction";
  startAuction(room);
  bump(room);
  return "ok";
}

/** @param {any} room */
function startAuction(room) {
  const first = room.toss.first ?? 0;
  const au = room.auction;
  au.number = room.history.length + 1;
  au.turn = /** @type {Seat} */ ((first + room.history.length) % 2);
  if (room.players[au.turn].picks.length >= PICKS) au.turn = /** @type {Seat} */ (1 - au.turn);
  au.opening = 1;
  au.highBidder = null;
  au.currentBid = 0;
  au.step = 1;
  au.passes = 0;
  au.bids = [];
  au.passesBy = [];
}

/** @param {any} room @param {Seat} seat @param {number} delta */
export function adjustOpening(room, seat, delta) {
  const au = room.auction;
  if (room.phase !== "auction" || au.highBidder !== null || au.turn !== seat) return "wrong-turn";
  const cap = Math.min(5, room.players[seat].budget);
  au.opening = Math.max(1, Math.min(cap, au.opening + delta));
  bump(room);
  return "ok";
}

/** @param {any} room @param {Seat} seat */
export function currentBidFor(room, seat) {
  const au = room.auction;
  return au.highBidder === null ? au.opening : au.currentBid + (au.step || 1);
}

/** @param {any} room @param {number} step */
export function setStep(room, step) {
  if (room.phase !== "auction") return "wrong-phase";
  const value = Math.max(1, Math.min(5, Math.trunc(Number(step) || 1)));
  room.auction.step = value;
  bump(room);
  return "ok";
}

/** @param {any} room @param {Seat} seat */
export function bid(room, seat) {
  if (room.phase !== "auction" || room.auction.turn !== seat) return "wrong-turn";
  const player = room.players[seat];
  const au = room.auction;
  if (player.picks.length >= PICKS) return "full";
  const amount = currentBidFor(room, seat);
  if (player.budget < amount) return "no-money";
  if (au.highBidder !== null) room.players[au.highBidder].budget += au.currentBid;
  player.budget -= amount;
  au.bids.push({ seat, amount });
  au.highBidder = seat;
  au.currentBid = amount;
  au.turn = /** @type {Seat} */ (1 - seat);
  au.passes = 0;
  bump(room);
  return "ok";
}

/** @param {any} room @param {Seat} seat */
export function pass(room, seat) {
  if (room.phase !== "auction" || room.auction.turn !== seat) return "wrong-turn";
  const au = room.auction;
  au.passesBy.push(seat);
  if (au.highBidder !== null) {
    award(room, au.highBidder, au.currentBid);
    return "awarded";
  }
  au.passes += 1;
  if (au.passes >= 2) {
    skipLot(room);
    return "skipped";
  }
  au.turn = /** @type {Seat} */ (1 - seat);
  bump(room);
  return "passed";
}

/** @param {any} room @param {Seat} seat @param {number} price */
function award(room, seat, price) {
  const lot = room.lots[room.lotIndex];
  const au = room.auction;
  room.players[seat].picks.push({ ...lot, price, auto: false });
  room.history.push({
    round: room.history.length + 1,
    lot,
    bids: [...au.bids],
    passes: [...au.passesBy],
    winner: seat,
    price,
    auto: false,
    skipped: false,
  });
  advance(room);
}

/** @param {any} room */
function skipLot(room) {
  const lot = room.lots[room.lotIndex];
  const au = room.auction;
  room.skippedLots.push(lot);
  room.history.push({
    round: room.history.length + 1,
    lot,
    bids: [...au.bids],
    passes: [...au.passesBy],
    winner: null,
    price: null,
    auto: false,
    skipped: true,
  });
  advance(room);
}

/** @param {any} room */
function advance(room) {
  room.lotIndex += 1;
  // если одному игроку уже нечего добирать — второму отдаём оставшиеся лоты бесплатно
  while (room.lotIndex < room.lots.length) {
    const full = room.players.map((player) => player.picks.length >= PICKS);
    if (full[0] === full[1]) break;
    const seat = /** @type {Seat} */ (full[0] ? 1 : 0);
    const lot = room.lots[room.lotIndex];
    room.players[seat].picks.push({ ...lot, price: 0, auto: true });
    room.history.push({
      round: room.history.length + 1,
      lot,
      bids: [],
      passes: [],
      winner: seat,
      price: 0,
      auto: true,
      skipped: false,
    });
    room.lotIndex += 1;
  }
  // Страховка: если лоты закончились, добираем недостающие пики из пропущенных —
  // так у обоих всегда ровно пять предметов, даже если все пасовали.
  while (
    room.players.some((player) => player.picks.length < PICKS) &&
    room.skippedLots.length > 0
  ) {
    const seat = /** @type {Seat} */ (room.players[0].picks.length <= room.players[1].picks.length ? 0 : 1);
    if (room.players[seat].picks.length >= PICKS) break;
    const lot = room.skippedLots.shift();
    room.players[seat].picks.push({ ...lot, price: 0, auto: true });
    room.history.push({
      round: room.history.length + 1,
      lot,
      bids: [],
      passes: [],
      winner: seat,
      price: 0,
      auto: true,
      skipped: false,
    });
  }

  const done = room.players.every((player) => player.picks.length >= PICKS) || room.lotIndex >= room.lots.length;
  if (done) {
    room.phase = room.judgeMode === "human" ? "results" : "judging";
    room.auction = newAuction();
  } else {
    startAuction(room);
  }
  bump(room);
}

/** @param {any} room @param {any} review */
export function applyReview(room, review) {
  room.review = review;
  room.reviewError = null;
  room.judging = false;
  room.players.forEach((player, seat) => {
    player.picks.forEach((pick, index) => {
      const entry = review.players?.[seat]?.picks?.[index];
      pick.aiRating = entry?.rating ?? null;
      pick.aiBasis = entry?.basis ?? "";
      pick.aiReason = entry?.reason ?? "";
    });
  });
  room.winner = review.winner;
  room.phase = "results";
  bump(room);
}

/** @param {any} room @param {string} message */
export function failReview(room, message) {
  room.reviewError = message;
  room.judging = false;
  room.winner = undefined;
  room.phase = "results";
  bump(room);
}

/** @param {any} room @param {Seat|"draw"} vote */
export function vote(room, vote) {
  room.manualVote = vote;
  room.winner = vote === "draw" ? null : vote;
  bump(room);
}

/** @param {any} room */
export function again(room) {
  room.phase = "lobby";
  room.toss = { flipped: false, first: null };
  room.players = [newPlayer(room.players[0].name), newPlayer(room.players[1].name)];
  room.history = [];
  room.review = null;
  room.reviewError = null;
  room.manualVote = null;
  room.winner = undefined;
  room.judging = false;
  room.lots = [];
  room.skippedLots = [];
  room.lotIndex = 0;
  room.auction = newAuction();
  room.playedGames += 1;
  bump(room);
}

/** @param {any} room */
export function totals(room) {
  return room.players.map((player) => player.picks.reduce((sum, pick) => sum + (pick.aiRating ?? 0), 0));
}

/** @param {any} room @param {string|null} sessionId @param {string} origin */
export function view(room, sessionId, origin) {
  const pack = room.customPack ?? packOrFallback(room.packId);
  const seat = sessionId ? seatOf(room, sessionId) : -1;
  const au = room.auction;
  const lot = room.lots[room.lotIndex] ?? null;
  const profile = pack.profile;
  const isInternet = profile === "internet-ratings";
  const reviewWinner = room.review ? (room.review.winner ?? null) : null;

  return {
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    version: room.version,
    origin,
    invite: `${origin}/r/${room.code}`,
    host: sessionId ? isHost(room, sessionId) : false,
    seat,
    spectator: seat < 0,
    seatsFilled: room.seats.length,
    seats: room.seats.map((s, i) => ({
      name: s.name,
      connected: s.connected !== false,
      isHost: s.sessionId === room.hostSession,
      isYou: sessionId ? s.sessionId === sessionId : false,
      seat: i,
    })),
    pack: { id: pack.id, name: pack.name, emoji: pack.emoji, tab: pack.tab, count: pack.count, profile },
    profile,
    judgeLabel: JUDGE_LABEL[profile],
    judgeMode: room.judgeMode,
    tabs,
    packs: packs.map((p) => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      tab: p.tab,
      count: p.count,
      profile: p.profile,
      verify: p.verify,
      inferred: p.inferred,
      search: `${p.name} ${p.tab} ${p.items.join(" ")}`.toLowerCase(),
    })),
    players: room.players.map((player, i) => {
      const picks = player.picks;
      return {
        name: player.name,
        budget: player.budget,
        picks: picks.map((pick) => ({
          name: pick.name,
          emoji: pick.emoji,
          poster: pick.poster ?? null,
          price: pick.price,
          auto: pick.auto,
          rating: pick.aiRating ?? null,
          basis: pick.aiBasis ?? "",
          reason: pick.aiReason ?? "",
        })),
        isYou: seat === i,
        connected: room.seats[i] ? room.seats[i].connected !== false : false,
        active: room.phase === "auction" && au.turn === i,
        score: picks.reduce((sum, pick) => sum + (pick.aiRating ?? 0), 0),
        spent: picks.reduce((sum, pick) => sum + pick.price, 0),
      };
    }),
    toss: room.toss,
    auction: {
      number: au.number,
      turn: au.turn,
      opening: au.opening,
      highBidder: au.highBidder,
      currentBid: au.currentBid,
      step: au.step || 1,
      bidAmount: au.highBidder === null ? au.opening : au.currentBid + (au.step || 1),
      lot: lot ? { name: lot.name, emoji: lot.emoji, description: lot.description, poster: lot.poster ?? null } : null,
      canBid:
        seat >= 0 &&
        controlsSeat(room, sessionId ?? "", au.turn) &&
        room.players[au.turn].budget >= (au.highBidder === null ? au.opening : au.currentBid + (au.step || 1)),
      canAct: seat >= 0 && (room.mode === "local" ? isHost(room, sessionId ?? "") : room.seats[au.turn]?.sessionId === sessionId),
      minOpening: 1,
      maxOpening: Math.min(5, room.players[au.turn]?.budget ?? 1),
      rounds: room.history.length,
    },
    history: room.history,
    review: room.review,
    reviewError: room.reviewError,
    judging: room.judging,
    manualVote: room.manualVote,
    winner: room.review ? reviewWinner : room.manualVote === "draw" ? null : typeof room.manualVote === "number" ? room.manualVote : room.winner === null || typeof room.winner === "number" ? room.winner : undefined,
    isInternet,
    totals: totals(room),
    canHostAct: sessionId ? isHost(room, sessionId) : false,
  };
}
