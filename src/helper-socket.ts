import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HELPER_SOCK_ENV = "FM_ACP_HELPER_SOCK";
export const HELPER_LOG_ENV = "FM_ACP_HELPER_LOG";
export const HELPER_PID_ENV = "FM_ACP_HELPER_PID";
export const HELPER_RESET_ENV = "FM_ACP_HELPER_RESET";

/**
 * Resolve the helper socket path. Default: `$XDG_CONFIG_HOME/fm-acp/helper.sock`
 * with a fallback to `~/.config/fm-acp/helper.sock`.
 */
export function helperSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HELPER_SOCK_ENV]?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || os.homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path.join(home, ".config");
  return path.join(base, "fm-acp", "helper.sock");
}

/** Resolve the helper log file path (default: sibling of the socket). */
export function helperLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HELPER_LOG_ENV]?.trim();
  if (override) return override;
  return path.join(path.dirname(helperSocketPath(env)), "helper.log");
}

/** Resolve the helper PID file path. */
export function helperPidPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HELPER_PID_ENV]?.trim();
  if (override) return override;
  return path.join(path.dirname(helperSocketPath(env)), "helper.pid");
}

/** Ensure the directory that holds the socket exists. */
export async function ensureHelperDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = path.dirname(helperSocketPath(env));
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Returns true if the socket file exists. Does not check connection. */
export function socketExists(pathname: string): boolean {
  try {
    return existsSync(pathname);
  } catch {
    return false;
  }
}

/**
 * Detect a stale socket file (process gone, file remains). We can't reliably
 * check the listening process across all systems, so we attempt a non-blocking
 * connect; if it fails with ECONNREFUSED or ENOENT we treat the socket as stale.
 */
export async function isSocketStale(pathname: string): Promise<boolean> {
  if (!existsSync(pathname)) return true;
  const net = await import("node:net");
  return await new Promise<boolean>((resolve) => {
    const sock = net.createConnection(pathname);
    let settled = false;
    const finish = (stale: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(stale);
    };
    sock.once("connect", () => finish(false));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "";
      if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES") {
        finish(true);
      } else {
        // Unknown error — assume not stale to avoid removing a working socket.
        finish(false);
      }
    });
    // Hard ceiling for the probe.
    setTimeout(() => finish(false), 250).unref();
  });
}

/** Remove a stale socket file (idempotent). */
export async function removeStaleSocket(pathname: string): Promise<void> {
  if (!existsSync(pathname)) return;
  try {
    await fsp.unlink(pathname);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
