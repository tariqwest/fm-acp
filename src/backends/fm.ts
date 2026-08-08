import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { extractCliError, parseExtraArgs, resolveBinary, runCommand } from "../process.ts";
import {
  FmAcpError,
  type ModelAvailability,
  type ModelId,
  type PromptTurnRequest,
  type PromptTurnResult,
} from "../types.ts";

export function resolveFmBin(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveBinary(["fm"], {
    envPathKeys: ["FM_BIN_PATH", "FM_BIN"],
    defaultPath: "/usr/bin/fm",
    env,
  });
}

/** Pure arg builder kept for unit tests / diagnostics. */
export function buildFmRespondArgs(opts: {
  prompt: string;
  modelId: ModelId;
  instructions?: string | null;
  useCase?: string | null;
  guardrails?: string | null;
  greedy?: boolean | null;
  transcriptPath?: string | null;
  resume?: boolean;
  stream?: boolean;
  images?: Array<{ path: string; label?: string }>;
}): string[] {
  const args = ["respond", "--model", opts.modelId];
  if (opts.instructions) args.push("--instructions", opts.instructions);
  if (opts.useCase) args.push("--use-case", opts.useCase);
  if (opts.guardrails) args.push("--guardrails", opts.guardrails);
  if (opts.greedy) args.push("--greedy");
  if (opts.stream === false) args.push("--no-stream");
  if (opts.transcriptPath) {
    if (opts.resume && existsSync(opts.transcriptPath)) {
      args.push("--resume", opts.transcriptPath);
    }
    args.push("--save-transcript", opts.transcriptPath);
  }
  for (const img of opts.images ?? []) {
    args.push("--image", img.path);
    if (img.label) args.push("--label", img.label);
  }
  args.push(opts.prompt);
  return args;
}

export function parseFmAvailability(stdout: string, stderr: string): ModelAvailability[] {
  const text = `${stdout}\n${stderr}`;
  const out: ModelAvailability[] = [];

  const systemOk = /System model available/i.test(text) || /system.*available/i.test(text);
  const systemBad = /System model unavailable/i.test(text);
  if (systemOk && !systemBad) {
    out.push({ id: "system", available: true, runnableInCurrentProcess: true });
  } else if (systemBad) {
    out.push({
      id: "system",
      available: false,
      runnableInCurrentProcess: false,
      reason: text.split(/\r?\n/).find((l) => /system/i.test(l)) ?? text.trim(),
    });
  }

  const pccTerminal = /Private Cloud Compute is not available in this context/i.test(text);
  const pccUnavail = /PCC: unavailable/i.test(text) || pccTerminal;
  const pccOk = /PCC: available/i.test(text) || (/pcc.*available/i.test(text) && !pccUnavail);

  if (pccOk && !pccUnavail) {
    out.push({ id: "pcc", available: true, runnableInCurrentProcess: true });
  } else {
    out.push({
      id: "pcc",
      available: false,
      runnableInCurrentProcess: false,
      reason:
        text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /pcc|Private Cloud/i.test(l)) ?? "PCC unavailable",
    });
  }

  if (!out.some((m) => m.id === "system")) {
    if (!systemBad) {
      out.unshift({ id: "system", available: true, runnableInCurrentProcess: true });
    }
  }
  return out;
}

export async function fmAvailable(bin: string, signal?: AbortSignal): Promise<ModelAvailability[]> {
  const extra = parseExtraArgs("FM_EXTRA_ARGS");
  const result = await runCommand({
    bin,
    args: [...extra, "available"],
    signal,
    timeoutMs: 20_000,
  });
  return parseFmAvailability(result.stdout, result.stderr);
}

export async function ensureTranscriptDir(transcriptPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
}

/** Normalize fm CLI text output (JSON envelopes, fences, save notices). */
export function normalizeFmOutputText(raw: string): string {
  let text = raw.trim();
  text = text.replace(/\r/g, "");
  text = text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
  text = text.replace(/\n?Transcript saved to:.*$/m, "").trim();

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) text = fenced[1].trim();

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      if (obj.status === "error" && typeof obj.message === "string") {
        throw new FmAcpError(obj.message);
      }
      if (typeof obj.response === "string") {
        return obj.response;
      }
      if (
        (obj.status === "OK" || obj.status === "completed") &&
        Object.keys(obj).length <= 3
      ) {
        return typeof obj.response === "string" ? obj.response : "";
      }
    } catch (e) {
      if (e instanceof FmAcpError) throw e;
    }
  }

  if (
    /Private Cloud Compute is not available/i.test(text) ||
    /Please use the Terminal app/i.test(text)
  ) {
    throw new FmAcpError(text);
  }

  return text;
}

/**
 * Run one fm turn via direct /usr/bin/fm spawn (no fm-access-pcc/node-pty).
 * Prefer fm serve --socket for PCC; this path is an on-device fallback.
 */
export async function fmPromptTurn(
  bin: string,
  req: PromptTurnRequest,
): Promise<PromptTurnResult> {
  if (req.transcriptPath) {
    await ensureTranscriptDir(req.transcriptPath);
  }

  const resume =
    req.transcriptPath && existsSync(req.transcriptPath) ? true : false;
  const extra = parseExtraArgs("FM_EXTRA_ARGS");
  const args = [
    ...extra,
    ...buildFmRespondArgs({
      prompt: req.prompt || "Describe the image(s).",
      modelId: req.modelId,
      instructions: req.instructions,
      useCase: req.useCase,
      guardrails: req.guardrails,
      greedy: req.greedy,
      transcriptPath: req.transcriptPath,
      resume,
      stream: true,
      images: req.images,
    }),
  ];

  let streamed = "";
  let bufferOnly: boolean | null = null;
  let emittedLive = false;

  const result = await runCommand({
    bin,
    args,
    signal: req.signal,
    timeoutMs: 600_000,
    onStdout: async (chunk) => {
      if (!chunk) return;
      streamed += chunk;
      if (bufferOnly === null) {
        const lead = streamed.trimStart();
        if (!lead) return;
        bufferOnly =
          lead.startsWith("{") ||
          lead.startsWith("[") ||
          lead.startsWith("```") ||
          /^Error:/i.test(lead) ||
          /Private Cloud Compute is not available/i.test(lead);
      }
      if (bufferOnly) return;
      if (/Private Cloud Compute is not available/i.test(streamed)) {
        bufferOnly = true;
        return;
      }
      emittedLive = true;
      await req.onText?.(chunk);
    },
  });

  if (req.signal?.aborted) {
    throw new FmAcpError("cancelled");
  }

  if (result.exitCode !== 0) {
    const parsed = extractCliError(result.stdout, result.stderr);
    throw new FmAcpError(parsed || `fm exited with code ${result.exitCode}`);
  }

  let text = normalizeFmOutputText(streamed || result.stdout);
  if (!emittedLive && text && req.onText) {
    await req.onText(text);
  }
  if (!text) {
    throw new FmAcpError("fm returned empty response");
  }

  return {
    text,
    backend: "fm",
    transcriptPath: req.transcriptPath ?? null,
  };
}
