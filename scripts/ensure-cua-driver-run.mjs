#!/usr/bin/env node
/**
 * Lightweight ensure runner used by postinstall (no tsx required).
 * Mirrors src/cua-driver.ts install path enough for bootstrap.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "https://cua.ai/driver/install.sh";

function which(bin) {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveCua() {
  for (const key of ["CUA_DRIVER_BIN", "CUA_DRIVER_PATH"]) {
    const v = process.env[key]?.trim();
    if (v && existsSync(v)) return v;
  }
  const fromPath = which("cua-driver");
  if (fromPath) return fromPath;
  const home = process.env.HOME?.trim() || os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "cua-driver"),
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/opt/homebrew/bin/cua-driver",
    "/usr/local/bin/cua-driver",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function main() {
  const existing = resolveCua();
  if (existing) {
    console.error(`[fm-acp] cua-driver present: ${existing}`);
    process.exit(0);
  }

  const disabled = ["0", "false", "no", "off"].includes(
    String(process.env.FM_ACP_ENSURE_CUA_DRIVER ?? "1").toLowerCase(),
  );
  if (disabled) {
    console.error("[fm-acp] cua-driver missing; ensure disabled (FM_ACP_ENSURE_CUA_DRIVER=0)");
    process.exit(0);
  }

  const home = process.env.HOME?.trim() || os.homedir();
  const binDir =
    process.env.CUA_DRIVER_BIN_DIR?.trim() ||
    process.env.CUA_DRIVER_RS_INSTALL_DIR?.trim() ||
    path.join(home, ".local", "bin");
  const url = process.env.CUA_DRIVER_INSTALL_URL?.trim() || DEFAULT_URL;
  const bash = which("bash") || "/bin/bash";
  const script = `set -euo pipefail; curl -fsSL ${JSON.stringify(url)} | bash -s -- --bin-dir ${JSON.stringify(binDir)} --no-modify-path`;

  console.error(`[fm-acp] installing cua-driver into ${binDir} …`);
  const result = spawnSync(bash, ["-lc", script], {
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
      CUA_DRIVER_NO_MODIFY_PATH: "1",
      CUA_DRIVER_BIN_DIR: binDir,
      CUA_DRIVER_RS_INSTALL_DIR: binDir,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout?.trim()) process.stdout.write(result.stdout);
  if (result.stderr?.trim()) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`[fm-acp] cua-driver install failed (exit ${result.status ?? "null"})`);
    process.exit(result.status ?? 1);
  }
  const after = resolveCua();
  if (!after) {
    console.error("[fm-acp] cua-driver install finished but binary not found");
    process.exit(1);
  }
  console.error(`[fm-acp] cua-driver ready: ${after}`);
}

main();
