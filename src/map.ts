import type { HistoryMessage } from "./types.ts";

export type AcpSessionUpdate = Record<string, unknown>;
export type MappedDelta = { key: string; update: AcpSessionUpdate };

export function flattenPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return typeof prompt === "string" ? prompt : "";
  }
  return prompt
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export type PromptImageRef = { path: string; label?: string };

/** Extract local image file paths from ACP prompt content blocks when present. */
export function extractPromptImages(prompt: unknown): PromptImageRef[] {
  if (!Array.isArray(prompt)) return [];
  const out: PromptImageRef[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "image" && b.type !== "resource") continue;
    const uri = typeof b.uri === "string" ? b.uri : typeof b.path === "string" ? b.path : null;
    if (!uri) continue;
    const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
    if (path.startsWith("/")) {
      out.push({
        path,
        label: typeof b.name === "string" ? b.name : undefined,
      });
    }
  }
  return out;
}

/**
 * Map Foundation Models transcript JSON (fm --save-transcript) into ACP updates.
 */
export function mapFmTranscript(
  transcriptDoc: unknown,
  seenKeys: ReadonlySet<string>,
): MappedDelta[] {
  const deltas: MappedDelta[] = [];
  const root = transcriptDoc && typeof transcriptDoc === "object" ? (transcriptDoc as Record<string, unknown>) : {};
  const nested =
    root.transcript && typeof root.transcript === "object"
      ? (root.transcript as Record<string, unknown>)
      : root;
  const inner =
    nested.transcript && typeof nested.transcript === "object"
      ? (nested.transcript as Record<string, unknown>)
      : nested;
  const entries = Array.isArray(inner.entries) ? inner.entries : [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const role = String(e.role ?? "").toLowerCase();
    const id = typeof e.id === "string" ? e.id : `entry-${i}`;
    const contents = Array.isArray(e.contents) ? e.contents : [];
    const texts: string[] = [];
    for (const c of contents) {
      if (!c || typeof c !== "object") continue;
      const block = c as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    const text = texts.join("\n").trim();
    if (!text) continue;

    if (role === "instructions" || role === "system") {
      const key = `sys:${id}`;
      if (seenKeys.has(key)) continue;
      deltas.push({
        key,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `[instructions] ${text}` },
        },
      });
      continue;
    }

    if (role === "user") {
      const key = `user:${id}`;
      if (seenKeys.has(key)) continue;
      deltas.push({
        key,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: id,
          content: { type: "text", text },
        },
      });
      continue;
    }

    if (role === "response" || role === "assistant") {
      const key = `asst:${id}`;
      if (seenKeys.has(key)) continue;
      deltas.push({
        key,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: id,
          content: { type: "text", text },
        },
      });
    }
  }

  return deltas;
}

/** Replay in-memory history as ACP updates. */
export function mapHistory(
  history: HistoryMessage[],
  seenKeys: ReadonlySet<string>,
): MappedDelta[] {
  const deltas: MappedDelta[] = [];
  history.forEach((msg, i) => {
    const key = `hist:${i}:${msg.role}:${msg.text.slice(0, 24)}`;
    if (seenKeys.has(key)) return;
    if (msg.role === "user") {
      deltas.push({
        key,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: `hist-user-${i}`,
          content: { type: "text", text: msg.text },
        },
      });
    } else if (msg.role === "assistant") {
      deltas.push({
        key,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: `hist-asst-${i}`,
          content: { type: "text", text: msg.text },
        },
      });
    }
  });
  return deltas;
}

export function decideStopReason(opts: {
  cancelled: boolean;
  hadText: boolean;
  error?: string | null;
}): { stopReason?: "end_turn" | "cancelled"; error?: string } {
  if (opts.cancelled) return { stopReason: "cancelled" };
  if (opts.error && !opts.hadText) return { error: opts.error };
  if (opts.error && opts.hadText) return { stopReason: "end_turn" };
  return { stopReason: "end_turn" };
}
