import { client, roomCodeFrom, startServer } from "./lib.mjs";
const server = await startServer({ mock: true });
const host = client(server.base);
const created = await host.form("/act/create", { mode: "local", name: "ALEX" });
const { code } = roomCodeFrom(created);
const page = await host.get(`/r/${code}`);
console.log("локально:", [...page.headers].filter(([k]) => /etag|cache-control/i.test(k)));
await server.stop();
