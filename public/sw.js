// Офлайн-оболочка The Lot: лендинг и статика переживают пропажу сети.
// Игровые каналы (SSE, /act, картинки) не кешируются никогда: состояние живёт на сервере.
const VERSION = "__LOT_ASSET_VERSION__";
const CACHE = `lot-${VERSION}`;
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/public/favicon.svg",
  `/public/style.css?v=${VERSION}`,
  `/public/redesign.css?v=${VERSION}`,
  `/public/stages.css?v=${VERSION}`,
  `/public/experience.js?v=${VERSION}`,
  `/public/sound.js?v=${VERSION}`,
  "/public/vendor/datastar-1.0.5.js",
];

const SKIP = (path) =>
  path === "/stream" ||
  path === "/health" ||
  path === "/sw.js" ||
  path.startsWith("/act/") ||
  path.startsWith("/img/") ||
  path.startsWith("/api/");

function offline() {
  const html = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>The Lot — offline</title></head>
<body>
<h1>The Lot</h1>
<p>Нет сети. Партия ждёт на сервере — вернитесь, когда связь появится.</p>
<p lang="en">No connection. The game is waiting on the server — come back when you're online.</p>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || SKIP(url.pathname)) return;

  // Страницы: сначала сеть, в офлайне — последняя удачная оболочка.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put("/", copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match("/")) || offline()),
    );
    return;
  }

  // Статика: отдаём из кеша и тихо обновляем в фоне.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
