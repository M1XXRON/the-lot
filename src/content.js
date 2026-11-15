// Контент: паки «The Lot» и профили судейства. Читается один раз на старте.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// В скомпилированном бинарнике import.meta.url указывает внутрь бандла,
// поэтому контент читаем от рабочего каталога приложения.
const root = process.env.LOT_ROOT ?? process.cwd();

/** @typedef {"party"|"character-power"|"athlete-performance"|"internet-ratings"} JudgeProfile */

/** @typedef {{
 *   id: string, name: string, emoji: string, tab: string, count: number,
 *   items: string[], profile: JudgeProfile, verify: boolean, inferred: boolean
 * }} Pack */

const library = JSON.parse(readFileSync(resolve(root, "packs.json"), "utf8"));
const profiles = JSON.parse(readFileSync(resolve(root, "judge-profiles.json"), "utf8"));

const powerIds = new Set(profiles.characterPower ?? []);
const athleteIds = new Set(profiles.athleteRatings ?? []);
/** @type {Map<string, "movie"|"tv">} */
const internetIds = new Map(Object.entries(profiles.internetRatings ?? {}));

/** @param {string} id @returns {JudgeProfile} */
export function profileFor(id) {
  if (internetIds.has(id)) return "internet-ratings";
  if (powerIds.has(id)) return "character-power";
  if (athleteIds.has(id)) return "athlete-performance";
  return "party";
}

/** @param {string} id */
export function mediaTypeFor(id) {
  return internetIds.get(id) ?? null;
}

/** @type {Pack[]} */
export const packs = (library.packs ?? [])
  .filter(
    (pack) =>
      pack &&
      typeof pack.id === "string" &&
      typeof pack.name === "string" &&
      Array.isArray(pack.items) &&
      pack.items.length > 0,
  )
  .map((pack) => ({
    id: pack.id,
    name: pack.name,
    emoji: typeof pack.emoji === "string" ? pack.emoji : "◆",
    tab: typeof pack.tab === "string" ? pack.tab : "FREE",
    count: pack.items.length,
    items: pack.items.filter((item) => typeof item === "string"),
    profile: profileFor(pack.id),
    verify: pack.verify === true,
    inferred: pack.inferred === true,
  }));

/** @type {Map<string, Pack>} */
export const packById = new Map(packs.map((pack) => [pack.id, pack]));

/** @type {{id:string, packCount:number}[]} */
export const tabs = (library.tabs ?? [])
  .filter((tab) => tab && typeof tab.id === "string")
  .map((tab) => ({ id: tab.id, packCount: Number(tab.packCount) || 0 }))
  .filter((tab) => tab.id === "ALL" || packs.some((pack) => pack.tab === tab.id));

export const BUDGET = 20;
export const PICKS = 5;
export const JUDGE_LABEL = {
  party: "Luna AI",
  "character-power": "Power rating",
  "athlete-performance": "Sports rating",
  "internet-ratings": "TMDb rating",
};

/** @param {string} id */
export function packOrFallback(id) {
  return packById.get(id) ?? packs[0];
}

export const defaultPackId = packs.find((pack) => pack.id === "free-soda")?.id ?? packs[0].id;
