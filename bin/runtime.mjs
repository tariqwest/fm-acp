/**
 * Shared process launcher for fm-acp CLIs.
 *
 * Preference order:
 * 1. Bun (dev + preferred release runtime)
 * 2. Node + tsx (npm/npx and environments without Bun)
 *
 * Override with FM_ACP_RUNTIME=bun|node
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function which(bin, env = process.env) {
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBun(env = process.env) {
  const override = env.BUN_BIN?.trim() || env.BUN_PATH?.trim();
  if (override && existsSync(override)) return override;
  return which("bun", env);
}

function resolveTsxImport() {
  try {
    return require.resolve("tsx/esm");
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.entry Absolute path to TS/JS entry
 * @param {string[]} [opts.argv] Extra argv after entry
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {"inherit"|"pipe"} [opts.stdio]
 */
export function launchEntry(opts) {
  const env = opts.env ?? process.env;
  const prefer = (env.FM_ACP_RUNTIME ?? "").trim().toLowerCase();
  const argv = opts.argv ?? process.argv.slice(2);
  const bun = resolveBun(env);
  const tsxImport = resolveTsxImport();

  /** @type {{ bin: string, args: string[], runtime: "bun"|"node" } | null} */
  let plan = null;

  if (prefer === "node") {
    if (!tsxImport) {
      console.error("[fm-acp] FM_ACP_RUNTIME=node requires the tsx package");
      process.exit(1);
    }
    plan = {
      bin: process.execPath,
      args: ["--import", tsxImport, opts.entry, ...argv],
      runtime: "node",
    };
  } else if (prefer === "bun") {
    if (!bun) {
      console.error("[fm-acp] FM_ACP_RUNTIME=bun but bun was not found on PATH");
      process.exit(1);
    }
    plan = { bin: bun, args: [opts.entry, ...argv], runtime: "bun" };
  } else if (bun) {
    plan = { bin: bun, args: [opts.entry, ...argv], runtime: "bun" };
  } else if (tsxImport) {
    plan = {
      bin: process.execPath,
      args: ["--import", tsxImport, opts.entry, ...argv],
      runtime: "node",
    };
  } else {
    console.error(
      "[fm-acp] no runtime available: install Bun (preferred) or keep the tsx dependency for Node",
    );
    process.exit(1);
  }

  if (env.FM_ACP_DEBUG_RUNTIME === "1") {
    console.error(`[fm-acp] runtime=${plan.runtime} bin=${plan.bin}`);
  }

  const child = spawn(plan.bin, plan.args, {
    stdio: opts.stdio ?? "inherit",
    env,
  });

  child.on("error", (err) => {
    console.error(`[fm-acp] failed to start via ${plan.runtime}:`, err.message);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
      return;
    }
    process.exit(code ?? 1);
  });

  return child;
}

export function packageRootFrom(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

/** Sync probe used by tests/scripts. */
export function detectRuntime(env = process.env) {
  const prefer = (env.FM_ACP_RUNTIME ?? "").trim().toLowerCase();
  const bun = resolveBun(env);
  const tsx = !!resolveTsxImport();
  if (prefer === "node") return tsx ? "node" : null;
  if (prefer === "bun") return bun ? "bun" : null;
  if (bun) return "bun";
  if (tsx) return "node";
  return null;
}

export function bunAvailable(env = process.env) {
  return Boolean(resolveBun(env));
}

/** Run a one-shot command with preferred runtime (for internal tooling). */
export function runWithPreferredRuntime(entry, argv = [], env = process.env) {
  const runtime = detectRuntime(env);
  if (runtime === "bun") {
    const bun = resolveBun(env);
    return spawnSync(bun, [entry, ...argv], { encoding: "utf8", env, stdio: "inherit" });
  }
  if (runtime === "node") {
    const tsxImport = resolveTsxImport();
    return spawnSync(process.execPath, ["--import", tsxImport, entry, ...argv], {
      encoding: "utf8",
      env,
      stdio: "inherit",
    });
  }
  throw new Error("no runtime");
}
