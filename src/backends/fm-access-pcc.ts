import {
  defaultFmServeSocket,
  ensureFmServe,
  fmServeHealth,
  transportChatCompletion,
  transportGetAvailableModels,
  transportRespond,
  type ServeBootstrapResult,
} from "fm-access-pcc";
import { applyFmAccessPccEnvBridge, withLabBridgeEnv } from "../env-bridge.ts";
import {
  FmAcpError,
  type ModelAvailability,
  type PromptTurnRequest,
  type PromptTurnResult,
} from "../types.ts";

export type { ServeBootstrapResult };

function mapBackend(
  backend: "fm-serve" | "fm" | "lab-bridge" | undefined,
): PromptTurnResult["backend"] {
  if (backend === "lab-bridge") return "afm-bridge";
  if (backend === "fm") return "fm";
  return "fm-serve";
}

export function resolveFmAccessServeSocket(env: NodeJS.ProcessEnv = process.env): string {
  applyFmAccessPccEnvBridge(env);
  return defaultFmServeSocket(env);
}

export async function ensureFmAccessServe(
  opts: {
    socketPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ServeBootstrapResult> {
  const env = opts.env ?? process.env;
  applyFmAccessPccEnvBridge(env);
  return ensureFmServe({
    socketPath: opts.socketPath ?? defaultFmServeSocket(env),
    env,
  });
}

export async function probeFmAccessServeHealth(
  socketPath?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  applyFmAccessPccEnvBridge();
  const sock = socketPath ?? defaultFmServeSocket();
  const health = await fmServeHealth(sock, signal);
  return Boolean(health);
}

export async function fmAccessAvailable(signal?: AbortSignal): Promise<{
  models: ModelAvailability[];
  source: "fm-serve" | "lab-bridge" | "none";
}> {
  applyFmAccessPccEnvBridge();
  try {
    const models = await transportGetAvailableModels(undefined, signal);
    if (!models.length) {
      return {
        models: [
          { id: "system", available: true, runnableInCurrentProcess: true },
          {
            id: "pcc",
            available: false,
            runnableInCurrentProcess: false,
            reason: "Start Terminal-hosted `fm serve --socket` for PCC (via fm-access-pcc)",
          },
        ],
        source: "none",
      };
    }
    const mapped: ModelAvailability[] = models.map((m) => ({
      id: m.model,
      available: Boolean(m.available),
      runnableInCurrentProcess: Boolean(m.available),
      reason: m.reason ?? null,
    }));
    const src = models.find((m) => m.source)?.source;
    if (src === "lab-bridge") return { models: mapped, source: "lab-bridge" };
    if (src === "fm-serve" || mapped.some((m) => m.available && m.id === "pcc")) {
      return { models: mapped, source: "fm-serve" };
    }
    return { models: mapped, source: "none" };
  } catch (err) {
    console.error("[fm-acp] fm-access-pcc availability failed:", (err as Error).message);
    return {
      models: [
        { id: "system", available: true, runnableInCurrentProcess: true },
        {
          id: "pcc",
          available: false,
          runnableInCurrentProcess: false,
          reason: (err as Error).message,
        },
      ],
      source: "none",
    };
  }
}

function historyForAccess(req: PromptTurnRequest): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  for (const h of req.history ?? []) {
    if (h.role === "system" || h.role === "user" || h.role === "assistant") {
      out.push({ role: h.role, content: h.text });
    }
  }
  return out;
}

/**
 * PCC + serve path owned by fm-access-pcc (Terminal-hosted fm serve, optional Lab bridge).
 */
export async function fmAccessPromptTurn(
  req: PromptTurnRequest,
  opts: { bridgeEnabled?: boolean | null } = {},
): Promise<PromptTurnResult> {
  applyFmAccessPccEnvBridge();
  const restore = withLabBridgeEnv(opts.bridgeEnabled);

  try {
    const images =
      req.images?.map((img) => ({
        path: img.path,
        label: img.label,
      })) ?? undefined;

    const hasCliOnly =
      Boolean(req.transcriptPath) ||
      Boolean(req.useCase) ||
      Boolean(req.guardrails) ||
      Boolean(images?.length);

    if (!hasCliOnly) {
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
      if (req.instructions) {
        messages.push({ role: "system", content: req.instructions });
      }
      messages.push(...historyForAccess(req));
      messages.push({ role: "user", content: req.prompt || "Describe the image(s)." });

      let assembled = "";
      const result = await transportChatCompletion({
        model: req.modelId,
        messages,
        stream: Boolean(req.onText),
        signal: req.signal,
        onText: req.onText
          ? async (chunk) => {
              if (!chunk) return;
              assembled += chunk;
              await req.onText?.(chunk);
            }
          : undefined,
      });
      const text = result.text || assembled;
      if (!text) throw new FmAcpError("fm-access-pcc returned empty response");
      if (!assembled && text) await req.onText?.(text);
      return { text, backend: mapBackend(result.backend) };
    }

    const result = await transportRespond(req.prompt || "Describe the image(s).", {
      model: req.modelId,
      instructions: req.instructions ?? undefined,
      greedy: req.greedy ?? undefined,
      useCase: req.useCase ?? undefined,
      guardrails: req.guardrails ?? undefined,
      transcript: req.transcriptPath ?? undefined,
      saveTranscript: req.transcriptPath ?? undefined,
      images,
      history: historyForAccess(req),
      stream: false,
      signal: req.signal,
    });

    if (!result.text) throw new FmAcpError("fm-access-pcc returned empty response");
    await req.onText?.(result.text);
    return {
      text: result.text,
      backend: mapBackend(result.backend),
      transcriptPath: req.transcriptPath ?? null,
    };
  } catch (err) {
    if (err instanceof FmAcpError) throw err;
    throw new FmAcpError((err as Error).message || String(err));
  } finally {
    restore();
  }
}
