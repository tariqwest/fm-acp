import { afmAvailable, afmPromptTurn, resolveAfmBin } from "./afm.ts";
import { fmAvailable, fmPromptTurn, resolveFmBin } from "./fm.ts";
import {
  ensureFmAccessServe,
  fmAccessAvailable,
  fmAccessPromptTurn,
  probeFmAccessServeHealth,
  resolveFmAccessServeSocket,
} from "./fm-access-pcc.ts";
import { runHelperPromptTurn } from "./helper.ts";
import { probeRunning as probeHelperRunning } from "../helper-bootstrap.ts";
import { helperSocketPath } from "../helper-socket.ts";
import { applyFmAccessPccEnvBridge } from "../env-bridge.ts";
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
  applyFmAccessPccEnvBridge(env);
  const afmBin = resolveAfmBin(env);
  const fmBin = resolveFmBin(env);
  let choice: "afm" | "fm" | null = null;
  if (preferred === "afm") choice = afmBin ? "afm" : null;
  else if (preferred === "fm") choice = fmBin ? "fm" : null;
  else choice = afmBin ? "afm" : fmBin ? "fm" : null;
  const sock = helperSocketPath(env);
  const serveSock = resolveFmAccessServeSocket(env);
  const probeHelper = opts.probeHelper ?? true;
  const helperEnabled = probeHelper ? await probeHelperRunning(sock) : false;
  let serveEnabled = false;
  if (opts.probeHelper ?? true) {
    const boot = await ensureFmAccessServe({ socketPath: serveSock, env });
    if (boot.status === "started") {
      console.error(
        `[fm-acp] auto-started fm serve via fm-access-pcc (${boot.method}) at ${boot.socketPath}`,
      );
    } else if (boot.status === "failed") {
      console.error(`[fm-acp] fm serve auto-start failed: ${boot.reason}`);
    }
    serveEnabled = await probeFmAccessServeHealth(serveSock);
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
): Promise<{
  models: ModelAvailability[];
  source: "afm" | "fm" | "fm-serve" | "none";
}> {
  try {
    const access = await fmAccessAvailable(signal);
    if (access.source === "fm-serve" || access.models.some((m) => m.id === "pcc" && m.available)) {
      return { models: access.models, source: "fm-serve" };
    }
    if (access.source === "lab-bridge" && access.models.length) {
      return { models: access.models, source: "afm" };
    }
  } catch (err) {
    console.error("[fm-acp] fm-access-pcc available failed:", (err as Error).message);
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
      {
        id: "system",
        available: true,
        runnableInCurrentProcess: Boolean(backends.fmBin || backends.afmBin),
      },
      {
        id: "pcc",
        available: false,
        runnableInCurrentProcess: false,
        reason:
          "Start Terminal-hosted `fm serve --socket $FM_ACP_SERVE_SOCK` for PCC (fm-access-pcc)",
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

  const tryAccess = async (turnReq: PromptTurnRequest) => {
    return await fmAccessPromptTurn(turnReq, { bridgeEnabled: opts.bridgeEnabled });
  };

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

  if (model === "pcc") {
    const errors: string[] = [];
    const order = ["access", "helper"] as const;

    for (const pathName of order) {
      const guarded = withEmitGuard(req);
      try {
        if (pathName === "access") return await tryAccess(guarded.req);
        return await tryHelper(guarded.req);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (guarded.emitted()) throw err;
        const msg = (err as Error).message;
        errors.push(`${pathName}: ${msg}`);
        console.error(`[fm-acp] pcc via ${pathName} failed:`, msg);
      }
    }

    throw new FmAcpError(
      `${errors.join(" | ")}. PCC requires Terminal-hosted \`fm serve\` via fm-access-pcc (see README).`,
    );
  }

  const order: Array<"access" | "afm" | "fm"> =
    pref === "fm"
      ? ["access", "fm", "afm"]
      : pref === "afm"
        ? ["access", "afm", "fm"]
        : backends.preferred === "fm"
          ? ["access", "fm", "afm"]
          : ["access", "afm", "fm"];

  const errors: string[] = [];
  for (const backend of order) {
    if (backend === "access") {
      const cliOnly =
        Boolean(req.transcriptPath) ||
        Boolean(req.useCase) ||
        Boolean(req.guardrails) ||
        Boolean(req.images?.length);
      if (cliOnly) continue;
      const guarded = withEmitGuard(req);
      try {
        return await tryAccess(guarded.req);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (guarded.emitted()) throw err;
        errors.push(`fm-access-pcc: ${(err as Error).message}`);
        console.error("[fm-acp] fm-access-pcc failed:", (err as Error).message);
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
