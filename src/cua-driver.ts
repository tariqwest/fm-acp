import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveBinary, runCommand } from "./process.ts";
import { ensurePrivateDir } from "./private-fs.ts";

export const CUA_DRIVER_INSTALL_URL_ENV = "CUA_DRIVER_INSTALL_URL";
export const CUA_DRIVER_ENSURE_ENV = "FM_ACP_ENSURE_CUA_DRIVER";
export const DEFAULT_CUA_DRIVER_INSTALL_URL = "https://cua.ai/driver/install.sh";

export type CuaDriverEnsureResult =
  | { status: "present"; bin: string }
  | { status: "installed"; bin: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type EnsureCuaDriverOptions = {
  env?: NodeJS.ProcessEnv;
  /** Allow network install when missing. Default: true unless FM_ACP_ENSURE_CUA_DRIVER=0. */
  allowInstall?: boolean | null;
  installUrl?: string;
  /** Preferred bin dir for install (default ~/.local/bin). */
  binDir?: string;
  timeoutMs?: number;
  /** Injectable resolver for tests. */
  resolveBin?: (env: NodeJS.ProcessEnv) => string | null;
  /** Injectable installer for tests. */
  installFn?: (opts: {
    env: NodeJS.ProcessEnv;
    binDir: string;
    installUrl: string;
    timeoutMs: number;
  }) => Promise<void>;
};

function readEnvBoolDefaultTrue(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key]?.trim().toLowerCase();
  if (v == null || v === "") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Well-known locations beyond PATH (official installer defaults). */
export function cuaDriverCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || os.homedir();
  return [
    path.join(home, ".local", "bin", "cua-driver"),
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/opt/homebrew/bin/cua-driver",
    "/usr/local/bin/cua-driver",
  ];
}

export function resolveCuaDriverBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnvOrPath = resolveBinary(["cua-driver"], {
    envPathKeys: ["CUA_DRIVER_BIN", "CUA_DRIVER_PATH"],
    env,
  });
  if (fromEnvOrPath) return fromEnvOrPath;
  for (const candidate of cuaDriverCandidatePaths(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function defaultCuaDriverBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const override =
    env.CUA_DRIVER_BIN_DIR?.trim() ||
    env.CUA_DRIVER_RS_INSTALL_DIR?.trim() ||
    env.CUA_DRIVER_RS_BIN_DIR?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, ".local", "bin");
}

/** Run the official Cua installer non-interactively into binDir. */
export async function installCuaDriver(opts: {
  env?: NodeJS.ProcessEnv;
  binDir?: string;
  installUrl?: string;
  timeoutMs?: number;
}): Promise<void> {
  const env = opts.env ?? process.env;
  const binDir = opts.binDir ?? defaultCuaDriverBinDir(env);
  const installUrl = opts.installUrl ?? env[CUA_DRIVER_INSTALL_URL_ENV]?.trim() ?? DEFAULT_CUA_DRIVER_INSTALL_URL;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  await ensurePrivateDir(binDir);

  // curl | bash with --bin-dir and --no-modify-path (do not rewrite user shell rc).
  const bash = resolveBinary(["bash"], { env }) ?? "/bin/bash";
  const script = [
    `set -euo pipefail`,
    `curl -fsSL ${JSON.stringify(installUrl)} | bash -s -- --bin-dir ${JSON.stringify(binDir)} --no-modify-path`,
  ].join("\n");

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    CUA_DRIVER_NO_MODIFY_PATH: "1",
    CUA_DRIVER_BIN_DIR: binDir,
    CUA_DRIVER_RS_INSTALL_DIR: binDir,
    // Prefer non-interactive defaults if the installer checks these later.
    CI: env.CI ?? "1",
  };

  const result = await runCommand({
    bin: bash,
    args: ["-lc", script],
    env: childEnv,
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 1500);
    throw new Error(detail || `cua-driver install exited ${result.exitCode}`);
  }

  // Sanity: binary should exist after install.
  const bin = path.join(binDir, "cua-driver");
  if (!existsSync(bin)) {
    // Installer may put the CLI only under the app bundle + symlink later.
    const resolved = resolveCuaDriverBin({ ...childEnv, PATH: `${binDir}:${env.PATH ?? ""}` });
    if (!resolved) {
      throw new Error(`cua-driver install finished but binary not found under ${binDir}`);
    }
  } else {
    try {
      await fsp.chmod(bin, 0o755);
    } catch {
      // ignore
    }
  }
}

/**
 * Ensure cua-driver is available for Terminal launch_app (happy path for PCC serve bootstrap).
 * Installs via the official Cua script when missing (unless disabled).
 */
export async function ensureCuaDriver(opts: EnsureCuaDriverOptions = {}): Promise<CuaDriverEnsureResult> {
  const env = opts.env ?? process.env;
  const resolveBin = opts.resolveBin ?? resolveCuaDriverBin;
  const existing = resolveBin(env);
  if (existing) return { status: "present", bin: existing };

  const allowInstall = opts.allowInstall ?? readEnvBoolDefaultTrue(env, CUA_DRIVER_ENSURE_ENV);
  if (!allowInstall) {
    return {
      status: "skipped",
      reason: `cua-driver not found; set ${CUA_DRIVER_ENSURE_ENV}=1 or install from ${DEFAULT_CUA_DRIVER_INSTALL_URL}`,
    };
  }

  if (process.platform !== "darwin" && opts.allowInstall == null) {
    return { status: "skipped", reason: "cua-driver auto-install is only enabled on macOS by default" };
  }

  const binDir = opts.binDir ?? defaultCuaDriverBinDir(env);
  const installUrl =
    opts.installUrl ?? env[CUA_DRIVER_INSTALL_URL_ENV]?.trim() ?? DEFAULT_CUA_DRIVER_INSTALL_URL;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const installFn = opts.installFn ?? ((args) => installCuaDriver(args));

  try {
    await installFn({ env, binDir, installUrl, timeoutMs });
  } catch (err) {
    return { status: "failed", reason: (err as Error).message };
  }

  const after = resolveBin({
    ...env,
    PATH: `${binDir}:${env.PATH ?? ""}`,
  });
  if (!after) {
    return {
      status: "failed",
      reason: `cua-driver install completed but binary still not resolvable (checked ${binDir})`,
    };
  }
  return { status: "installed", bin: after };
}
