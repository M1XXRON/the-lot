// Гейт перед выкладкой: типы → экономика → HTTP-e2e → (если есть) UI-e2e.
import { existsSync } from "node:fs";

const steps = [];
const run = async (name, command) => {
  const started = Date.now();
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "inherit", stderr: "inherit", env: process.env });
  const code = await proc.exited;
  steps.push({ name, code, ms: Date.now() - started });
  if (code !== 0) throw new Error(`${name}: код ${code}`);
};

console.log("• типы (tsc --noEmit)");
await run("types", ["bunx", "tsc", "--noEmit"]);

console.log("• нормы оценивания (norms-check)");
await run("norms", ["bun", "tools/norms-check.mjs"]);

console.log("• экономика (balance-sim)");
await run("sim", ["bun", "tools/balance-sim.mjs"]);

console.log("• HTTP-e2e");
await run("http", ["bun", "tools/http-e2e.mjs"]);

const playwright =
  process.env.PLAYWRIGHT_PATH ||
  (existsSync("/Users/apple/dev/tools/node_modules/playwright/index.mjs")
    ? "/Users/apple/dev/tools/node_modules/playwright/index.mjs"
    : "");
if (playwright) {
  console.log("• UI-e2e (два браузера)");
  await run("ui", ["bun", "tools/ui-e2e.mjs"]);
} else {
  console.log("• UI-e2e пропущен: playwright не найден");
}

console.log("\nитог:");
for (const step of steps) console.log(`  ✓ ${step.name.padEnd(6)} ${String(step.ms).padStart(5)} мс`);
