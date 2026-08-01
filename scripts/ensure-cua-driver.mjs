#!/usr/bin/env node
/**
 * Best-effort cua-driver ensure for pnpm/npm install.
 * Never fails the package install (network / non-darwin / offline).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function main() {
  if (process.env.FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL === "1") {
    console.error("[fm-acp] skip cua-driver postinstall (FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL=1)");
    return;
  }
  if (process.platform !== "darwin") {
    console.error("[fm-acp] skip cua-driver postinstall on non-darwin");
    return;
  }

  // Prefer tsx path used by the package; fall back to node --experimental-strip-types if needed.
  const entry = path.join(root, "scripts", "ensure-cua-driver-run.mjs");
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout?.trim()) process.stdout.write(result.stdout);
  if (result.stderr?.trim()) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(
      `[fm-acp] cua-driver ensure exited ${result.status ?? "null"} (non-fatal). Install manually: curl -fsSL https://cua.ai/driver/install.sh | bash`,
    );
  }
}

// silence unused in some bundlers
void require;
main();
