// Нормы оценивания: единые шкалы для судьи, промптов и интерфейса.
export type NormProfile = "party" | "character-power" | "athlete-performance";

export type Band = {
  from: number;
  to: number;
  /** Ключ в словаре i18n для названия полосы. */
  key: string;
};

export const BANDS: Band[] = [
  { from: 1, to: 2, key: "band.1" },
  { from: 3, to: 4, key: "band.2" },
  { from: 5, to: 6, key: "band.3" },
  { from: 7, to: 8, key: "band.4" },
  { from: 9, to: 10, key: "band.5" },
];

/** Правила, общие для всех режимов: борьба с инфляцией и «средней шестёркой». */
export const COMMON_RULES = ["rule.average", "rule.spread", "rule.unknown", "rule.price"];

/** Нормы TMDb: взвешивание по числу голосов, чтобы 30 оценок не били 20 000. */
export const TMDB = {
  minVotes: 20,
  priorMean: 7.0,
  priorVotes: 500,
};

/** Байесовское среднее: тянем редкие оценки к среднему по базе. */
export function weightedRating(rating: number, votes: number): number {
  const safeVotes = Math.max(0, Number(votes) || 0);
  const raw = Number.isFinite(rating) ? rating : TMDB.priorMean;
  const value = (safeVotes * raw + TMDB.priorVotes * TMDB.priorMean) / (safeVotes + TMDB.priorVotes);
  return Math.round(value * 10) / 10;
}

export function bandFor(profile: NormProfile, rating: number | null): Band | null {
  if (rating === null || !Number.isFinite(rating)) return null;
  if (profile === "party") return BANDS.find((band) => rating >= band.from && rating <= band.to) ?? null;
  return BANDS.find((band) => rating >= band.from && rating <= band.to) ?? null;
}

/** Текст норм для системного промпта: модель должна играть по тем же правилам. */
export function normsPrompt(profile: NormProfile, lang: "ru" | "en"): string {
  const bands =
    lang === "ru"
      ? {
          party: [
            "1–2 — мимо: не в тему, неинтересно, стол бы не заметил",
            "3–4 — ниже нормы: спорно или скучно",
            "5–6 — норма: уместно, но без характера",
            "7–8 — сильно: в тему и с характером, за это спорят",
            "9–10 — выдающееся: лучшее в паке, задаёт разговор",
          ],
          power: [
            "1–2 — обычный человек без боевой подготовки",
            "3–4 — уличный уровень: тренированный боец, лёгкое снаряжение",
            "5–6 — городской/командный: огнестрел, малые разрушения",
            "7–8 — континентальный/армейский: массовые разрушения",
            "9–10 — планетарный и выше: канонично меняет мир",
          ],
          sports: [
            "1–2 — любительский уровень",
            "3–4 — резерв или лига ниже топовой",
            "5–6 — крепкий профессионал топ-лиги",
            "7–8 — звезда с регулярными наградами",
            "9–10 — историческая доминация, рекорды эпохи",
          ],
        }
      : {
          party: [
            "1–2 — miss: off-pack, dull, the table would not notice",
            "3–4 — below par: debatable or boring",
            "5–6 — par: fits, but no character",
            "7–8 — strong: fits and has character, worth an argument",
            "9–10 — standout: best in the pack, drives the conversation",
          ],
          power: [
            "1–2 — ordinary human, no combat training",
            "3–4 — street level: trained fighter, light gear",
            "5–6 — city/team level: firearms, small-scale destruction",
            "7–8 — continental/army level: mass destruction",
            "9–10 — planetary and above: canonically changes the world",
          ],
          sports: [
            "1–2 — amateur level",
            "3–4 — reserve or a league below the top",
            "5–6 — solid top-league professional",
            "7–8 — star with regular honours",
            "9–10 — era-defining dominance and records",
          ],
        };
  const rules =
    lang === "ru"
      ? [
          "Средняя оценка драфта ≈ 6. Не завышай всех подряд.",
          "Используй весь диапазон: 10 — не больше одного предмета на драфт, если нет равных.",
          "Нет надёжных данных — ровно 5 и явная пометка.",
          "Цена и ставки не влияют на балл.",
        ]
      : [
          "Draft average should land near 6. Do not inflate everything.",
          "Use the whole range: at most one 10 per draft unless two items are genuinely equal.",
          "No reliable data means exactly 5 with an explicit note.",
          "Price and bids never affect the score.",
        ];
  const table = profile === "character-power" ? bands.power : profile === "athlete-performance" ? bands.sports : bands.party;
  return [...table.map((line) => `- ${line}`), "", ...rules.map((line) => `- ${line}`)].join("\n");
}
