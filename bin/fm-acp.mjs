#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "../src/index.ts");
const tsxImport = require.resolve("tsx/esm");

const child = spawn(
  process.execPath,
  ["--import", tsxImport, entry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.on("error", (err) => {
  console.error("[fm-acp] failed to start:", err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
