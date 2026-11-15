// Симуляция экономики: боты играют напрямую в движок, без HTTP.
// Проверяет, что партия всегда завершается и монеты не «залипают».
import * as engine from "../src/engine.js";

const STRATEGIES = {
  dollar: () => 1,
  careful: (lot, seat, budget, picks) => (picks < 3 ? 4 : 2),
  aggressive: (lot, seat, budget) => Math.min(5, budget),
  hoarder: (lot, seat, budget, picks) => (picks >= 4 ? 5 : 1),
  random: (lot, seat, budget) => 1 + Math.floor(Math.random() * Math.min(5, budget)),
  never: () => 0,
};

function playGame(strategyA, strategyB) {
  const room = engine.createRoom({ code: "SIM", mode: "local", sessionId: "S", name: "A" });
  engine.fillLocalSeat(room);
  engine.tossCoin(room);
  engine.beginDraft(room);

  let actions = 0;
  let skips = 0;
  while (room.phase === "auction" && actions < 400) {
    const seat = room.auction.turn;
    const player = room.players[seat];
    const strategy = seat === 0 ? strategyA : strategyB;
    const target = strategy(room.lots[room.lotIndex], seat, player.budget, player.picks.length);
    const price = room.auction.highBidder === null ? room.auction.opening : room.auction.currentBid + 1;
    if (price <= target && player.budget >= price && player.picks.length < 5) engine.bid(room, seat);
    else {
      const before = room.history.length;
      engine.pass(room, seat);
      if (room.history.length > before && room.history.at(-1)?.skipped) skips += 1;
    }
    actions += 1;
  }

  const picks = room.players.map((p) => p.picks.length);
  const spent = room.players.map((p) => p.spent = p.picks.reduce((s, x) => s + x.price, 0));
  const budget = room.players.map((p) => p.budget);
  const invariant = room.players.every((p, i) => p.picks.length === 5 && p.budget >= 0 && p.budget + spent[i] === 20);
  return { actions, skips, picks, spent, budget, invariant, phase: room.phase };
}

const names = Object.keys(STRATEGIES);
const perPair = 120;
const rows = [];
let broken = 0;
let maxActions = 0;

for (const a of names) {
  for (const b of names) {
    let spend = 0;
    let skips = 0;
    let actions = 0;
    for (let i = 0; i < perPair; i += 1) {
      const result = playGame(STRATEGIES[a], STRATEGIES[b]);
      if (!result.invariant) broken += 1;
      spend += result.spent[0] + result.spent[1];
      skips += result.skips;
      actions += result.actions;
      maxActions = Math.max(maxActions, result.actions);
    }
    rows.push({ pair: `${a} × ${b}`, avgSpend: (spend / perPair).toFixed(1), avgSkips: (skips / perPair).toFixed(1), avgActions: (actions / perPair).toFixed(1) });
  }
}

console.log("pair".padEnd(24), "spend".padStart(7), "skips".padStart(7), "actions".padStart(8));
for (const row of rows) {
  console.log(row.pair.padEnd(24), row.avgSpend.padStart(7), row.avgSkips.padStart(7), row.avgActions.padStart(8));
}
// отдельная проверка: если оба пасуют всегда, партия всё равно даёт 5 пиков каждому
let passOnly = 0;
for (let i = 0; i < 40; i += 1) {
  const result = playGame(STRATEGIES.never, STRATEGIES.never);
  if (!result.invariant) passOnly += 1;
}
console.log(`\nигр: ${rows.length * perPair}, нарушений экономики: ${broken}, максимум действий в партии: ${maxActions}`);
console.log(`проверка «все пасуют»: нарушений ${passOnly} из 40`);
if (passOnly) process.exit(1);
if (broken) process.exit(1);
