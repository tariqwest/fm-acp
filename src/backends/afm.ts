import { extractCliError, parseExtraArgs, resolveBinary, runCommand } from "../process.ts";
import {
  FmAcpError,
  type ModelAvailability,
  type ModelId,
  type PromptTurnRequest,
  type PromptTurnResult,
} from "../types.ts";

export function resolveAfmBin(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveBinary(["afm"], {
    envPathKeys: ["AFM_BIN_PATH", "AFM_BIN"],
    env,
  });
}

export function buildAfmSessionStreamArgs(opts: {
  prompt: string;
  modelId: ModelId;
  instructions?: string | null;
  useCase?: string | null;
  guardrails?: string | null;
  history?: Array<{ role: string; text: string }>;
}): string[] {
  // Multi-turn via session chat when history exists; otherwise stream one shot.
  const hasHistory = Boolean(opts.history?.length);
  if (hasHistory) {
    const args = ["session", "chat", "--stream", "--output", "json"];
    if (opts.instructions) args.push("--system-prompt", opts.instructions);
    if (opts.useCase) args.push("--use-case", opts.useCase);
    if (opts.guardrails) args.push("--guardrails", opts.guardrails);
    // afm session chat takes repeated --message; include prior user/assistant as messages
    // then the new prompt. Model routing for pcc is via bridge, not session.
    for (const msg of opts.history ?? []) {
      if (msg.role === "user" || msg.role === "assistant") {
        args.push("--message", `${msg.role === "assistant" ? "[assistant] " : ""}${msg.text}`);
      }
    }
    args.push("--message", opts.prompt);
    return args;
  }

  const args = ["session", "stream", "--output", "json", "--prompt", opts.prompt];
  if (opts.instructions) args.push("--system-prompt", opts.instructions);
  if (opts.useCase) args.push("--use-case", opts.useCase);
  if (opts.guardrails) args.push("--guardrails", opts.guardrails);
  return args;
}

export function buildAfmBridgeChatArgs(opts: {
  prompt: string;
  modelId: ModelId;
}): string[] {
  return ["bridge", "chat", "--model", opts.modelId, "--prompt", opts.prompt, "--output", "json"];
}

export function buildAfmAvailableArgs(model?: ModelId): string[] {
  const args = ["available", "--output", "json"];
  if (model) args.push("--model", model === "system" ? "on-device" : "pcc");
  return args;
}

/** Parse NDJSON stream events from afm session stream/chat --output json. */
export function parseAfmNdjsonEvents(chunk: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of chunk.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      events.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      // partial line — ignore
    }
  }
  return events;
}

export function extractAfmDeltaText(event: Record<string, unknown>): string {
  const type = String(event.type ?? event.event ?? "");
  if (type === "delta" || type.endsWith("delta")) {
    const content = event.content;
    if (typeof content === "string") return content;
    if (content && typeof content === "object") {
      const c = content as Record<string, unknown>;
      if (typeof c.text === "string") return c.text;
      if (typeof c.delta === "string") return c.delta;
      if (typeof c.response === "string") return c.response;
    }
    if (typeof event.text === "string") return event.text;
    if (typeof event.delta === "string") return event.delta;
  }
  return "";
}

export function extractAfmFinalText(stdout: string): string {
  // Prefer last completed payload with response field.
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (typeof obj.response === "string" && obj.response) last = obj.response;
      const content = obj.content;
      if (content && typeof content === "object") {
        const c = content as Record<string, unknown>;
        if (typeof c.response === "string" && c.response) last = c.response;
      }
      const type = String(obj.type ?? obj.event ?? "");
      if ((type === "completed" || type === "session_completed") && typeof obj.response === "string") {
        last = obj.response;
      }
    } catch {
      // ignore
    }
  }
  if (last) return last;

  // Non-stream JSON object
  try {
    const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof obj.response === "string") return obj.response;
  } catch {
    // ignore
  }
  return stdout.trim();
}

export function parseAfmAvailability(stdout: string): ModelAvailability[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const models = Array.isArray(obj.models) ? obj.models : Array.isArray(obj) ? obj : [];
    const out: ModelAvailability[] = [];
    for (const raw of models) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const idRaw = String(m.id ?? m.runtime ?? "").toLowerCase();
      let id: ModelId | null = null;
      if (idRaw.includes("pcc") || idRaw.includes("private")) id = "pcc";
      else if (idRaw.includes("system") || idRaw.includes("on-device") || idRaw.includes("ondevice")) {
        id = "system";
      }
      if (!id) continue;
      out.push({
        id,
        available: Boolean(m.isAvailable ?? m.available),
        runnableInCurrentProcess: Boolean(
          m.isRunnableInCurrentProcess ?? m.runnableInCurrentProcess ?? m.isAvailable ?? m.available,
        ),
        reason:
          typeof m.reason === "string"
            ? m.reason
            : m.reason && typeof m.reason === "object"
              ? JSON.stringify(m.reason)
              : null,
      });
    }
    return out;
  } catch {
    // human text fallback
    const out: ModelAvailability[] = [];
    if (/system.*available/i.test(text)) {
      out.push({ id: "system", available: true, runnableInCurrentProcess: true });
    }
    if (/pcc.*available/i.test(text) && !/not runnable|unavailable/i.test(text)) {
      out.push({ id: "pcc", available: true, runnableInCurrentProcess: true });
    } else if (/pcc/i.test(text)) {
      out.push({
        id: "pcc",
        available: /available/i.test(text),
        runnableInCurrentProcess: false,
        reason: text.split(/\r?\n/).find((l) => /pcc/i.test(l)) ?? text,
      });
    }
    return out;
  }
}

export async function afmAvailable(
  bin: string,
  signal?: AbortSignal,
): Promise<ModelAvailability[]> {
  const extra = parseExtraArgs("AFM_EXTRA_ARGS");
  const result = await runCommand({
    bin,
    args: [...extra, ...buildAfmAvailableArgs()],
    signal,
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) {
    const err = extractCliError(result.stdout, result.stderr);
    throw new FmAcpError(err || `afm available failed (${result.exitCode})`);
  }
  return parseAfmAvailability(result.stdout || result.stderr);
}

export async function afmPromptTurn(
  bin: string,
  req: PromptTurnRequest,
  mode: "session" | "bridge",
): Promise<PromptTurnResult> {
  const extra = parseExtraArgs("AFM_EXTRA_ARGS");
  const args =
    mode === "bridge"
      ? buildAfmBridgeChatArgs({ prompt: req.prompt, modelId: req.modelId })
      : buildAfmSessionStreamArgs({
          prompt: req.prompt,
          modelId: req.modelId,
          instructions: req.instructions,
          useCase: req.useCase,
          guardrails: req.guardrails,
          history: req.history,
        });

  let streamed = "";
  let lineBuf = "";

  const result = await runCommand({
    bin,
    args: [...extra, ...args],
    signal: req.signal,
    onStdout: async (chunk) => {
      lineBuf += chunk;
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() ?? "";
      for (const line of parts) {
        for (const ev of parseAfmNdjsonEvents(line)) {
          const delta = extractAfmDeltaText(ev);
          if (delta) {
            streamed += delta;
            await req.onText?.(delta);
          }
        }
      }
    },
  });

  if (lineBuf.trim()) {
    for (const ev of parseAfmNdjsonEvents(lineBuf)) {
      const delta = extractAfmDeltaText(ev);
      if (delta) {
        streamed += delta;
        await req.onText?.(delta);
      }
    }
  }

  if (result.exitCode !== 0 || req.signal?.aborted) {
    if (req.signal?.aborted) {
      throw new FmAcpError("cancelled", { code: -32000 });
    }
    const err = extractCliError(result.stdout, result.stderr);
    throw new FmAcpError(err || `afm exited with code ${result.exitCode}`);
  }

  const finalText = streamed || extractAfmFinalText(result.stdout);
  if (!finalText) {
    const err = extractCliError(result.stdout, result.stderr);
    if (err) throw new FmAcpError(err);
  }

  return {
    text: finalText,
    backend: mode === "bridge" ? "afm-bridge" : "afm",
  };
}

export async function afmBridgeStatus(bin: string, signal?: AbortSignal): Promise<string> {
  const extra = parseExtraArgs("AFM_EXTRA_ARGS");
  const result = await runCommand({
    bin,
    args: [...extra, "bridge", "status", "--output", "json"],
    signal,
    timeoutMs: 15_000,
  });
  return (result.stdout || result.stderr).trim();
}
