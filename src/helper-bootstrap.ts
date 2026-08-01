import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureHelperDir,
  helperLogPath,
  helperPidPath,
  helperSocketPath,
  isSocketStale,
  removeStaleSocket,
  socketExists,
} from "./helper-socket.ts";

export const HELPER_AUTOSTART_ENV = "FM_ACP_AUTO_BOOTSTRAP";

export type EnsureResult =
  | { status: "already_running"; socketPath: string }
  | { status: "started"; socketPath: string; pid: number | null }
  | { status: "declined"; reason: string }
  | { status: "failed"; reason: string };

export type EnsureOptions = {
  /** Allow auto-launch via osascript. Default reads `FM_ACP_AUTO_BOOTSTRAP`. */
  auto?: boolean | null;
  /** Override the helper binary path (defaults to the package-relative bin). */
  helperBin?: string | null;
  /** Maximum time to wait for the socket to appear after launch. */
  timeoutMs?: number;
  /** Override the env used for resolution / AppleScript invocation. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the spawner used for AppleScript. Defaults to `spawn("osascript", ...)`.
   * Tests supply a fake to assert script construction.
   */
  spawnOsascript?: typeof spawn;
};

function readEnvBool(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readEnvInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the AppleScript payload that asks Terminal.app to launch the helper
 * in a new window. The `do script` form is the official, user-permitted
 * mechanism for spawning under Terminal.app — there is no process lineage
 * spoofing involved.
 */
export function buildAppleScript(opts: {
  helperBin: string;
  socketPath: string;
  logPath: string;
  pidPath: string;
  env: NodeJS.ProcessEnv;
}): string {
  // Single Terminal launch only. A previous dual path also ran `do shell script
  // nohup`, which spawned a second helper outside Terminal ancestry and raced
  // the socket. Phase 0 also showed osascript do-script is fragile; callers
  // should prefer manual start or `open -a Terminal` wrappers.
  const asEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Quote paths for the shell that Terminal's `do script` runs.
  const shQuote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
  const helperBin = shQuote(opts.helperBin);
  const logPath = shQuote(opts.logPath);
  const pidPath = shQuote(opts.pidPath);
  const cmd = `echo $$ > ${pidPath}; exec ${helperBin} >> ${logPath} 2>&1`;
  return [
    'tell application "Terminal"',
    "  activate",
    `  do script "${asEscape(cmd)}"`,
    "end tell",
  ].join("\n");
}

export async function probeRunning(socketPath: string): Promise<boolean> {
  if (!socketExists(socketPath)) return false;
  if (await isSocketStale(socketPath)) return false;
  return true;
}

/**
 * Wait until the helper socket becomes live (or timeout). Returns true on live.
 */
export async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return false;
    if (await probeRunning(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return await probeRunning(socketPath);
}

/** Default helper binary path resolution: looks for the bin shipped by us. */
export function defaultHelperBin(): string {
  // Resolve from this file's location to the package bin.
  // src/helper-bootstrap.ts → ../bin/fm-acp-terminal-helper.mjs
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidate = path.resolve(here, "..", "bin", "fm-acp-terminal-helper.mjs");
  return candidate;
}

/**
 * Ensure the helper is reachable. If not, optionally auto-launch via
 * AppleScript so the helper appears under Terminal.app.
 */
export async function ensureHelper(opts: EnsureOptions = {}): Promise<EnsureResult> {
  const env = opts.env ?? process.env;
  const socketPath = helperSocketPath(env);
  const logPath = helperLogPath(env);
  const pidPath = helperPidPath(env);
  const helperBin = opts.helperBin ?? defaultHelperBin();

  if (!existsSync(helperBin)) {
    return {
      status: "failed",
      reason: `helper binary not found at ${helperBin}`,
    };
  }

  await ensureHelperDir(env);

  if (await probeRunning(socketPath)) {
    return { status: "already_running", socketPath };
  }

  // Stale socket? Remove before binding.
  if (socketExists(socketPath)) {
    await removeStaleSocket(socketPath);
  }

  const auto = opts.auto ?? readEnvBool(env, HELPER_AUTOSTART_ENV);
  if (!auto) {
    return {
      status: "declined",
      reason:
        `helper not running at ${socketPath}; run \`fm-acp-terminal-helper\` inside Terminal.app, ` +
        `or set ${HELPER_AUTOSTART_ENV}=1 to allow auto-launch via AppleScript`,
    };
  }

  // Build AppleScript payload and launch Terminal.app.
  const script = buildAppleScript({ helperBin, socketPath, logPath, pidPath, env });
  const spawner = opts.spawnOsascript ?? spawn;
  const child = spawner("osascript", ["-e", script], {
    stdio: "ignore",
    env,
    detached: true,
  });

  const timeoutMs = opts.timeoutMs ?? readEnvInt(env, "FM_ACP_AUTO_BOOTSTRAP_TIMEOUT_MS", 5000);
  const live = await waitForSocket(socketPath, timeoutMs);
  if (!live) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    return {
      status: "failed",
      reason: `AppleScript launched but helper socket at ${socketPath} never appeared within ${timeoutMs}ms; check ${logPath}`,
    };
  }

  // Best-effort PID readback. Not fatal if missing.
  let pid: number | null = null;
  try {
    const raw = await fsp.readFile(pidPath, "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n > 0) pid = n;
  } catch {
    pid = null;
  }

  return { status: "started", socketPath, pid };
}

/**
 * Helper used by tests / diagnostics: returns a snapshot of the helper
 * environment without mutating anything.
 */
export function helperSnapshot(env: NodeJS.ProcessEnv = process.env) {
  return {
    socketPath: helperSocketPath(env),
    logPath: helperLogPath(env),
    pidPath: helperPidPath(env),
    home: env.HOME?.trim() || os.homedir(),
    autoBootstrap: readEnvBool(env, HELPER_AUTOSTART_ENV),
  };
}
