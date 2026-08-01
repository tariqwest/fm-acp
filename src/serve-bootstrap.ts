import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureCuaDriver, resolveCuaDriverBin } from "./cua-driver.ts";
import { ensurePrivateDir } from "./private-fs.ts";
import { defaultFmServeSocket, fmServeHealth, FM_SERVE_SOCK_ENV } from "./backends/fm-serve.ts";

export const AUTO_SERVE_ENV = "FM_ACP_AUTO_SERVE";
export const AUTO_SERVE_TIMEOUT_ENV = "FM_ACP_AUTO_SERVE_TIMEOUT_MS";
export const SERVE_LAUNCHER_ENV = "FM_ACP_SERVE_LAUNCHER";

export type ServeBootstrapResult =
  | { status: "already_running"; socketPath: string }
  | { status: "started"; socketPath: string; method: "cua-driver" | "open-terminal" }
  | { status: "declined"; reason: string }
  | { status: "failed"; reason: string };

export type ServeBootstrapOptions = {
  /** Allow auto-start. Default ON; FM_ACP_AUTO_SERVE=0 disables. */
  auto?: boolean | null;
  socketPath?: string;
  launcherPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable spawner for tests. */
  spawnFn?: typeof spawn;
  /** Injectable health probe for tests. */
  healthFn?: typeof fmServeHealth;
  /** Injectable binary resolver for tests. */
  resolveCuaDriver?: (env: NodeJS.ProcessEnv) => string | null;
  /** Injectable cua-driver ensure for tests. */
  ensureCuaDriverFn?: typeof ensureCuaDriver;
};

/** Default ON; set FM_ACP_AUTO_SERVE=0/false/off to disable. */
function readAutoServeEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key]?.trim().toLowerCase();
  if (v == null || v === "") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function readEnvInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultServeLauncherPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SERVE_LAUNCHER_ENV]?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || os.homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path.join(home, ".config");
  return path.join(base, "fm-acp", "start-fm-serve.command");
}

/** Script body that starts fm serve against the configured socket. */
export function buildServeLauncherScript(socketPath: string, fmBin = "/usr/bin/fm"): string {
  const sock = socketPath.replace(/'/g, `'\"'\"'`);
  const bin = fmBin.replace(/'/g, `'\"'\"'`);
  return [
    "#!/bin/zsh",
    "set -euo pipefail",
    `SOCK='${sock}'`,
    `BIN='${bin}'`,
    'mkdir -p "$(dirname "$SOCK")"',
    'exec "$BIN" serve --socket "$SOCK"',
    "",
  ].join("\n");
}

export async function ensureServeLauncher(opts: {
  socketPath: string;
  launcherPath: string;
  fmBin?: string;
}): Promise<string> {
  await ensurePrivateDir(path.dirname(opts.launcherPath));
  const body = buildServeLauncherScript(opts.socketPath, opts.fmBin ?? "/usr/bin/fm");
  let existing: string | null = null;
  try {
    existing = await fsp.readFile(opts.launcherPath, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== body) {
    await fsp.writeFile(opts.launcherPath, body, { mode: 0o700 });
  }
  try {
    await fsp.chmod(opts.launcherPath, 0o700);
  } catch {
    // ignore
  }
  return opts.launcherPath;
}

export { resolveCuaDriverBin } from "./cua-driver.ts";

function spawnDetached(
  spawner: typeof spawn,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const child = spawner(cmd, args, {
    env,
    stdio: "ignore",
    detached: true,
  }) as ChildProcessWithoutNullStreams;
  child.unref();
  return child;
}

/** cua-driver Terminal launch payload validated in Phase 0. */
export function buildCuaDriverLaunchArgs(launcherPath: string): string[] {
  const payload = {
    bundle_id: "com.apple.Terminal",
    additional_arguments: [launcherPath],
    creates_new_application_instance: true,
  };
  return ["call", "launch_app", JSON.stringify(payload), "--compact"];
}

export async function waitForFmServe(
  socketPath: string,
  timeoutMs: number,
  healthFn: typeof fmServeHealth = fmServeHealth,
  signal?: AbortSignal,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return false;
    const h = await healthFn(socketPath, signal);
    if (h) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return Boolean(await healthFn(socketPath, signal));
}

/**
 * Ensure Terminal-hosted `fm serve --socket` is reachable.
 * Happy path (default ON): ensure cua-driver, then launch Terminal with the serve script.
 * Disable with FM_ACP_AUTO_SERVE=0.
 *
 * Preferred method: cua-driver launch_app Terminal + additional_arguments
 * (validated to yield PCC). Fallback: open -a Terminal <launcher>.
 */
export async function ensureFmServe(opts: ServeBootstrapOptions = {}): Promise<ServeBootstrapResult> {
  const env = opts.env ?? process.env;
  const socketPath = opts.socketPath ?? defaultFmServeSocket(env);
  const launcherPath = opts.launcherPath ?? defaultServeLauncherPath(env);
  const timeoutMs = opts.timeoutMs ?? readEnvInt(env, AUTO_SERVE_TIMEOUT_ENV, 12_000);
  const healthFn = opts.healthFn ?? fmServeHealth;
  const spawner = opts.spawnFn ?? spawn;
  const resolveCua = opts.resolveCuaDriver ?? resolveCuaDriverBin;
  const ensureCua = opts.ensureCuaDriverFn ?? ensureCuaDriver;

  if (await healthFn(socketPath)) {
    return { status: "already_running", socketPath };
  }

  const auto = opts.auto ?? readAutoServeEnabled(env, AUTO_SERVE_ENV);
  if (!auto) {
    return {
      status: "declined",
      reason:
        `fm serve not running at ${socketPath}; start it in Terminal.app, or leave ${AUTO_SERVE_ENV} enabled ` +
        `(default) to auto-launch via cua-driver / open -a Terminal`,
    };
  }

  const fmBin =
    env.FM_BIN_PATH?.trim() ||
    env.FM_BIN?.trim() ||
    (existsSync("/usr/bin/fm") ? "/usr/bin/fm" : "fm");

  try {
    await ensureServeLauncher({ socketPath, launcherPath, fmBin });
  } catch (err) {
    return {
      status: "failed",
      reason: `failed to write serve launcher: ${(err as Error).message}`,
    };
  }

  const errors: string[] = [];

  // 1) Ensure cua-driver (happy path dependency), then launch_app
  let cua = resolveCua(env);
  if (!cua) {
    const ensured = await ensureCua({ env });
    if (ensured.status === "present" || ensured.status === "installed") {
      cua = ensured.bin;
      if (ensured.status === "installed") {
        console.error(`[fm-acp] installed cua-driver at ${ensured.bin}`);
      }
    } else {
      errors.push(`cua-driver: ${ensured.reason}`);
    }
  }
  if (cua) {
    try {
      spawnDetached(spawner, cua, buildCuaDriverLaunchArgs(launcherPath), env);
      if (await waitForFmServe(socketPath, timeoutMs, healthFn)) {
        return { status: "started", socketPath, method: "cua-driver" };
      }
      errors.push(`cua-driver: socket not healthy within ${timeoutMs}ms`);
    } catch (err) {
      errors.push(`cua-driver: ${(err as Error).message}`);
    }
  }

  // 2) open -a Terminal (also validated)
  try {
    spawnDetached(spawner, "open", ["-a", "Terminal", launcherPath], env);
    if (await waitForFmServe(socketPath, timeoutMs, healthFn)) {
      return { status: "started", socketPath, method: "open-terminal" };
    }
    errors.push(`open -a Terminal: socket not healthy within ${timeoutMs}ms`);
  } catch (err) {
    errors.push(`open -a Terminal: ${(err as Error).message}`);
  }

  return {
    status: "failed",
    reason: `${errors.join(" | ")}. Manual: open -a Terminal '${launcherPath}' (with ${FM_SERVE_SOCK_ENV}=${socketPath})`,
  };
}
