/**
 * Wire protocol for the fm-acp-terminal-helper daemon.
 *
 * Uses newline-delimited JSON over a Unix domain socket. The helper is a single
 * long-lived process that owns a Terminal.app ancestor and executes `fm` on
 * behalf of the adapter. The adapter speaks this protocol to obtain PCC access.
 */

export type HelperRequest = HelperPingRequest | HelperRunRequest | HelperShutdownRequest;

export type HelperPingRequest = {
  op: "ping";
  id: string;
};

export type HelperRunRequest = {
  op: "run";
  id: string;
  modelId: "system" | "pcc";
  prompt: string;
  instructions?: string | null;
  useCase?: string | null;
  guardrails?: string | null;
  greedy?: boolean | null;
  transcriptPath?: string | null;
  resume?: boolean | null;
  images?: Array<{ path: string; label?: string }>;
};

export type HelperShutdownRequest = {
  op: "shutdown";
  id: string;
};

export type HelperEvent =
  | { id: string; type: "ready"; pid: number; uptimeMs: number }
  | { id: string; type: "started"; bin: string; argv: string[] }
  | { id: string; type: "text"; data: string }
  | { id: string; type: "done"; text: string; exitCode: number; transcriptPath?: string | null }
  | { id: string; type: "error"; message: string; code?: number }
  | { id: string; type: "pong"; version: string };

export function encodeRequest(req: HelperRequest): string {
  return JSON.stringify(req) + "\n";
}

export function decodeEvents(buffer: string): { events: HelperEvent[]; rest: string } {
  const events: HelperEvent[] = [];
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.type !== "string") continue;
      events.push(obj as unknown as HelperEvent);
    } catch {
      // ignore malformed lines
    }
  }
  return { events, rest };
}

/** Convenience: extract the final `done` text from a stream of events. */
export function extractFinal(events: HelperEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "done") return e.text;
  }
  return "";
}
