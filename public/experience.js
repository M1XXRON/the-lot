// Клиентская мелочь: фильтры каталога, копирование инвайта, диалоги, тосты.
// Всё игровое состояние живёт на сервере и приходит патчами Datastar.

const sound = () => window.LotSound;

const COPY = {
  ru: { copied: "Ссылка скопирована", copyFail: "Не удалось скопировать — выделите адрес вручную" },
  en: { copied: "Link copied", copyFail: "Couldn't copy — select the address manually" },
};
const copyTexts = () => COPY[document.documentElement.lang === "en" ? "en" : "ru"];

/* ── каталог: разделы, поиск, счётчик ───────────────────── */
// Делегирование: Datastar морфит DOM, локальные слушатели терялись бы.

const catalogState = { tab: "ALL", query: "" };

const normalize = (value) =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

function applyCatalog() {
  const grid = document.getElementById("pack-grid");
  if (!grid) return;
  const label = document.getElementById("category-list-label");
  let shown = 0;
  for (const card of grid.querySelectorAll(".category-card")) {
    const byTab = catalogState.tab === "ALL" || card.dataset.tab === catalogState.tab;
    if (card.dataset.searchNorm === undefined) card.dataset.searchNorm = normalize(card.dataset.search || "");
    const byQuery = !catalogState.query || card.dataset.searchNorm.includes(catalogState.query);
    const visible = byTab && byQuery;
    card.hidden = !visible;
    if (visible) shown += 1;
  }
  if (label) {
    const activeChip = document.querySelector(`#category-filters [data-tab="${CSS.escape(catalogState.tab)}"]`);
    const tabName = activeChip?.dataset.label || catalogState.tab;
    const forms = [label.dataset.one, label.dataset.few, label.dataset.many].filter(Boolean);
    const lang = document.documentElement.lang === "en" ? "en" : "ru";
    let word = forms[0] ?? "";
    if (lang === "en") word = shown === 1 ? forms[0] : forms[2] ?? forms[0];
    else {
      const mod10 = shown % 10;
      const mod100 = shown % 100;
      if (mod10 === 1 && mod100 !== 11) word = forms[0];
      else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = forms[1];
      else word = forms[2];
    }
    const nextLabel = `${shown} ${word} · ${tabName}`;
    if (label.textContent !== nextLabel) label.textContent = nextLabel;
  }
  const empty = document.getElementById("pack-empty");
  if (empty) empty.hidden = shown > 0;
}

function markChips() {
  document.querySelectorAll("#category-filters [data-tab]").forEach((chip) => {
    const active = (chip.dataset.tab || "ALL") === catalogState.tab;
    chip.classList.toggle("is-selected", active);
    chip.setAttribute("aria-pressed", String(active));
  });
}

document.addEventListener("click", (event) => {
  const chip = event.target.closest("#category-filters [data-tab]");
  if (!chip) return;
  catalogState.tab = chip.dataset.tab || "ALL";
  markChips();
  chip.scrollIntoView({ block: "nearest", inline: "nearest" });
  applyCatalog();
  sound()?.play("tap");
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "pack-search") return;
  catalogState.query = normalize(event.target.value.trim());
  applyCatalog();
});

/* ── клавиатура: B — ставка, P — пас, +/− — стартовая ставка ── */
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
  const room = document.getElementById("room");
  if (!room || room.dataset.phase !== "auction") return;
  const key = event.key.toLowerCase();
  const click = (id) => {
    const el = document.getElementById(id);
    if (el && !el.disabled) {
      event.preventDefault();
      el.click();
      return true;
    }
    return false;
  };
  if (key === "b") click("bid-button");
  else if (key === "p") click("pass-button");
  else if (key === "+" || key === "=") click("bid-plus");
  else if (key === "-" || key === "_") click("bid-minus");
});

/* ── фокус после морфа: Datastar пересобирает DOM, возвращаем фокус на ту же кнопку ── */
let lastActionId = null;
document.addEventListener("click", (event) => {
  const actionable = event.target.closest("[data-on\\:click]");
  if (actionable && actionable.id) lastActionId = actionable.id;
}, true);

function restoreFocus() {
  if (!lastActionId || document.activeElement !== document.body) return;
  const el = document.getElementById(lastActionId);
  if (el && !el.disabled && el.isConnected) el.focus({ preventScroll: true });
}

document.addEventListener("click", (event) => {
  const card = event.target.closest("#pack-grid .category-card");
  if (!card) return;
  document.querySelectorAll("#pack-grid .category-card").forEach((other) => {
    const active = other === card;
    other.classList.toggle("is-selected", active);
    other.classList.toggle("selected", active);
    other.setAttribute("aria-pressed", String(active));
  });
});

/* ── пакеты, ссылки, диалоги ────────────────────────────── */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function toast(message) {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("is-visible"), 2600);
}

function bind() {
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-copy]");
    if (target) {
      const ok = await copyText(target.dataset.copy || location.href);
      toast(ok ? copyTexts().copied : copyTexts().copyFail);
      sound()?.play("tap");
      return;
    }

    const open = event.target.closest("[data-open]");
    if (open) {
      const dialog = document.getElementById(open.dataset.open || "");
      if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal();
      return;
    }

    const toggle = event.target.closest("[data-sound-toggle]");
    if (toggle) {
      sound()?.toggle();
      return;
    }

    const soon = event.target.closest("[data-toast]");
    if (soon) {
      toast(soon.dataset.toast || "");
      return;
    }

    const post = event.target.closest("[data-on\\:click]");
    if (post && post.closest("#room")) {
      const expr = post.getAttribute("data-on:click") || "";
      if (expr.includes("/act/bid")) sound()?.play("bid");
      else if (expr.includes("/act/pass")) sound()?.play("pass");
      else if (expr.includes("/act/toss")) sound()?.play("coin");
      else if (expr.includes("/act/begin")) sound()?.play("coin");
      else sound()?.play("tap");
    }
  });

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
}

/* ── момент победы: одна короткая фраза ─────────────────── */

let lastWinner = null;
function watchWinner() {
  const title = document.querySelector("#room .results-content h1");
  const banner = document.querySelector("#room .winner-banner");
  if (!title || !banner) return;
  const text = title.textContent || "";
  if (/WINS/i.test(text) && text !== lastWinner) {
    lastWinner = text;
    sound()?.play("win");
  }
}

/* ── запуск ─────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  bind();
  applyCatalog();
  markChips();
  watchWinner();

  // Datastar морфит DOM: пересобираем фильтры после каждого патча, но без лавины.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyCatalog();
      markChips();
      watchWinner();
      restoreFocus();
      const toastNode = document.getElementById("toast");
      if (toastNode?.classList.contains("is-visible") && !toastNode.dataset.bound) {
        toastNode.dataset.bound = "1";
        setTimeout(() => {
          toastNode.classList.remove("is-visible");
          delete toastNode.dataset.bound;
        }, 2600);
      }
    });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
});
