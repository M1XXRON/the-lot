// UI-e2e: два браузера, полная онлайн-партия, проверка вёрстки и консоли.
import { mkdirSync } from "node:fs";
import { assert, startServer } from "./lib.mjs";

const OUT = process.env.SHOTS_DIR ?? "screenshots";
mkdirSync(OUT, { recursive: true });

async function playwright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, "playwright", "/Users/apple/dev/tools/node_modules/playwright/index.mjs"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch {
      /* пробуем следующий */
    }
  }
  throw new Error("playwright не найден: задайте PLAYWRIGHT_PATH");
}

const { chromium } = await playwright();
const server = await startServer({ mock: true });
const browser = await chromium.launch({ headless: true });
const errors = [];

async function makePage(viewport) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 160));
  });
  return { context, page };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

try {
  const host = await makePage({ width: 1365, height: 900 });
  await host.page.goto(`${server.base}/`, { waitUntil: "domcontentloaded" });
  await host.page.screenshot({ path: `${OUT}/01-landing-desktop.png`, fullPage: true });

  await host.page.fill('form[action="/act/create"] input[name="name"]', "ALEX");
  await host.page.click('form[action="/act/create"] button[type=submit]');
  await host.page.waitForSelector("#lobby-side", { timeout: 15000 });
  const code = new URL(host.page.url()).pathname.split("/r/")[1];
  assert(code, "хост не попал в комнату");

  // паки: POWER-профиль и поиск
  await host.page.click('#pack-grid [data-pack="anime-characters"]');
  await host.page.waitForTimeout(250);
  assert((await host.page.locator("#lobby-side .selected-name").innerText()).includes("Anime Characters"), "пак не выбран");
  assert(await host.page.locator("#judge-note").innerText().then((t) => t.includes("POWER")), "нет подсказки POWER-режима");

  // поиск фильтрует каталог на клиенте
  await host.page.fill("#pack-search", "pokemon");
  await host.page.waitForTimeout(150);
  const visible = await host.page.locator("#pack-grid .category-card:visible").count();
  assert(visible > 0 && visible < 20, `поиск не отфильтровал: ${visible}`);
  await host.page.fill("#pack-search", "");
  await host.page.waitForTimeout(150);

  const guest = await makePage({ width: 390, height: 844 });
  await guest.page.goto(`${server.base}/r/${code}`, { waitUntil: "domcontentloaded" });
  await guest.page.waitForSelector(".join-seat");
  await guest.page.fill('.join-seat input[name="name"]', "MARIA");
  await guest.page.click(".join-seat button[type=submit]");
  await guest.page.waitForTimeout(900);
  assert(guest.page.url().includes(`/r/${code}`), "гость не вернулся в комнату");
  assert((await host.page.locator(".seat-pill").allInnerTexts()).join(" ").includes("MARIA"), "гость не появился у хоста");

  await host.page.click("#lobby-side .start-button");
  await host.page.waitForTimeout(1250);
  await host.page.screenshot({ path: `${OUT}/02-toss-desktop.png`, fullPage: true });
  assert((await guest.page.locator("#room").getAttribute("data-phase")) === "toss", "гость не увидел жеребьёвку");

  await host.page.click(".coin-next");
  await host.page.waitForTimeout(600);
  assert((await guest.page.locator("#room").getAttribute("data-phase")) === "auction", "торги не начались у гостя");
  await host.page.screenshot({ path: `${OUT}/03-auction-desktop.png`, fullPage: true });

  for (let i = 0; i < 140; i += 1) {
    if (await host.page.locator('#room[data-phase="results"]').count()) break;
    const one = await host.page.locator("#room .player-card--one.is-active").count();
    const two = await host.page.locator("#room .player-card--two.is-active").count();
    assert(one || two, "нет активного игрока");
    const page = one ? host.page : guest.page;
    if (await page.locator("#bid-button").isEnabled()) await page.click("#bid-button");
    else await page.click("#pass-button");
    await host.page.waitForTimeout(140);
  }
  await host.page.waitForTimeout(900);
  assert(await host.page.locator('#room[data-phase="results"]').count(), "партия не дошла до итогов");
  assert((await guest.page.locator("#results-title").innerText()).length > 3, "у гостя нет вердикта");
  assert((await host.page.locator(".result-pick-rating").count()) === 10, "меньше десяти оценок");
  assert((await host.page.locator("#analysis-method").innerText()).includes("POWER"), "итог не в POWER-режиме");

  await host.page.click("#auction-log summary");
  await host.page.waitForTimeout(200);
  await host.page.screenshot({ path: `${OUT}/04-results-desktop.png`, fullPage: true });

  assert(!(await overflow(host.page)), "горизонтальный скролл на десктопе");

  // мобильный экран: та же комната глазами гостя
  await guest.page.screenshot({ path: `${OUT}/05-results-mobile.png`, fullPage: true });
  assert(!(await overflow(guest.page)), "горизонтальный скролл на телефоне");

  // узкий экран 320: лендинг и лобби
  const narrow = await makePage({ width: 320, height: 720 });
  await narrow.page.goto(`${server.base}/`, { waitUntil: "domcontentloaded" });
  assert(!(await overflow(narrow.page)), "320px: скролл на лендинге");
  await narrow.page.screenshot({ path: `${OUT}/06-landing-320.png`, fullPage: true });
  await narrow.page.click(".local-form button");
  await narrow.page.waitForSelector("#lobby-side", { timeout: 15000 });
  await narrow.page.waitForTimeout(300);
  assert(!(await overflow(narrow.page)), "320px: скролл в лобби");
  await narrow.page.screenshot({ path: `${OUT}/07-lobby-320.png`, fullPage: true });
  await narrow.page.click("#lobby-side .start-button");
  await narrow.page.waitForTimeout(400);
  await narrow.page.click(".coin-next");
  await narrow.page.waitForTimeout(500);
  assert(!(await overflow(narrow.page)), "320px: скролл в торгах");
  await narrow.page.screenshot({ path: `${OUT}/08-auction-320.png`, fullPage: true });

  if (errors.length) throw new Error(`консоль: ${errors.slice(0, 3).join(" | ")}`);
  console.log("ui-e2e: ок, скриншоты в", OUT);
} finally {
  await browser.close();
  await server.stop();
}
