// Звук: крошечные синтезированные блипы, без файлов и без автозапуска.
// По умолчанию выключен; состояние хранится в localStorage.

let ctx = null;
let enabled = false;

function ensureContext() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

function tone(frequency, duration, gain = 0.05, type = "sine") {
  const audio = ensureContext();
  if (!audio) return;
  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, now);
  amp.gain.setValueAtTime(0, now);
  amp.gain.linearRampToValueAtTime(gain, now + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

const SOUNDS = {
  tap: () => tone(420, 0.08, 0.035, "triangle"),
  bid: () => {
    tone(330, 0.1, 0.04, "triangle");
    setTimeout(() => tone(495, 0.12, 0.035, "triangle"), 70);
  },
  pass: () => tone(240, 0.12, 0.03, "sine"),
  coin: () => {
    tone(880, 0.09, 0.04, "triangle");
    setTimeout(() => tone(1320, 0.14, 0.03, "sine"), 90);
  },
  win: () => {
    [523, 659, 784].forEach((freq, index) => setTimeout(() => tone(freq, 0.22, 0.04, "triangle"), index * 110));
  },
};

function read() {
  try {
    return localStorage.getItem("lot.sound") === "on";
  } catch {
    return false;
  }
}

function apply(value) {
  enabled = value;
  document.body.dataset.sound = value ? "on" : "off";
  document.querySelectorAll("[data-sound-toggle]").forEach((button) => {
    button.setAttribute("aria-pressed", String(value));
    button.setAttribute("title", value ? "Звук включён" : "Звук выключен");
    button.dataset.soundState = value ? "on" : "off";
  });
}

export function toggleSound() {
  const next = !enabled;
  apply(next);
  try {
    localStorage.setItem("lot.sound", next ? "on" : "off");
  } catch {
    /* приватный режим */
  }
  if (next) play("tap");
}

export function play(kind) {
  if (!enabled) return;
  const fn = SOUNDS[kind];
  if (!fn) return;
  const audio = ensureContext();
  if (audio && audio.state === "suspended") void audio.resume();
  fn();
}

document.addEventListener("DOMContentLoaded", () => {
  apply(read());
  // Datastar морфит DOM — возвращаем состояние новым кнопкам
  new MutationObserver(() => {
    document.querySelectorAll("[data-sound-toggle]").forEach((button) => {
      if (button.getAttribute("aria-pressed") !== String(enabled)) apply(enabled);
    });
  }).observe(document.body, { childList: true, subtree: true });
});
window.LotSound = { play, toggle: toggleSound, isOn: () => enabled };
