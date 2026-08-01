import { afmAvailable, afmPromptTurn, resolveAfmBin } from "./afm.ts";
import {
  defaultLabBridgeDescriptor,
  labBridgeAvailable,
  labBridgePromptTurn,
} from "./lab-bridge.ts";
import { fmAvailable, fmPromptTurn, resolveFmBin } from "./fm.ts";
import {
  defaultFmServeSocket,
  fmServeAvailable,
  fmServeHealth,
  fmServePromptTurn,
} from "./fm-serve.ts";
import { runHelperPromptTurn } from "./helper.ts";
import { probeRunning as probeHelperRunning } from "../helper-bootstrap.ts";
import { helperSocketPath } from "../helper-socket.ts";
import { ensureFmServe } from "../serve-bootstrap.ts";
import {
  FmAcpError,
  type BackendId,
  type ModelAvailability,
  type ModelId,
  type PromptTurnRequest,
  type PromptTurnResult,
} from "../types.ts";

export type ResolvedBackends = {
  afmBin: string | null;
  fmBin: string | null;
  preferred: "afm" | "fm" | null;
  helperSocketPath: string;
  helperEnabled: boolean;
  serveSocketPath: string;
  serveEnabled: boolean;
};

export async function resolveBackends(
  preferred: BackendId | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  opts: { probeHelper?: boolean } = {},
): Promise<ResolvedBackends> {
  const afmBin = resolveAfmBin(env);
  const fmBin = resolveFmBin(env);
  let choice: "afm" | "fm" | null = null;
  if (preferred === "afm") choice = afmBin ? "afm" : null;
  else if (preferred === "fm") choice = fmBin ? "fm" : null;
  else choice = afmBin ? "afm" : fmBin ? "fm" : null;
  const sock = helperSocketPath(env);
  const serveSock = defaultFmServeSocket(env);
  const probeHelper = opts.probeHelper ?? true;
  const helperEnabled = probeHelper ? await probeHelperRunning(sock) : false;
  let serveEnabled = false;
  if (opts.probeHelper ?? true) {
    // Happy-path Terminal-hosted serve bootstrap (cua-driver ensure + launch / open -a Terminal).
    const boot = await ensureFmServe({ socketPath: serveSock, env });
    if (boot.status === "started") {
      console.error(`[fm-acp] auto-started fm serve via ${boot.method} at ${boot.socketPath}`);
    } else if (boot.status === "failed") {
      console.error(`[fm-acp] fm serve auto-start failed: ${boot.reason}`);
    }
    const health = await fmServeHealth(serveSock);
    serveEnabled = Boolean(health);
  }
  return {
    afmBin,
    fmBin,
    preferred: choice,
    helperSocketPath: sock,
    helperEnabled,
    serveSocketPath: serveSock,
    serveEnabled,
  };
}

export async function probeAvailability(
  backends: ResolvedBackends,
  signal?: AbortSignal,
): Promise<{ models: ModelAvailability[]; source: "afm" | "fm" | "fm-serve" | "none" }> {
  // Prefer Terminal-hosted fm serve when healthy (validated PCC path).
  if (backends.serveSocketPath) {
    try {
      const models = await fmServeAvailable(backends.serveSocketPath, signal);
      if (models?.length) return { models, source: "fm-serve" };
    } catch (err) {
      console.error("[fm-acp] fm serve available failed:", (err as Error).message);
    }
  }
  // Foundation Lab Agent Bridge (signed app + connection.json) when running.
  try {
    const models = await labBridgeAvailable(defaultLabBridgeDescriptor(), signal);
    if (models?.length) {
      // If Lab advertises pcc runnable, surface that; else still useful for system.
      return { models, source: "afm" };
    }
  } catch (err) {
    console.error("[fm-acp] Lab bridge available failed:", (err as Error).message);
  }
  if (backends.afmBin) {
    try {
      const models = await afmAvailable(backends.afmBin, signal);
      if (models.length) return { models, source: "afm" };
    } catch (err) {
      console.error("[fm-acp] afm available failed:", (err as Error).message);
    }
  }
  if (backends.fmBin) {
    try {
      const models = await fmAvailable(backends.fmBin, signal);
      return { models, source: "fm" };
    } catch (err) {
      console.error("[fm-acp] fm available failed:", (err as Error).message);
    }
  }
  return {
    models: [
      { id: "system", available: true, runnableInCurrentProcess: Boolean(backends.fmBin || backends.afmBin) },
      {
        id: "pcc",
        available: false,
        runnableInCurrentProcess: false,
        reason:
          "Start \`fm serve --socket $FM_ACP_SERVE_SOCK\` in Terminal.app for PCC (see README)",
      },
    ],
    source: "none",
  };
}

function withEmitGuard(req: PromptTurnRequest): {
  req: PromptTurnRequest;
  emitted: () => boolean;
} {
  let emitted = false;
  const original = req.onText;
  return {
    emitted: () => emitted,
    req: {
      ...req,
      onText: original
        ? async (text: string) => {
            if (text) emitted = true;
            await original(text);
          }
        : undefined,
    },
  };
}

export async function runPromptTurn(
  backends: ResolvedBackends,
  req: PromptTurnRequest,
  opts: {
    backendPreference?: BackendId | null;
    bridgeEnabled?: boolean | null;
    helperEnabled?: boolean | null;
  } = {},
): Promise<PromptTurnResult> {
  const pref = opts.backendPreference ?? "auto";
  const model = req.modelId;
  // Note: helper path is legacy; Phase 0 showed Terminal-hosted `fm serve --socket`
  // is the viable PCC transport. Helper remains best-effort only.

  const tryServe = async (turnReq: PromptTurnRequest) => {
    const sock = backends.serveSocketPath || defaultFmServeSocket();
    let health = await fmServeHealth(sock, turnReq.signal);
    if (!health) {
      // Best-effort late bootstrap (default ON; FM_ACP_AUTO_SERVE=0 disables).
      const boot = await ensureFmServe({ socketPath: sock });
      if (boot.status === "started") {
        console.error(`[fm-acp] late-started fm serve via ${boot.method}`);
      }
      health = await fmServeHealth(sock, turnReq.signal);
    }
    if (!health) throw new FmAcpError(`fm serve not reachable at ${sock}`);
    return await fmServePromptTurn(sock, turnReq);
  };

  if (model === "pcc") {
    const tryHelper = async (turnReq: PromptTurnRequest) => {
      if (opts.helperEnabled === false) {
        throw new FmAcpError("helper disabled");
      }
      const sock = backends.helperSocketPath || helperSocketPath();
      if (!(await probeHelperRunning(sock))) {
        throw new FmAcpError("helper not reachable");
      }
      return await runHelperPromptTurn(backends.fmBin, turnReq, {
        socketPath: sock,
        skipBootstrap: true,
      });
    };
    const tryFmWrap = async (turnReq: PromptTurnRequest) => {
      if (!backends.fmBin) {
        throw new FmAcpError("system fm binary not found for fm-wrap PCC path");
      }
      return await fmPromptTurn(backends.fmBin, turnReq);
    };
    const tryBridge = async (turnReq: PromptTurnRequest) => {
      if (opts.bridgeEnabled === false) {
        throw new FmAcpError("afm/Lab bridge disabled");
      }
      // Descriptor HTTP does not require afm binary; CLI bridge does.
      try {
        return await labBridgePromptTurn(turnReq);
      } catch (err) {
        if (turnReq.signal?.aborted) throw err;
        if (!backends.afmBin) throw err;
        console.error("[fm-acp] Lab bridge HTTP failed:", (err as Error).message);
        return await afmPromptTurn(backends.afmBin, turnReq, "bridge");
      }
    };

    const errors: string[] = [];
    // serve-socket first (validated Phase 0); legacy paths after.
    const order =
      pref === "fm"
        ? (["serve", "helper", "fm-wrap"] as const)
        : (["serve", "bridge", "helper", "fm-wrap"] as const);

    for (const pathName of order) {
      const guarded = withEmitGuard(req);
      try {
        if (pathName === "serve") return await tryServe(guarded.req);
        if (pathName === "helper") return await tryHelper(guarded.req);
        if (pathName === "fm-wrap") return await tryFmWrap(guarded.req);
        return await tryBridge(guarded.req);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        // Never switch backends after user-visible output.
        if (guarded.emitted()) throw err;
        const msg = (err as Error).message;
        errors.push(`${pathName}: ${msg}`);
        console.error(`[fm-acp] pcc via ${pathName} failed:`, msg);
      }
    }

    throw new FmAcpError(
      `${errors.join(" | ")}. Start Terminal-hosted \`fm serve --socket\` for PCC (see README).`,
    );
  }

  // system model: serve → afm/fm
  const order: Array<"serve" | "afm" | "fm"> =
    pref === "fm"
      ? ["serve", "fm", "afm"]
      : pref === "afm"
        ? ["serve", "afm", "fm"]
        : backends.preferred === "fm"
          ? ["serve", "fm", "afm"]
          : ["serve", "afm", "fm"];

  const errors: string[] = [];
  for (const backend of order) {
    if (backend === "serve") {
      const guarded = withEmitGuard(req);
      try {
        return await tryServe(guarded.req);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (guarded.emitted()) throw err;
        errors.push(`serve: ${(err as Error).message}`);
        console.error("[fm-acp] fm serve failed:", (err as Error).message);
      }
    }
    if (backend === "afm" && backends.afmBin) {
      const guarded = withEmitGuard(req);
      try {
        return await afmPromptTurn(backends.afmBin, guarded.req, "session");
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (guarded.emitted()) throw err;
        errors.push(`afm: ${(err as Error).message}`);
        console.error("[fm-acp] afm session failed:", (err as Error).message);
      }
    }
    if (backend === "fm" && backends.fmBin) {
      const guarded = withEmitGuard(req);
      try {
        return await fmPromptTurn(backends.fmBin, guarded.req);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (guarded.emitted()) throw err;
        errors.push(`fm: ${(err as Error).message}`);
        console.error("[fm-acp] fm respond failed:", (err as Error).message);
      }
    }
  }

  if (!backends.afmBin && !backends.fmBin) {
    throw new FmAcpError(
      "No Foundation Models CLI found. Install macOS fm (/usr/bin/fm) or afm (`brew tap rudrankriyam/tap && brew install afm`).",
    );
  }
  throw new FmAcpError(errors.join(" | ") || "all backends failed");
}

export function defaultModelFromAvailability(
  models: ModelAvailability[],
  preferred?: ModelId | null,
): ModelId {
  if (preferred === "pcc") {
    const pcc = models.find((m) => m.id === "pcc");
    if (pcc?.runnableInCurrentProcess) return "pcc";
  }
  const system = models.find((m) => m.id === "system");
  if (system?.runnableInCurrentProcess || system?.available) return "system";
  const anyRunnable = models.find((m) => m.runnableInCurrentProcess);
  return anyRunnable?.id ?? "system";
}
