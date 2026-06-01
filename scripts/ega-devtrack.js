#!/usr/bin/env node

/**
 * ega-devtrack CLI wrapper.
 *
 * Invokes the TypeScript source via tsx.
 * Usage: node scripts/ega-devtrack.js <command> [options]
 *
 * See scripts/ega-devtrack.ts for implementation.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

const tsScript = path.join(__dirname, "ega-devtrack.ts");
const args = process.argv.slice(2);

const result = spawnSync("npx", ["tsx", tsScript, ...args], {
  stdio: "inherit",
  cwd: path.resolve(__dirname, ".."),
  shell: true,
});

process.exit(result.status ?? 1);
