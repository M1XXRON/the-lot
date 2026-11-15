#!/usr/bin/env bun
// Снимки UI: переиспользует сценарий ui-e2e, чтобы картинки всегда были свежими.
// Результат — screenshots/*.png (десктоп, телефон, 320px).
import { mkdirSync } from "node:fs";

const out = process.env.SHOTS_DIR ?? "screenshots";
mkdirSync(out, { recursive: true });

const proc = Bun.spawn(["bun", "tools/ui-e2e.mjs"], {
  cwd: process.cwd(),
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, SHOTS_DIR: out },
});

const code = await proc.exited;
if (code !== 0) process.exit(code);
console.log(`снимки обновлены: ${out}`);
