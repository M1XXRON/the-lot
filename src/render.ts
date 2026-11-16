// Состояние → HTML. Фрагменты патчатся в браузер через Datastar (SSE).
import { PICKS } from "./content.js";
import { makeT, plural, type Lang } from "./i18n.ts";
import { BANDS, TMDB, bandFor } from "./norms.ts";

type View = any;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ENTITIES[char]!);

const money = (value: number) => `$${value}`;

/** Datastar-обработчик клика: payload отправляется JSON-ом. */
function on(command: string, payload?: Record<string, string | number | boolean>) {
  if (!payload) return `data-on:click="@post('/act/${command}', {retry: 'never'})"`;
  const body = Object.entries(payload)
    .map(([key, value]) => `${key}: ${typeof value === "number" || typeof value === "boolean" ? value : `'${String(value).replace(/'/g, "\\'")}'`}`)
    .join(", ");
  return `data-on:click="@post('/act/${command}', {payload: {${body}}, retry: 'never'})"`;
}

const PROFILE_BADGE: Record<string, { key: string; className: string }> = {
  "character-power": { key: "judge.badgePower", className: "judge-profile-badge--character-power" },
  "athlete-performance": { key: "judge.badgeStats", className: "judge-profile-badge--athlete-performance" },
  "internet-ratings": { key: "judge.tmdb", className: "judge-profile-badge--internet-ratings" },
  party: { key: "", className: "" },
};

const TAB_KEYS: Record<string, string> = {
  ALL: "tab.all",
  FREE: "tab.free",
  ANIME: "tab.anime",
  SPORTS: "tab.sports",
  "MOVIES & TV": "tab.movies",
  MUSIC: "tab.music",
  HOT: "tab.hot",
  GAMING: "tab.gaming",
  "FOOD & DRINK": "tab.food",
  STYLE: "tab.style",
  INTERNET: "tab.internet",
  PARTY: "tab.party",
  MORE: "tab.more",
};

function tabLabel(t: (key: string) => string, id: string) {
  const key = TAB_KEYS[id];
  return key ? t(key) : id;
}

function units(t: (key: string) => string, lang: Lang, kind: "item" | "pack" | "pick", count: number) {
  return plural(lang, count, t(`unit.${kind}.one`), t(`unit.${kind}.few`), t(`unit.${kind}.many`));
}

const AI_KEY: Record<string, string> = {
  party: "judge.luna",
  "character-power": "judge.power",
  "athlete-performance": "judge.sports",
  "internet-ratings": "judge.tmdb",
};

const METHOD_KEY: Record<string, string> = {
  party: "method.party",
  "character-power": "method.power",
  "athlete-performance": "method.sports",
  "internet-ratings": "method.tmdb",
};

const NOTE_KEY: Record<string, string> = {
  party: "lobby.noteParty",
  "character-power": "lobby.notePower",
  "athlete-performance": "lobby.noteSports",
  "internet-ratings": "lobby.noteTmdb",
};

function ratingLabel(t: (key: string) => string, profile: string, rating: number | null) {
  if (rating === null || rating === undefined) return t("common.unrated");
  if (profile === "internet-ratings") return `TMDb ${Number(rating).toFixed(1)}`;
  return `${rating}/10`;
}

function scoreLabel(profile: string, score: number, ratedCount: number) {
  if (profile === "internet-ratings") return ratedCount ? `${(score / 5).toFixed(1)}/10` : "—";
  return `${score}/50`;
}

function hashOf(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return (words[0]?.[0] ?? "·") + (words[1]?.[0] ?? "");
}

/* Версия статики: подставляется сервером при старте, чтобы новый HTML
   никогда не смешивался со старым CSS из кеша. */
let assetVersion = "1";
export function setAssetVersion(version: string) {
  assetVersion = version;
}

/* ─────────────────────────── shell ─────────────────────────── */

function head(title: string, lang: Lang, extra = "") {
  const htmlLang = lang === "ru" ? "ru" : "en";
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f4efe4">
<meta name="description" content="The Lot — a draft house for two: five picks, twenty coins, one winner.">
<title>${esc(title)}</title>
<link rel="icon" href="/public/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<meta property="og:title" content="The Lot">
<meta property="og:description" content="A two-player draft house: five picks, twenty coins, one winner.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<link rel="stylesheet" href="/public/style.css?v=${esc(assetVersion)}">
<link rel="stylesheet" href="/public/redesign.css?v=${esc(assetVersion)}">
<link rel="stylesheet" href="/public/stages.css?v=${esc(assetVersion)}">
${extra}
</head>`;
}

function rulesDialog(t: (key: string) => string) {
  return `
<dialog class="modal-card" id="rules" aria-labelledby="rules-title">
  <form method="dialog"><button class="modal-close" aria-label="${esc(t("common.close"))}">×</button></form>
  <p class="eyebrow">${esc(t("rules.kicker"))}</p><h2 id="rules-title">${esc(t("rules.title"))}</h2>
  <ol class="rules-list">
    <li><span>01</span> ${esc(t("rules.one"))}</li>
    <li><span>02</span> ${esc(t("rules.two"))}</li>
    <li><span>03</span> ${esc(t("rules.three"))}</li>
  </ol>
  <form method="dialog"><button class="primary-button modal-done">${esc(t("rules.ok"))}</button></form>
</dialog>`;
}

function scripts() {
  return `<script type="module" src="/public/vendor/datastar-1.0.5.js"></script>
<script type="module" src="/public/experience.js?v=${esc(assetVersion)}"></script>
<script type="module" src="/public/sound.js?v=${esc(assetVersion)}"></script>`;
}

/** Переключатель языка: обычная форма, после ответа — полная перезагрузка. */
function langSwitch(t: (key: string) => string, lang: Lang, next: string) {
  const target: Lang = lang === "ru" ? "en" : "ru";
  return `<form class="lang-switch" method="post" action="/act/lang">
    <input type="hidden" name="lang" value="${target}">
    <input type="hidden" name="next" value="${esc(next)}">
    <button class="icon-button lang-button" type="submit" aria-label="${esc(t("common.langSwitch"))}">${target.toUpperCase()}</button>
  </form>`;
}

export function landingPage(view: {
  live: number;
  games: number;
  lang: Lang;
  recent?: { pack: string; emoji: string; winner: string | null; winnerScore: number | null; rivalScore: number | null }[];
}) {
  const t = makeT(view.lang);
  const liveWord = view.live === 1 ? t("home.liveOne") : t("home.liveMany");
  const gamesWord = view.games === 1 ? t("home.gamesOne") : t("home.gamesMany");
  return `${head("The Lot — a draft house for two", view.lang)}
<body data-sound="off">
<main class="app-shell">
  <section class="screen screen--home is-active" aria-labelledby="home-title">
    <header class="home-topbar">
      <p class="eyebrow home-kicker"><span class="status-dot" aria-hidden="true"></span> ${esc(t("home.kicker"))}</p>
      <div class="top-actions">
        <button class="icon-button" type="button" data-open="rules" aria-label="${esc(t("home.rules"))}">?</button>
        <button class="icon-button" type="button" data-sound-toggle aria-label="${esc(t("home.sound"))}">♪</button>
        ${langSwitch(t, view.lang, "/")}
      </div>
    </header>

    <div class="home-hero">
      <div class="logo-spark logo-spark--left" aria-hidden="true">✦</div>
      <div class="logo-spark logo-spark--right" aria-hidden="true">✦</div>
      <div class="logo-badges" aria-hidden="true">
        <span class="number-badge number-badge--one">1</span>
        <span class="logo-star">✦</span>
        <span class="number-badge number-badge--two">2</span>
      </div>
      <h1 class="game-logo" id="home-title"><span>The</span><span>Lot</span></h1>
      <p class="hero-caption">${esc(t("home.caption"))}</p>
    </div>

    <div class="entry-grid">
      <form class="entry-card" method="post" action="/act/create">
        <p class="eyebrow"><span>${esc(t("home.newTable"))}</span><span class="entry-lot">${esc(t("entry.lotOne"))}</span></p>
        <h2>${esc(t("home.createTitle"))}</h2>
        <label class="field">${esc(t("home.name"))}
          <input name="name" maxlength="16" placeholder="${view.lang === "ru" ? "ИГРОК 1" : "PLAYER 1"}" autocomplete="nickname" required>
        </label>
        <p class="entry-hint">${esc(t("home.hint"))}</p>
        <input type="hidden" name="mode" value="online">
        <button class="primary-button" type="submit">${esc(t("home.create"))} <span aria-hidden="true">→</span></button>
      </form>

      <form class="entry-card" method="post" action="/act/join">
        <p class="eyebrow"><span>${esc(t("home.invitation"))}</span><span class="entry-lot">${esc(t("entry.lotTwo"))}</span></p>
        <h2>${esc(t("home.joinTitle"))}</h2>
        <label class="field">${esc(t("home.code"))}
          <input name="code" maxlength="8" placeholder="ABCD" autocapitalize="characters" required>
        </label>
        <label class="field">${esc(t("home.name"))}
          <input name="name" maxlength="16" placeholder="${view.lang === "ru" ? "ИГРОК 2" : "PLAYER 2"}" autocomplete="nickname" required>
        </label>
        <button class="secondary-button" type="submit">${esc(t("home.join"))}</button>
      </form>
    </div>

    <form class="local-form" method="post" action="/act/create">
      <input type="hidden" name="mode" value="local">
      <input type="hidden" name="name" value="${view.lang === "ru" ? "ИГРОК 1" : "PLAYER 1"}">
      <button class="link-button" type="submit">${esc(t("home.local"))} <span aria-hidden="true">→</span></button>
    </form>

    ${
      view.recent && view.recent.length > 0
        ? `<section class="verdicts" aria-labelledby="verdicts-title">
      <h2 id="verdicts-title">${esc(t("home.recent"))}</h2>
      <ul>
        ${view.recent
          .map((game) => {
            const score =
              game.winner && game.winnerScore !== null && game.rivalScore !== null
                ? `<span class="verdict-score">${(game.winnerScore / 5).toFixed(1)} : ${(game.rivalScore / 5).toFixed(1)}</span>`
                : "";
            const who = game.winner ? esc(game.winner) : esc(t("home.recentTie"));
            return `<li><span class="verdict-pack">${esc(game.emoji)} ${esc(game.pack)}</span><span class="verdict-winner">${who}</span>${score}</li>`;
          })
          .join("")}
      </ul>
    </section>`
        : ""
    }

    <section class="party-games" aria-labelledby="party-games-title">
      <h2 id="party-games-title">${esc(t("home.otherGames"))}</h2>
      <div class="party-game-grid">
        <button type="button" data-toast="${esc(t("toast.soon"))}"><span class="party-game-icon" aria-hidden="true">♟</span><span>Imposter</span></button>
        <button type="button" data-toast="${esc(t("toast.soon"))}"><span class="party-game-icon" aria-hidden="true">◎</span><span>Wavelength</span></button>
        <button type="button" data-toast="${esc(t("toast.soon"))}"><span class="party-game-icon" aria-hidden="true">☰</span><span>Blind Rank</span></button>
      </div>
    </section>

    <a class="history-link" href="/history">${esc(t("history.open"))} <span aria-hidden="true">→</span></a>
    <p class="home-footnote">${esc(t("home.footnote", { live: view.live, liveWord, games: view.games, gamesWord }))}</p>
  </section>
</main>
${rulesDialog(t)}
<div class="toast" id="toast" role="status" aria-live="polite"></div>
${scripts()}
</body>
</html>`;
}

export function historyPage(view: {
  lang: Lang;
  stats: {
    played: number;
    wins: number;
    ties: number;
    losses: number;
    best: number | null;
    favouritePack: string | null;
    games: {
      code: string;
      pack: string;
      createdAt: number;
      result: "win" | "loss" | "tie";
      score: number | null;
      rivalScore: number | null;
      picks: number;
      rivalName: string;
    }[];
  };
  packNames: Record<string, string>;
}) {
  const t = makeT(view.lang);
  const locale = view.lang === "en" ? "en-GB" : "ru-RU";
  const rows = view.stats.games
    .map((game) => {
      const date = new Date(game.createdAt).toLocaleDateString(locale, { day: "2-digit", month: "short" });
      const pack = view.packNames[game.pack] ?? game.pack;
      const label = game.result === "win" ? t("history.win") : game.result === "loss" ? t("history.loss") : t("history.tie");
      const score =
        game.score !== null && game.rivalScore !== null
          ? `<span class="history-score">${(game.score / 5).toFixed(1)} : ${(game.rivalScore / 5).toFixed(1)}</span>`
          : "";
      return `<li class="history-row history-row--${game.result}">
        <span class="history-date">${esc(date)}</span>
        <span class="history-pack">${esc(pack)}</span>
        <span class="history-rival">${esc(game.rivalName)}</span>
        ${score}
        <span class="history-result">${esc(label)}</span>
      </li>`;
    })
    .join("");

  return `${head(t("history.title"), view.lang)}
<body data-sound="off">
<main class="app-shell">
  <section class="screen screen--results" aria-labelledby="history-title">
    <header class="view-header results-header">
      <a class="icon-button" href="/" aria-label="${esc(t("results.home"))}">←</a>
      <span class="step-label">${esc(t("history.kicker"))}</span>
      <div class="bar-actions">${langSwitch(t, view.lang, "/history")}</div>
    </header>
    <div class="results-content">
      <p class="eyebrow">${esc(t("history.kicker"))}</p>
      <h1 id="history-title">${esc(t("history.title"))}</h1>
      <p class="results-subtitle">${esc(t("history.subtitle"))}</p>

      <div class="analysis-stats history-stats">
        <div class="analysis-stat"><strong>${view.stats.played}</strong><span>${esc(plural(view.lang, view.stats.played, t("history.played.one"), t("history.played.few"), t("history.played.many")))}</span></div>
        <div class="analysis-stat"><strong>${view.stats.wins}</strong><span>${esc(plural(view.lang, view.stats.wins, t("history.wins.one"), t("history.wins.few"), t("history.wins.many")))}</span></div>
        <div class="analysis-stat"><strong>${view.stats.best !== null ? (view.stats.best / 5).toFixed(1) : "—"}</strong><span>${esc(t("history.best"))}</span></div>
      </div>

      ${
        view.stats.games.length
          ? `<ol class="history-list">${rows}</ol>`
          : `<p class="empty-categories">${esc(t("history.empty"))}</p>`
      }

      <div class="result-actions">
        <a class="primary-button" href="/">${esc(t("history.play"))}</a>
        <a class="secondary-button" href="/#recent">${esc(t("history.all"))}</a>
      </div>
    </div>
  </section>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
${scripts()}
</body>
</html>`;
}

export function roomPage(view: View) {
  const lang = (view.lang ?? "ru") as Lang;
  const t = makeT(lang);
  return `${head(`${view.pack.name} · The Lot`, lang)}
<body data-sound="off">
<main class="app-shell" id="app" data-version="${view.version}" data-init="@get('/stream?v=${view.version}', {retry: 'always', retryMaxWait: 5000, retryMaxCount: 100000})">
${renderRoom(view)}
</main>
${rulesDialog(t)}
<div class="toast" id="toast" role="status" aria-live="polite"></div>
${scripts()}
</body>
</html>`;
}

/* ─────────────────────────── room ─────────────────────────── */

export function renderRoom(view: View) {
  switch (view.phase) {
    case "toss":
      return renderToss(view);
    case "auction":
    case "judging":
      return renderStage(view);
    case "results":
      return renderResults(view);
    default:
      return renderLobby(view);
  }
}

/* ── шапка ── */

export function renderBar(view: View) {
  const lang = (view.lang ?? "ru") as Lang;
  const t = makeT(lang);
  const next = `/r/${view.code}`;
  const back = `<a class="icon-button" href="/" aria-label="${esc(t("common.leave"))}">←</a>`;
  const rules = `<button class="icon-button" type="button" data-open="rules" aria-label="${esc(t("common.rules"))}">?</button>`;
  const sound = `<button class="icon-button" type="button" data-sound-toggle aria-label="${esc(t("home.sound"))}">♪</button>`;

  if (view.phase === "auction" || view.phase === "judging") {
    return `<header class="game-topbar" id="room-bar">
      ${back}
      <div class="game-top-title">
        <span class="eyebrow">${esc(view.pack.name.toUpperCase())} · ${view.profile === "internet-ratings" ? "TMDB" : esc(t("common.lotToken"))}</span>
        <span class="round-count">${esc(t("common.round"))} ${view.auction.number} · ${view.players[0].picks.length + view.players[1].picks.length}/10</span>
      </div>
      <div class="bar-actions">${rules}${sound}${langSwitch(t, lang, next)}</div>
    </header>`;
  }

  if (view.phase === "results") {
    return `<header class="view-header results-header" id="room-bar">
      ${back}
      <span class="step-label">${esc(t("bar.closed"))}</span>
      <div class="bar-actions">${langSwitch(t, lang, next)}<span class="result-trophy" aria-hidden="true">✦</span></div>
    </header>`;
  }

  const title = view.phase === "toss" ? t("bar.toss") : t("bar.choosePack");
  const phaseLabel = t(`phase.${view.phase}`);
  const subtitle = view.phase === "toss" ? `${esc(view.pack.name)} · ${esc(phaseLabel)}` : `${esc(t("common.room"))} ${esc(view.code)} · ${esc(phaseLabel)}`;
  return `<header class="view-header category-header" id="room-bar">
    ${back}
    <div class="category-heading">
      <p class="eyebrow">${subtitle}</p>
      <h1>${esc(title)}</h1>
    </div>
    <div class="bar-actions">${rules}${sound}${langSwitch(t, lang, next)}</div>
  </header>`;
}

/* ── предметы и плашки ── */

function plate(name: string, emoji: string, poster: string | null) {
  if (poster) {
    return `<figure class="lot-plate lot-plate--photo"><img src="/img/tmdb/${esc(poster)}" alt="" width="176" height="264" decoding="async" fetchpriority="high"></figure>`;
  }
  const variant = 1 + (hashOf(name) % 6);
  return `<figure class="lot-plate lot-plate--${variant}" aria-hidden="true">
    <span class="plate-emoji">${esc(emoji)}</span>
    <span class="plate-mark">${esc(initials(name).toUpperCase())}</span>
  </figure>`;
}

function thumb(pick: any) {
  if (pick.poster) {
    return `<img class="thumb" src="/img/tmdb/${esc(pick.poster)}" alt="" width="26" height="26" loading="lazy" decoding="async">`;
  }
  return `<span class="thumb thumb--glyph" aria-hidden="true">${esc(pick.emoji)}</span>`;
}

/* ── лобби ── */

function packCard(view: View, pack: any) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const selected = pack.id === view.pack.id;
  const badge = PROFILE_BADGE[pack.profile];
  const lang = (view.lang ?? "ru") as Lang;
  const flags =
    (pack.verify ? `<span class="pack-flag" title="${esc(t("common.manualCheck"))}">${esc(t("common.check"))}</span>` : "") +
    (pack.inferred ? `<span class="pack-flag" title="${esc(t("common.inferredHint"))}">${esc(t("common.inferred"))}</span>` : "");
  return `<button type="button" class="category-card${selected ? " is-selected" : ""}"
      aria-pressed="${selected}"
      data-tab="${esc(pack.tab)}" data-search="${esc(pack.search)}" data-pack="${esc(pack.id)}"
      ${on("pack", { pack: pack.id })}>
    <span class="category-emoji" aria-hidden="true">${esc(pack.emoji)}</span>
    <span class="category-copy">
      <span class="category-name-line">
        <span class="category-title">${esc(pack.name)}</span>
        ${badge?.key ? `<span class="judge-profile-badge ${badge.className}">${esc(t(badge.key))}</span>` : ""}
        ${flags}
      </span>
      <span class="sr-only">${esc(tabLabel(t, pack.tab))}</span>
    </span>
    <span class="category-count">${pack.count} ${esc(units(t, lang, "item", pack.count))}</span>
  </button>`;
}

function lobbySide(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const auto = view.judgeMode === "auto";
  if (view.spectator && view.mode === "online" && view.seatsFilled < 2) {
    return `<footer class="category-footer" id="lobby-side">
      <form class="join-seat" method="post" action="/act/join">
        <p class="eyebrow">${esc(t("lobby.oneSeat"))}</p>
        <input type="hidden" name="code" value="${esc(view.code)}">
        <label class="field">${esc(t("lobby.yourName"))}
          <input name="name" maxlength="16" placeholder="${view.lang === "ru" ? "ИГРОК 2" : "PLAYER 2"}" autocomplete="nickname" required>
        </label>
        <button class="primary-button start-button" type="submit">${esc(t("lobby.takeSeat"))} <span aria-hidden="true">→</span></button>
      </form>
    </footer>`;
  }
  if (view.spectator) {
    return `<footer class="category-footer" id="lobby-side">
      <div class="selected-pack"><span class="selected-emoji" aria-hidden="true">${esc(view.pack.emoji)}</span>
        <span class="selected-name">${esc(view.pack.name)}</span>
        <span class="selected-count">${view.pack.count} ${esc(units(t, (view.lang ?? "ru") as Lang, "item", view.pack.count))}</span></div>
      <p class="judge-note sr-only">${esc(t("lobby.spectator"))}</p>
      <button class="primary-button start-button" type="button" disabled>${esc(t("lobby.spectate"))}</button>
    </footer>`;
  }

  const seatsReady = view.seatsFilled >= 2;
  const note = !auto ? t("lobby.noteHuman") : t(NOTE_KEY[view.profile] ?? "lobby.noteParty");
  const seatHint = seatsReady ? (view.mode === "local" ? t("lobby.seatsLocal") : t("lobby.seatsReady")) : t("lobby.seatsWait");

  return `<footer class="category-footer" id="lobby-side">
    <div class="selected-pack">
      <span class="selected-emoji" aria-hidden="true">${esc(view.pack.emoji)}</span>
      <span class="selected-name">${esc(view.pack.name)}</span>
      <span class="selected-count">${view.pack.count} ${esc(units(t, (view.lang ?? "ru") as Lang, "item", view.pack.count))}</span>
    </div>
    <div class="judge-switch" role="group" aria-label="${esc(t("common.rules"))}">
      <button type="button" class="judge-option${auto ? " is-selected" : ""}" aria-pressed="${auto}" ${on("judge", { mode: "auto" })}>
        <span>${esc(t(AI_KEY[view.profile] ?? "judge.generic"))}</span>
      </button>
      <button type="button" class="judge-option${auto ? "" : " is-selected"}" aria-pressed="${!auto}" ${on("judge", { mode: "human" })}>${esc(t("lobby.judgeHuman"))}</button>
    </div>
    <p class="judge-note sr-only" id="judge-note">${esc(note)}</p>
    <div class="seat-line">
      <span class="seat-pill${view.players[0].connected ? " is-on" : ""}">${esc(view.players[0].name)}</span>
      <span class="seat-vs" aria-hidden="true">·</span>
      <span class="seat-pill${view.players[1].connected ? " is-on" : ""}">${esc(view.players[1].name)}</span>
      <span class="seat-hint sr-only">${esc(seatHint)}</span>
    </div>
    <button class="primary-button start-button" type="button" ${on("toss")} ${seatsReady ? "" : "disabled"}>
      ${esc(t("lobby.start"))} <span aria-hidden="true">→</span>
    </button>
  </footer>`;
}

function inviteCard(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  if (view.mode === "local") {
    return `<div class="invite-card invite-card--local">
      <span class="invite-mark">${esc(t("lobby.onDevice"))}</span>
      <span class="invite-note">${esc(t("lobby.onDeviceNote"))}</span>
    </div>`;
  }
  const full = view.seatsFilled >= 2;
  return `<div class="invite-card">
    <span class="invite-mark">${esc(t("lobby.invite"))}</span>
    <code class="invite-code">${esc(view.code)}</code>
    <button class="text-button" type="button" data-copy="${esc(view.invite)}">${esc(t("lobby.copy"))}</button>
    <span class="invite-seat ${full ? "is-full" : ""}">${esc(full ? t("lobby.tableFull") : t("lobby.seatOpen"))}</span>
  </div>`;
}

function customPackCard(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const custom = view.pack.tab === "CUSTOM";
  if (custom) {
    return `<div class="custom-pack-card is-loaded">
      <span class="custom-pack-mark">${esc(t("custom.loaded"))}</span>
      <span class="custom-pack-name">${esc(view.pack.emoji)} ${esc(view.pack.name)}</span>
      <span class="custom-pack-count">${view.pack.count} ${esc(units(t, (view.lang ?? "ru") as Lang, "item", view.pack.count))}</span>
      <button class="text-button" form="custom-clear-form" type="submit">${esc(t("custom.reset"))}</button>
    </div>`;
  }
  return `<form class="custom-pack-card" id="custom-form" method="post" action="/act/custom" enctype="multipart/form-data">
    <span class="custom-pack-mark">${esc(t("custom.title"))}</span>
    <label class="custom-pack-file">
      <input type="file" name="pack" accept="application/json,.json" required aria-label="${esc(t("custom.hint"))}" title="${esc(t("custom.hint"))}">
      <span>${esc(t("custom.choose"))}</span>
    </label>
    <button class="text-button" type="submit">${esc(t("custom.upload"))}</button>
  </form>`;
}

function renderLobby(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const chips = [
    `<button type="button" class="filter-chip is-selected" data-tab="ALL" data-label="${esc(t("tab.all"))}" aria-pressed="true">${esc(t("tab.all"))}<span class="filter-count">${view.packs.length}</span></button>`,
    ...view.tabs
      .filter((tab: any) => tab.id !== "ALL")
      .map(
        (tab: any) =>
          `<button type="button" class="filter-chip" data-tab="${esc(tab.id)}" data-label="${esc(tabLabel(t, tab.id))}" aria-pressed="false">${esc(tabLabel(t, tab.id))}<span class="filter-count">${tab.packCount}</span></button>`,
      ),
  ].join("");

  return `<section class="screen screen--categories" id="room" data-phase="lobby" aria-label="${esc(t("common.room"))} ${esc(view.code)}">
  ${renderBar(view)}
  <div class="category-filters" id="category-filters" role="group" aria-label="Packs">${chips}</div>
  <search class="search-field" id="pack-search-wrap">
    <span aria-hidden="true">⌕</span><label class="sr-only" for="pack-search">${esc(t("lobby.search"))}</label>
    <input id="pack-search" type="search" placeholder="${esc(t("lobby.search"))}" autocomplete="off">
  </search>
  <div class="category-list-wrap">
    ${inviteCard(view)}
    ${customPackCard(view)}
    <p class="list-eyebrow" id="category-list-label" data-one="${esc(t("unit.pack.one"))}" data-few="${esc(t("unit.pack.few"))}" data-many="${esc(t("unit.pack.many"))}">${view.packs.length} ${esc(units(t, (view.lang ?? "ru") as Lang, "pack", view.packs.length))} · ${esc(t("tab.all"))}</p>
    <div class="category-list" id="pack-grid">${view.packs.map((pack: any) => packCard(view, pack)).join("")}</div>
    <p class="empty-categories" id="pack-empty" hidden>${esc(t("lobby.noMatches"))}</p>
  </div>
  ${lobbySide(view)}
  <form id="custom-clear-form" method="post" action="/act/custom-clear"></form>
</section>`;
}

/* ── монетка ── */

function renderToss(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const first = view.toss.first;
  const name = first === null ? "" : view.players[first].name;
  const flipped = view.toss.flipped && first !== null;
  const canStart = view.canHostAct && flipped;

  return `<section class="screen screen--coin" id="room" data-phase="toss" aria-label="${esc(t("bar.toss"))}">
  ${renderBar(view)}
  <div class="coin-content">
    <p class="eyebrow">${esc(t("toss.kicker"))}</p>
    <button class="coin ${flipped ? "is-flipped" : ""}${flipped && first === 1 ? " is-back" : ""}" type="button" ${flipped ? "" : on("toss")} aria-label="${esc(t("toss.flip"))}">
      <span class="coin-face coin-face--front"><span>1</span></span>
      <span class="coin-face coin-face--back"><span>2</span></span>
    </button>
    <div class="coin-copy">
      <h1>${flipped ? esc(t("toss.first", { name })) : esc(t("toss.tap"))}</h1>
      <p>${esc(flipped ? t("toss.settled") : t("toss.hint"))}</p>
    </div>
    ${
      flipped
        ? `<button class="primary-button coin-next" type="button" ${on("begin")} ${canStart ? "" : "disabled"}>${esc(t("toss.start"))} <span aria-hidden="true">→</span></button>`
        : ""
    }
    <p class="room-foot">${esc(t("toss.roomFoot", { code: view.code, pack: view.pack.name }))}</p>
  </div>
</section>`;
}

/* ── торги ── */

function ledger(view: View, index: 0 | 1) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const player = view.players[index];
  const active = player.active && view.phase === "auction";
  const rows = Array.from({ length: PICKS }, (_, slot) => {
    const pick = player.picks[slot];
    if (!pick) {
      return `<li class="draft-slot"><span class="slot-number">${slot + 1}</span><span class="slot-item slot-item--open">—</span></li>`;
    }
    return `<li class="draft-slot is-filled">
      <span class="slot-number">${slot + 1}</span>
      ${thumb(pick)}
      <span class="slot-item" title="${esc(pick.name)}">${esc(pick.name)}</span>
      <span class="slot-price">${pick.auto ? esc(t("common.free")) : money(pick.price)}</span>
    </li>`;
  }).join("");

  const status =
    view.phase === "judging"
      ? t("stage.complete")
      : active
        ? t("stage.turn")
        : player.picks.length >= PICKS
          ? t("stage.complete")
          : t("stage.drafted", { n: player.picks.length });

  return `<section class="player-card player-card--${index === 0 ? "one" : "two"}${active ? " is-active" : ""}${active ? "" : " is-waiting"}" aria-label="${esc(t("stage.seat", { name: player.name }))}">
    <div class="player-heading">
      <span class="player-color-dot" aria-hidden="true"></span>
      <span class="player-name">${esc(player.name)}</span>
      <strong class="player-money">${money(player.budget)}</strong>
    </div>
    <ol class="draft-slots" aria-label="${esc(t("stage.slots", { name: player.name }))}">${rows}</ol>
    <p class="player-status">${status}</p>
  </section>`;
}

function stageBand(view: View, judging: boolean) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const au = view.auction;
  const lot = au.lot ?? { name: "—", emoji: view.pack.emoji, description: "", poster: null };
  const picks = view.players[0].picks.length + view.players[1].picks.length;

  if (judging) {
    return `<div class="stage-band stage-band--judging">
      <p class="band-kicker"><span class="band-index">${esc(t("stage.judging"))}</span><span class="band-pack">${esc(view.pack.name)}</span><span class="band-count">10/10</span></p>
      <div class="band-main">
        <div class="band-copy">
          <h1 class="band-title">${esc(t("stage.reviewing"))}</h1>
          <p class="band-note">${esc(t("stage.reviewNote"))}</p>
          <div class="judging-dots" aria-hidden="true"><i></i><i></i><i></i></div>
        </div>
      </div>
    </div>`;
  }

  return `<div class="stage-band">
    <p class="band-kicker">
      <span class="band-index">${esc(t("stage.lot", { n: String(au.number).padStart(2, "0") }))}</span>
      <span class="band-pack">${esc(view.pack.name)}</span>
      <span class="band-count">${picks}/10</span>
    </p>
    <div class="band-main">
      ${plate(lot.name, lot.emoji, lot.poster ?? null)}
      <div class="band-copy">
        <p class="band-overline">${esc(t("stage.lotUp"))}</p>
        <h1 id="auction-title" class="band-title">${esc(lot.name)}</h1>
        <p class="band-note">${esc(lot.description)}</p>
      </div>
    </div>
  </div>`;
}

function bidPanel(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const au = view.auction;
  const high = au.highBidder;
  const turnName = view.players[au.turn]?.name ?? "";
  const leader = high === null ? null : view.players[high];
  const canBid = view.auction.canAct && view.players[au.turn]?.budget >= au.bidAmount && view.players[au.turn]?.picks.length < PICKS;

  const stepper = high === null
    ? `<div class="bid-stepper" aria-label="${esc(t("stage.noBids"))}">
        <button class="step-button" id="bid-minus" type="button" aria-label="−" ${canBid ? "" : "disabled"} ${on("open", { delta: -1 })}>−</button>
        <span>${money(au.opening)}</span>
        <button class="step-button" id="bid-plus" type="button" aria-label="+" ${canBid ? "" : "disabled"} ${on("open", { delta: 1 })}>+</button>
      </div>`
    : `<div class="bid-ladder" role="group" aria-label="${esc(t("stage.step"))}">
        ${[1, 2, 3, 5]
          .map(
            (value) =>
              `<button class="ladder-chip${au.step === value ? " is-selected" : ""}" type="button" aria-pressed="${au.step === value}" ${on("step", { step: value })}>+$${value}</button>`,
          )
          .join("")}
      </div>`;

  const turnText = high === null ? t("stage.hintOpen", { name: turnName }) : t("stage.hintRaise", { name: turnName });

  return `<section class="auction-center" aria-live="polite">
    <p class="sr-only" id="turn-live" aria-live="polite">${esc(turnText)}</p>
    <div class="bid-status">
      <span class="eyebrow">${
        high === null
          ? esc(t("stage.opening", { name: turnName }))
          : esc(t("stage.leading", { name: leader?.name ?? "", next: turnName }))
      }</span>
      <strong class="bid-amount" id="bid-amount">${money(high === null ? au.opening : au.currentBid)}</strong>
      <span class="bid-note">${esc(high === null ? t("stage.noBids") : t("stage.ahead", { name: leader?.name ?? "" }))}</span>
    </div>
    ${stepper}
    <div class="auction-actions">
      <button class="primary-button bid-button" id="bid-button" type="button" ${on("bid")} ${canBid ? "" : "disabled"}>${esc(t("common.bid"))} ${money(au.bidAmount)}</button>
      <button class="secondary-button pass-button" id="pass-button" type="button" ${on("pass")} ${view.auction.canAct ? "" : "disabled"}>${esc(t("common.pass"))}</button>
    </div>
    ${high === null ? "" : `<p class="ladder-note" aria-hidden="true">${esc(t("stage.stepNote"))}</p>`}
    <p class="keys-hint" aria-hidden="true">${esc(t("stage.keys"))}</p>
    <p class="turn-hint">${
      view.spectator
        ? esc(t("stage.observing"))
        : view.auction.canAct
          ? esc(high === null ? t("stage.hintOpen", { name: turnName }) : t("stage.hintRaise", { name: turnName }))
          : esc(t("stage.hintWait", { name: turnName }))
    }</p>
  </section>`;
}

function renderStage(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const judging = view.phase === "judging";
  return `<section class="screen screen--game" id="room" data-phase="${judging ? "judging" : "auction"}" aria-label="${esc(t("phase.auction"))}">
  ${renderBar(view)}
  ${stageBand(view, judging)}
  ${
    judging
      ? `<div class="game-layout game-layout--judging">${ledger(view, 0)}${ledger(view, 1)}</div>`
      : `<div class="game-layout">${ledger(view, 0)}${bidPanel(view)}${ledger(view, 1)}</div>`
  }
</section>`;
}

/* ── итоги ── */

function scorecard(view: View, index: 0 | 1) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const player = view.players[index];
  const report = view.review?.players?.[index];
  const picks = player.picks
    .map((pick: any, pickIndex: number) => {
      const note = report?.picks?.[pickIndex];
      const text = [note?.basis, note?.reason].filter(Boolean).join(" · ");
      return `<div class="result-pick">
        ${thumb(pick)}
        <span class="result-pick-name">${esc(pick.name)}</span>
        <span class="result-pick-rating" title="${esc(
          bandFor(view.profile, note?.rating ?? pick.rating ?? null) ? t(`norms.band${BANDS.indexOf(bandFor(view.profile, note?.rating ?? pick.rating ?? null)!) + 1}`) : "",
        )}">${esc(ratingLabel(t, view.profile, note?.rating ?? pick.rating ?? null))}</span>
        <span class="result-pick-price">${pick.auto ? esc(t("common.free")) : money(pick.price)}</span>
        ${text ? `<span class="result-pick-reason">${esc(text)}</span>` : ""}
      </div>`;
    })
    .join("");

  const notes = report
    ? `<div class="player-ai-notes">
        ${report.strengths ? `<p><span>${esc(t("results.strength"))}</span>${esc(report.strengths)}</p>` : ""}
        ${report.weaknesses ? `<p><span>${esc(t("results.weakness"))}</span>${esc(report.weaknesses)}</p>` : ""}
        ${report.strategy ? `<p><span>${esc(t("results.strategy"))}</span>${esc(report.strategy)}</p>` : ""}
      </div>`
    : "";

  const judgeName = view.profile === "internet-ratings" ? "TMDb" : view.review?.model === "mock" ? t("common.testMode") : "Luna";
  return `<article class="result-card">
    <h2><i class="player-color-dot player-color-dot--${index + 1}" aria-hidden="true"></i>${esc(player.name)}
      <span>${view.review ? esc(scoreLabel(view.profile, report?.score ?? 0, report?.ratedCount ?? 0)) : `${player.picks.length}/5`}</span>
    </h2>
    <p>${esc(t("results.picksLine", { n: player.picks.length, spent: money(player.spent), budget: money(player.budget) }))}${
      view.review ? ` · ${judgeName}` : ""
    }</p>
    ${notes}
    <div class="result-items">${picks}</div>
  </article>`;
}

function normsBlock(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  if (view.profile === "internet-ratings") {
    return `<details class="norms">
      <summary>${esc(t("norms.title"))} · TMDb</summary>
      <p class="norms-hint">${esc(t("norms.tmdbScale"))}</p>
      <ul class="norms-rules">
        <li>${esc(t("norms.tmdb"))}</li>
        <li>${esc(t("norms.tmdbMin"))}</li>
      </ul>
      <p class="norms-rule">${esc(t("norms.tmdbFlat"))}</p>
    </details>`;
  }
  const prefix =
    view.profile === "character-power" ? "norms.power" : view.profile === "athlete-performance" ? "norms.sports" : "norms.party";
  return `<details class="norms">
    <summary>${esc(t("norms.title"))}</summary>
    <p class="norms-hint">${esc(t("norms.hint"))}</p>
    <dl class="norms-bands">
      ${BANDS.map(
        (band, index) =>
          `<div><dt>${esc(t(`norms.band${index + 1}`))}</dt><dd>${esc(t(`${prefix}${index + 1}`))}</dd></div>`,
      ).join("")}
    </dl>
    <ul class="norms-rules">
      <li>${esc(t("norms.ruleAverage"))}</li>
      <li>${esc(t("norms.ruleSpread"))}</li>
      <li>${esc(t("norms.ruleUnknown"))}</li>
      <li>${esc(t("norms.rulePrice"))}</li>
    </ul>
  </details>`;
}

function analysis(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const review = view.review;
  const error = view.reviewError;
  const draws = view.manualVote === "draw";
  const methodKey = METHOD_KEY[view.profile] ?? "method.party";
  const method = review?.model === "mock" ? `${t(methodKey)} ${t("method.mock")}` : t(methodKey);

  const unratedNote = () => {
    const missing = view.players
      .map((player: any, index: number) => ({ name: player.name, left: player.picks.length - (review?.players?.[index]?.ratedCount ?? 0) }))
      .filter((entry: any) => entry.left > 0)
      .map((entry: any) => `${entry.name}: ${entry.left}`)
      .join(", ");
    return missing ? t("results.unrated", { list: missing }) : "";
  };

  let summary = "";
  if (error) summary = error;
  else if (review && view.winner === null) {
    summary =
      view.profile === "internet-ratings"
        ? t("results.summaryTieTmdb", { score: (review.scores[0] / 5).toFixed(1), unrated: unratedNote() })
        : t("results.summaryTie", { score: scoreLabel(view.profile, review.scores[0], review.players[0].ratedCount), comparison: review.comparison });
  } else if (review && (view.winner === 0 || view.winner === 1)) {
    const winner = view.players[view.winner];
    const rival = view.players[1 - view.winner];
    const lead = review.scores[view.winner] - review.scores[1 - view.winner];
    summary =
      view.profile === "internet-ratings"
        ? t("results.summaryWinTmdb", {
            winner: winner.name,
            winnerAvg: (review.scores[view.winner] / 5).toFixed(1),
            rivalAvg: (review.scores[1 - view.winner] / 5).toFixed(1),
            rival: rival.name,
            unrated: unratedNote(),
          })
        : t("results.summaryWin", {
            winner: winner.name,
            score: `${review.scores[view.winner]}–${review.scores[1 - view.winner]}`,
            lead,
            comparison: review.comparison,
          });
  } else if (draws) summary = t("results.summaryHumanDraw");
  else if (view.winner === 0 || view.winner === 1) summary = t("results.summaryHuman", { winner: view.players[view.winner].name });
  else summary = t("results.summaryPending");

  const totalPicks = view.players.reduce((sum: number, player: any) => sum + player.picks.length, 0);
  const totalSpent = view.players.reduce((sum: number, player: any) => sum + player.spent, 0);
  const skipped = view.history.filter((round: any) => round.skipped).length;
  const retry = error && view.judgeMode === "auto";

  const rounds = view.history
    .map((round: any, index: number) => {
      const outcome = round.skipped
        ? t("results.skipped")
        : round.auto
          ? t("results.autoPick", { name: view.players[round.winner].name })
          : t("results.wonBy", { name: view.players[round.winner].name, price: money(round.price) });
      const bids = round.bids.length
        ? `<span class="auction-round-bids"><b>${esc(t("results.bids"))}</b> ${esc(view.players[round.bids[0].seat].name)} ${money(
            round.bids[0].amount,
          )} → ${money(round.bids[round.bids.length - 1].amount)} · ${round.bids.length}</span>`
        : "";
      const passes = round.passes.length
        ? `<span class="auction-round-bids"><b>${esc(t("results.pass"))}</b> ${round.passes.map((seat: number) => esc(view.players[seat].name)).join(", ")}</span>`
        : "";
      return `<li class="auction-round">
        <span class="auction-round-number">${String(index + 1).padStart(2, "0")}</span>
        <div class="auction-round-main">
          <strong class="auction-round-title">${esc(round.lot.emoji)} ${esc(round.lot.name)}</strong>
          <span class="auction-round-outcome">${esc(outcome)}</span>
          ${bids}${passes}
        </div>
      </li>`;
    })
    .join("");

  return `<section class="game-analysis" aria-labelledby="analysis-heading">
    <header class="analysis-heading"><p class="eyebrow">${esc(t("results.report"))}</p><h2 id="analysis-heading">${esc(t("results.reportTitle"))}</h2></header>
    <p class="analysis-method" id="analysis-method">${esc(method)}</p>
    <div class="analysis-summary" id="analysis-summary"><p>${esc(summary)}</p></div>
    ${normsBlock(view)}
    ${
      retry
        ? `<div class="analysis-actions" id="analysis-actions">
             <button class="primary-button" type="button" ${on("retry")}>${esc(t("results.retry"))}</button>
             <button class="secondary-button" type="button" ${on("judge", { mode: "human" })}>${esc(t("results.useHuman"))}</button>
           </div>`
        : ""
    }
    <div class="analysis-stats" id="analysis-stats">
      <div class="analysis-stat"><strong>${totalPicks}/10</strong><span>${esc(t("results.statsPicks"))}</span></div>
      <div class="analysis-stat"><strong>${money(totalSpent)}</strong><span>${esc(t("results.statsSpent"))}</span></div>
      <div class="analysis-stat"><strong>${skipped}</strong><span>${esc(t("results.statsSkipped"))}</span></div>
    </div>
    <details class="auction-log" id="auction-log">
      <summary><span>${esc(t("results.log", { n: view.history.length }))}</span></summary>
      <ol id="auction-log-list">${rounds}</ol>
    </details>
  </section>`;
}

function renderResults(view: View) {
  const t = makeT((view.lang ?? "ru") as Lang);
  const decided = view.winner === 0 || view.winner === 1 || view.winner === null;
  const human = view.judgeMode === "human" && view.manualVote === null;
  const name = decided && typeof view.winner === "number" ? view.players[view.winner].name : null;

  const title = human
    ? t("results.humanTitle")
    : name
      ? t("results.wins", { name: name.toUpperCase() })
      : decided
        ? t("results.tie")
        : t("results.errorTitle");
  const banner = human
    ? t("results.bannerHuman")
    : name
      ? t("results.bannerWin", { name: name.toUpperCase() })
      : decided
        ? t("results.bannerTie")
        : t("results.bannerError");
  const kicker = human ? t("results.kickerHuman") : view.reviewError ? t("results.kickerError") : t("results.kickerJudged");

  const votes = human
    ? `<div class="judge-prompt">
        <p>${esc(t("results.voteTitle"))}</p>
        <div class="judge-votes">
          <button class="primary-button" type="button" ${on("vote", { vote: 0 })}>${esc(t("results.voteA", { name: view.players[0].name }))}</button>
          <button class="secondary-button" type="button" ${on("vote", { vote: 1 })}>${esc(t("results.voteB", { name: view.players[1].name }))}</button>
        </div>
        <button class="draw-button" type="button" ${on("vote", { vote: "draw" })}>${esc(t("results.draw"))}</button>
      </div>`
    : "";

  const shareText =
    view.review && typeof view.winner === "number"
      ? `The Lot · ${view.pack.name} · ${title} · ${scoreLabel(view.profile, view.review.scores[view.winner], view.review.players[view.winner].ratedCount)} : ${scoreLabel(view.profile, view.review.scores[1 - view.winner], view.review.players[1 - view.winner].ratedCount)}`
      : `The Lot · ${view.pack.name} · ${title}`;

  const actions = `<div class="result-actions">
        <button class="secondary-button" type="button" data-copy="${esc(shareText)}">${esc(t("results.copy"))}</button>
        ${view.canHostAct ? `<button class="primary-button" type="button" ${on("again")}>${esc(t("results.again"))}</button>` : ""}
        <a class="secondary-button" href="/history">${esc(t("history.open"))}</a>
        <a class="secondary-button" href="/">${esc(t("results.home"))}</a>
      </div>`;

  return `<section class="screen screen--results" id="room" data-phase="results" aria-label="${esc(t("phase.results"))}">
  ${renderBar(view)}
  <div class="results-content">
    <p class="eyebrow">${esc(kicker)}</p>
    <h1 id="results-title">${esc(title)}</h1>
    <p class="results-subtitle">${esc(t("results.subtitle", { emoji: view.pack.emoji, pack: view.pack.name, count: view.players[0].picks.length + view.players[1].picks.length }))}</p>
    <div class="winner-banner" id="winner-banner">${esc(banner)}</div>
    <div class="result-scorecards">${scorecard(view, 0)}${scorecard(view, 1)}</div>
    ${analysis(view)}
    ${votes}
    ${actions}
  </div>
</section>`;
}

/* ── мелкие фрагменты для точечных патчей ── */

export function patchFragments(view: View) {
  return { bar: renderBar(view), side: view.phase === "lobby" ? lobbySide(view) : "" };
}

export function toast(text: string) {
  return `<div class="toast is-visible" id="toast" role="status" aria-live="polite">${esc(text)}</div>`;
}
