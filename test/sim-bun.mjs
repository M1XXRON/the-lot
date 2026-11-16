// Боты по HTTP: N партий подряд, проверка инвариантов и скорости.
// Запуск: bun test/sim-bun.mjs   (BOTS=1 — онлайн-пара, BOTS=2 — локально)
import { assert, client, roomCodeFrom, startServer } from "../tools/lib.mjs";

const GAMES = Number(process.env.GAMES ?? 6);
const server = await startServer({ mock: true });

function pickStrategy(kind) {
  if (kind === "dollar") return () => 1;
  if (kind === "careful") return (picks) => (picks < 3 ? 4 : 2);
  return (budget) => Math.min(5, budget);
}

const STRATEGIES = [pickStrategy("careful"), pickStrategy("immortal" in process.env ? "dollar" : "dollar")];

async function playGame(index) {
  const host = client(server.base);
  const guest = client(server.base);
  const created = await host.form("/act/create", { mode: "online", name: "BOT-A" });
  const { code } = roomCodeFrom(created);
  const joined = await guest.form("/act/join", { code, name: "BOT-B" });
  assert(joined.status === 303, "бот не сел за стол");

  const pack = ["free-soda", "free-candy", "free-fast-food", "free-apps"][index % 4];
  let response = await host.actJson("pack", { pack });
  assert(response.status === 204, "пак не выбран");
  response = await host.act("toss");
  assert(response.status === 204, "монета не брошена");
  response = await host.act("begin");
  assert(response.status === 204, "драфт не начат");

  let actions = 0;
  for (let i = 0; i < 160; i += 1) {
    const page = await host.html(`/r/${code}`);
    if (page.html.includes('data-phase="results"')) break;
    const seatOne = /player-card--one[^"]*is-active/.test(page.html);
    const seatTwo = /player-card--two[^"]*is-active/.test(page.html);
    assert(seatOne || seatTwo, "нет активного игрока");
    const actor = seatOne ? host : guest;
    const strategy = STRATEGIES[seatOne ? 0 : 1];
    const budget = Number((page.html.match(/player-money">\$(\d+)/g) ?? [])
      .map((m) => Number(m.replace(/\D+/g, "")))[seatOne ? 0 : 1] ?? 20);
    const picks = (page.html.match(/draft-slot is-filled/g) ?? []).length;
    const target = strategy(budget, picks);
    const bidDisabled = /id="bid-button"[^>]*disabled/.test(page.html);
    const bidAmount = Number((page.html.match(/(?:BID|СТАВКА)\s*\$(\d+)/) ?? [])[1] ?? 99);
    const shouldBid = !bidDisabled && bidAmount <= target;
    const action = await (shouldBid ? actor.act("bid") : actor.act("pass"));
    assert(action.status === 204, `действие бота вернуло ${action.status}`);
    actions += 1;
  }

  const results = await host.html(`/r/${code}`);
  assert(results.html.includes('data-phase="results"'), "партия не завершилась");
  const rated = (results.html.match(/result-pick-rating/g) ?? []).length;
  assert(rated >= 10, `оценок меньше десяти: ${rated}`);
  const total = Number((results.html.match(/<strong>(\d+)\/10<\/strong>/) ?? [])[1] ?? 0);
  assert(total === 10, `пиков не десять: ${total}`);
  const winner = /WINS!/.test(results.html) ? "win" : "tie";
  return { code, actions, rated, winner };
}

const started = Date.now();
const games = [];
for (let i = 0; i < GAMES; i += 1) {
  games.push(await playGame(i));
}

const totalActions = games.reduce((sum, game) => sum + game.actions, 0);
console.log(`  партий: ${games.length}, действий: ${totalActions}, ${((Date.now() - started) / games.length).toFixed(0)} мс на партию`);
for (const game of games) console.log(`  · ${game.code}: ${game.actions} действий, ${game.rated} оценок, ${game.winner}`);

const health = await (await fetch(`${server.base}/health`)).json();
console.log(`  health: комнат ${health.rooms}, сессий ${health.sessions}, партий в базе ${health.db.games}`);
assert(health.db.games >= GAMES, "партии не записались в базу");

await server.stop();
console.log("sim-bun: ок");
