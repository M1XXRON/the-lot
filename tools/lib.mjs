// Общие помощники для e2e: поднять сервер, дождаться /health, ходить с cookie.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startServer({ port, mock = true, env = {} } = {}) {
  const dbDir = mkdtempSync(join(tmpdir(), "lot-e2e-"));
  const chosenPort = port ?? 4400 + Math.floor(Math.random() * 400);
  const proc = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(chosenPort),
      HOST: "127.0.0.1",
      LOT_DB: join(dbDir, "lot.db"),
      LOT_MOCK: mock ? "1" : "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const base = `http://127.0.0.1:${chosenPort}`;
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* ещё стартует */
    }
    await Bun.sleep(120);
  }
  if (!ready) {
    proc.kill();
    const err = await new Response(proc.stderr).text();
    throw new Error(`сервер не поднялся: ${err.slice(0, 400)}`);
  }

  return {
    base,
    async stop() {
      proc.kill();
      await Bun.sleep(60);
      try {
        rmSync(dbDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Сессия с cookie-банкой и парой методов для форм/HTML. */
export function client(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const remember = (response) => {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const [name, value] = pair.split("=");
      if (name && value) jar.set(name.trim(), value.trim());
    }
  };

  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (jar.size) headers.set("cookie", cookieHeader());
    const response = await fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
    remember(response);
    return response;
  };

  return {
    jar,
    get: (path, init) => request(path, init),
    async html(path) {
      const response = await request(path);
      return { status: response.status, html: await response.text(), headers: response.headers };
    },
    async form(path, fields) {
      const body = new URLSearchParams(fields);
      return request(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    },
    async act(path) {
      return request(`/act/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    },
    async upload(path, file) {
      const form = new FormData();
      form.set("pack", new Blob([file.body], { type: file.type ?? "application/json" }), file.name ?? "pack.json");
      return request(path, { method: "POST", body: form });
    },
    async actJson(path, payload) {
      return request(`/act/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
    },
  };
}

/** Вытащить код комнаты из заголовка Location. */
export function roomCodeFrom(response) {
  const location = response.headers.get("location") ?? "";
  const match = location.match(/\/r\/([A-Z0-9]+)/i);
  if (!match) throw new Error(`нет кода комнаты в Location: ${location}`);
  return { code: match[1].toUpperCase(), location };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const sleep = (ms) => Bun.sleep(ms);
