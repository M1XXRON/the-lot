// Проверка норм: диапазоны, взвешивание TMDb, монотонность.
import { BANDS, TMDB, weightedRating, bandFor } from "../src/norms.ts";

const fail = [];
const check = (ok, message) => { if (!ok) fail.push(message); };

// 1) полосы покрывают 1..10 без дыр
for (let rating = 1; rating <= 10; rating += 1) {
  check(bandFor("party", rating) !== null, `полоса не найдена для ${rating}`);
}
check(BANDS[0].from === 1 && BANDS.at(-1).to === 10, "диапазон полос не 1..10");

// 2) TMDb: 10.0 с 10 голосами не должно обгонять 8.0 с 20 000
const rare = weightedRating(10, 10);
const proven = weightedRating(8.0, 20000);
check(rare < proven, `редкие голоса завышены: ${rare} vs ${proven}`);

// 3) взвешивание монотонно по числу голосов при одинаковой оценке
let previous = weightedRating(9, TMDB.minVotes);
for (const votes of [100, 1000, 10000, 100000]) {
  const next = weightedRating(9, votes);
  check(next >= previous, "взвешивание не монотонно");
  previous = next;
}

// 4) оценка стремится к сырой при большом числе голосов
check(weightedRating(9, 1_000_000) > 8.99, "взвешивание не сходится к сырой оценке");

// 5) нижняя граница голосов не пропускает мусор
check(TMDB.minVotes >= 20, "слишком низкий порог голосов");

if (fail.length) {
  console.error("norms-check: " + fail.join(" | "));
  process.exit(1);
}
console.log(`norms-check: ок (полос 5, порог ${TMDB.minVotes} голосов, приор ${TMDB.priorMean})`);
