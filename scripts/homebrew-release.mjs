#!/usr/bin/env node
/**
 * @deprecated Use `bun scripts/release.mjs` (or `bun run release`).
 * This shim forwards to the coupled release script.
 *
 * Historical default was GitHub+Homebrew; that remains the default of release.mjs.
 * For Homebrew-only: `bun run release -- --homebrew-only`
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "release.mjs");
const forwarded = process.argv.slice(2);
// Preserve old --skip-release meaning (skip github) via release.mjs alias.
const r = spawnSync(process.execPath, [target, ...forwarded], {
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status ?? 1);
