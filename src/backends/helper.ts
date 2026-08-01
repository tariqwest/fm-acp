import net from "node:net";
import { existsSync } from "node:fs";
import {
  decodeEvents,
  encodeRequest,
  type HelperEvent,
  type HelperRequest,
  type HelperRunRequest,
} from "../helper-protocol.ts";
import { ensureHelper, probeRunning } from "../helper-bootstrap.ts";
import {
  helperLogPath,
  helperPidPath,
  helperSocketPath,
} from "../helper-socket.ts";
import { FmAcpError, type PromptTurnRequest, type PromptTurnResult } from "../types.ts";

export type HelperRunOptions = {
  /** Override the helper socket path (otherwise taken from env). */
  socketPath?: string;
  /** Skip the bootstrap auto-launch attempt (default false). */
  skipBootstrap?: boolean;
  /** Allow auto-bootstrap (default reads FM_ACP_AUTO_BOOTSTRAP). */
  autoBootstrap?: boolean | null;
  /** Maximum time to wait for the helper socket to appear on bootstrap. */
  bootstrapTimeoutMs?: number;
  /** Override env used for path resolution. */
  env?: NodeJS.ProcessEnv;
  /** Per-turn timeout (inactivity ceiling). 0 disables. */
  timeoutMs?: number;
};

/**
 * Result of a helper interaction. Mirrors PromptTurnResult but adds the helper
 * backend id, since the helper is what runs `fm`.
 */
export type HelperTurnResult = PromptTurnResult & { backend: "fm-helper" };

/**
 * Connect to the helper socket, send a `run` request, stream `text` events
 * to the caller, and resolve with the final `done` payload.
 */
export async function runHelperPromptTurn(
  _bin: string | null,
  req: PromptTurnRequest,
  opts: HelperRunOptions = {},
): Promise<HelperTurnResult> {
  const env = opts.env ?? process.env;
  const socketPath = opts.socketPath ?? helperSocketPath(env);

  if (!opts.skipBootstrap) {
    const ensured = await ensureHelper({
      helperBin: undefined,
      auto: opts.autoBootstrap ?? null,
      timeoutMs: opts.bootstrapTimeoutMs,
      env,
    });
    if (ensured.status === "failed") {
      throw new FmAcpError(
        `helper unavailable: ${ensured.reason}. Run \`fm-acp-terminal-helper\` inside Terminal.app.`,
      );
    }
    if (ensured.status === "declined") {
      throw new FmAcpError(ensured.reason);
    }
  } else if (!existsSync(socketPath)) {
    throw new FmAcpError(`helper socket not found at ${socketPath}`);
  } else if (!(await probeRunning(socketPath))) {
    throw new FmAcpError(`helper socket at ${socketPath} is not accepting connections`);
  }

  const runReq: HelperRunRequest = {
    op: "run",
    id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    modelId: req.modelId,
    prompt: req.prompt,
    instructions: req.instructions ?? null,
    useCase: req.useCase ?? null,
    guardrails: req.guardrails ?? null,
    greedy: req.greedy ?? null,
    transcriptPath: req.transcriptPath ?? null,
    resume: req.transcriptPath && existsSync(req.transcriptPath) ? true : false,
    images: req.images?.map((i) => ({ path: i.path, label: i.label })),
  };

  return await runOneRequest(runReq, req, socketPath, opts);
}

/**
 * Open a socket connection, write a single request, stream events until `done`
 * or `error`, and return the final result. Aborts cleanly on signal.
 */
async function runOneRequest(
  req: HelperRunRequest,
  original: PromptTurnRequest,
  socketPath: string,
  opts: HelperRunOptions,
): Promise<HelperTurnResult> {
  const sock = net.createConnection(socketPath);
  sock.setNoDelay(true);

  let buffer = "";
  let finalText = "";
  let exitCode = 0;
  let transcriptPath: string | null = null;
  let abortSentinel = false;
  let settled = false;

  const cleanup = () => {
    try {
      sock.destroy();
    } catch {
      // ignore
    }
  };

  // Abort: destroy the socket. The helper interprets disconnect as cancel and
  // SIGTERMs the running `fm` process.
  const onAbort = () => {
    abortSentinel = true;
    cleanup();
  };
  if (original.signal) {
    if (original.signal.aborted) {
      onAbort();
    } else {
      original.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Inactivity ceiling: the helper is supposed to stream chunks. If we don't
  // receive any bytes for N seconds, treat the turn as failed.
  let inactivityTimer: NodeJS.Timeout | undefined;
  const armInactivity = () => {
    if (!opts.timeoutMs || opts.timeoutMs <= 0) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      cleanup();
    }, opts.timeoutMs);
    inactivityTimer.unref();
  };

  const result = await new Promise<HelperTurnResult>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (original.signal) original.signal.removeEventListener("abort", onAbort);
      cleanup();
      fn();
    };

    sock.once("error", (err) => {
      // "error" often precedes "close"; only reject if we haven't settled.
      settle(() => {
        if (abortSentinel) {
          reject(new FmAcpError("cancelled"));
          return;
        }
        reject(
          new FmAcpError(`helper connection error: ${err.message}`, {
            details: err.message,
          }),
        );
      });
    });

    sock.once("close", () => {
      settle(() => {
        if (abortSentinel) {
          reject(new FmAcpError("cancelled"));
          return;
        }
        reject(new FmAcpError("helper closed connection before `done`"));
      });
    });

    sock.on("connect", () => {
      try {
        sock.write(encodeRequest(req satisfies HelperRequest));
        armInactivity();
      } catch (err) {
        settle(() =>
          reject(
            new FmAcpError(
              `failed to write to helper: ${(err as Error).message}`,
            ),
          ),
        );
      }
    });

    sock.on("data", (raw: Buffer) => {
      armInactivity();
      buffer += raw.toString("utf8");
      const { events, rest } = decodeEvents(buffer);
      buffer = rest;
      for (const ev of events) handleEvent(ev);
    });

    function handleEvent(ev: HelperEvent) {
      switch (ev.type) {
        case "ready":
        case "started":
        case "pong":
          // informational; ignore
          break;
        case "text":
          if (ev.data) {
            // Serialize onText; do not fire-and-forget.
            void (async () => {
              try {
                await original.onText?.(ev.data);
              } catch (err) {
                settle(() =>
                  reject(
                    err instanceof FmAcpError
                      ? err
                      : new FmAcpError(`helper onText failed: ${(err as Error).message}`),
                  ),
                );
              }
            })();
          }
          break;
        case "done":
          finalText = ev.text ?? "";
          exitCode = ev.exitCode ?? 0;
          transcriptPath = ev.transcriptPath ?? null;
          settle(() => {
            // Nonzero exit is always failure (even if stdout was non-empty).
            if (exitCode !== 0) {
              reject(
                new FmAcpError(
                  finalText
                    ? `helper: fm exited with code ${exitCode}: ${finalText.slice(0, 500)}`
                    : `helper: fm exited with code ${exitCode} and no output`,
                ),
              );
              return;
            }
            resolve({
              text: finalText,
              backend: "fm-helper",
              transcriptPath: transcriptPath ?? undefined,
            });
          });
          break;
        case "error":
          settle(() =>
            reject(
              new FmAcpError(ev.message ?? "helper reported error", {
                code: typeof ev.code === "number" ? ev.code : undefined,
              }),
            ),
          );
          break;
      }
    }
  });

  return result;
}

/**
 * Diagnostic snapshot of helper state. Useful for `--diagnose` style commands.
 */
export function helperStatus(env: NodeJS.ProcessEnv = process.env) {
  return {
    socketPath: helperSocketPath(env),
    logPath: helperLogPath(env),
    pidPath: helperPidPath(env),
  };
}