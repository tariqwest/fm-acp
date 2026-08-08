import os from "node:os";
import path from "node:path";

/**
 * Bridge fm-acp env vars onto fm-access-pcc so the shared library owns
 * Terminal-hosted `fm serve` / PCC transport while this package keeps
 * FM_ACP_* names and ~/.config/fm-acp defaults.
 */
export function applyFmAccessPccEnvBridge(env: NodeJS.ProcessEnv = process.env): void {
  const home = env.HOME?.trim() || os.homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configRoot = xdg || path.join(home, ".config");
  const fmAcpDir = path.join(configRoot, "fm-acp");

  const pairs: Array<[string, string]> = [
    ["FM_ACP_SERVE_SOCK", "FM_ACCESS_PCC_SERVE_SOCK"],
    ["FM_ACP_AUTO_SERVE", "FM_ACCESS_PCC_AUTO_SERVE"],
    ["FM_ACP_AUTO_SERVE_TIMEOUT_MS", "FM_ACCESS_PCC_AUTO_SERVE_TIMEOUT_MS"],
    ["FM_ACP_SERVE_LAUNCHER", "FM_ACCESS_PCC_SERVE_LAUNCHER"],
    ["FM_ACP_ENSURE_CUA_DRIVER", "FM_ACCESS_PCC_ENSURE_CUA_DRIVER"],
    ["FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL", "FM_ACCESS_PCC_SKIP_CUA_DRIVER_POSTINSTALL"],
  ];

  for (const [from, to] of pairs) {
    const src = env[from]?.trim();
    if (src && !env[to]?.trim()) {
      env[to] = src;
    }
  }

  // Prefer this package's config dir when the library would otherwise use
  // ~/.config/fm-access-pcc (keeps existing fm-acp operators stable).
  if (!env.FM_ACCESS_PCC_SERVE_SOCK?.trim()) {
    env.FM_ACCESS_PCC_SERVE_SOCK = path.join(fmAcpDir, "fm.sock");
  }
  if (!env.FM_ACCESS_PCC_SERVE_LAUNCHER?.trim()) {
    env.FM_ACCESS_PCC_SERVE_LAUNCHER = path.join(fmAcpDir, "start-fm-serve.command");
  }

  // Mirror resolved paths back so local docs/tools still see FM_ACP_*.
  if (!env.FM_ACP_SERVE_SOCK?.trim()) {
    env.FM_ACP_SERVE_SOCK = env.FM_ACCESS_PCC_SERVE_SOCK;
  }
  if (!env.FM_ACP_SERVE_LAUNCHER?.trim()) {
    env.FM_ACP_SERVE_LAUNCHER = env.FM_ACCESS_PCC_SERVE_LAUNCHER;
  }
}

export function withLabBridgeEnv(
  enabled: boolean | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  if (enabled === null || enabled === undefined) {
    return () => undefined;
  }
  const key = "FM_ACCESS_PCC_LAB_BRIDGE";
  const prev = env[key];
  env[key] = enabled ? "1" : "0";
  return () => {
    if (prev === undefined) delete env[key];
    else env[key] = prev;
  };
}
