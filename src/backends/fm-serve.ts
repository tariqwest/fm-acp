import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FmAcpError, type ModelAvailability, type PromptTurnRequest, type PromptTurnResult } from "../types.ts";

export const FM_SERVE_SOCK_ENV = "FM_ACP_SERVE_SOCK";

export function defaultFmServeSocket(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[FM_SERVE_SOCK_ENV]?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || os.homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path.join(home, ".config");
  return path.join(base, "fm-acp", "fm.sock");
}

export type FmServeHealth = {
  status?: string;
  models?: Array<{ name: string; available: boolean; reason?: string }>;
};

function requestJson(opts: {
  socketPath: string;
  method: string;
  urlPath: string;
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = http.request(
      {
        socketPath: opts.socketPath,
        path: opts.urlPath,
        method: opts.method,
        headers: {
          Accept: opts.accept ?? "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (err) => {
      reject(new FmAcpError(`fm serve request failed: ${err.message}`, { details: err.message }));
    });
    const onAbort = () => {
      req.destroy(new Error("cancelled"));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    req.on("close", () => {
      opts.signal?.removeEventListener("abort", onAbort);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function fmServeHealth(
  socketPath: string,
  signal?: AbortSignal,
): Promise<FmServeHealth | null> {
  try {
    const res = await requestJson({
      socketPath,
      method: "GET",
      urlPath: "/health",
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return JSON.parse(res.body) as FmServeHealth;
  } catch {
    return null;
  }
}

export async function fmServeAvailable(
  socketPath: string,
  signal?: AbortSignal,
): Promise<ModelAvailability[] | null> {
  const health = await fmServeHealth(socketPath, signal);
  if (!health?.models?.length) return null;
  return health.models.map((m) => {
    const id = m.name === "pcc" ? ("pcc" as const) : ("system" as const);
    return {
      id,
      available: Boolean(m.available),
      runnableInCurrentProcess: Boolean(m.available),
      reason: m.available ? null : (m.reason ?? "unavailable via fm serve"),
    };
  });
}

/** Parse OpenAI-style SSE stream body into concatenated assistant text. */
export function parseChatCompletionSse(raw: string): string {
  let out = "";
  for (const block of raw.split(/\n\n/)) {
    const lines = block.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null } }>;
        };
        const choice = obj.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.message?.content;
        if (typeof piece === "string" && piece) out += piece;
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }
  return out;
}

export async function fmServePromptTurn(
  socketPath: string,
  req: PromptTurnRequest,
): Promise<PromptTurnResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }
  for (const h of req.history ?? []) {
    if (h.role === "system") messages.push({ role: "system", content: h.text });
    else if (h.role === "user") messages.push({ role: "user", content: h.text });
    else if (h.role === "assistant") messages.push({ role: "assistant", content: h.text });
  }
  messages.push({ role: "user", content: req.prompt || "Describe the image(s)." });

  // Prefer non-stream first for reliability; stream when onText provided.
  const stream = Boolean(req.onText);
  const body = {
    model: req.modelId,
    messages,
    stream,
  };

  if (!stream) {
    const res = await requestJson({
      socketPath,
      method: "POST",
      urlPath: "/v1/chat/completions",
      body,
      signal: req.signal,
    });
    if (res.status === 503 || res.status >= 400) {
      let msg = res.body.slice(0, 1000);
      try {
        const errObj = JSON.parse(res.body) as { error?: { message?: string } };
        if (errObj.error?.message) msg = errObj.error.message;
      } catch {
        // ignore
      }
      throw new FmAcpError(msg);
    }
    const parsed = JSON.parse(res.body) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = parsed.choices?.[0]?.message?.content ?? "";
    if (!text) throw new FmAcpError("fm serve returned empty response");
    await req.onText?.(text);
    return { text, backend: "fm-serve" };
  }

  // Streaming SSE
  const text = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let assembled = "";
    const payload = JSON.stringify(body);
    const httpReq = http.request(
      {
        socketPath,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            if (settled) return;
            settled = true;
            let msg = Buffer.concat(chunks).toString("utf8").slice(0, 1000);
            try {
              const errObj = JSON.parse(msg) as { error?: { message?: string } };
              if (errObj.error?.message) msg = errObj.error.message;
            } catch {
              // ignore
            }
            reject(new FmAcpError(msg || `fm serve HTTP ${res.statusCode}`));
          });
          return;
        }

        res.setEncoding("utf8");
        let chain: Promise<void> = Promise.resolve();
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split(/\n\n/);
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const piece = parseChatCompletionSse(part + "\n\n");
            if (!piece) continue;
            assembled += piece;
            if (req.onText) {
              chain = chain.then(() => req.onText!(piece));
            }
          }
        });
        res.on("end", () => {
          void chain
            .then(() => {
              if (buffer.trim()) {
                const piece = parseChatCompletionSse(buffer + "\n\n");
                if (piece) {
                  assembled += piece;
                  return req.onText?.(piece);
                }
              }
            })
            .then(() => {
              if (settled) return;
              settled = true;
              if (!assembled) {
                reject(new FmAcpError("fm serve returned empty stream"));
                return;
              }
              resolve(assembled);
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              reject(err instanceof FmAcpError ? err : new FmAcpError(String(err)));
            });
        });
      },
    );

    httpReq.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (req.signal?.aborted) {
        reject(new FmAcpError("cancelled"));
        return;
      }
      reject(new FmAcpError(`fm serve stream failed: ${err.message}`));
    });

    const onAbort = () => {
      httpReq.destroy(new Error("cancelled"));
    };
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }
    httpReq.on("close", () => req.signal?.removeEventListener("abort", onAbort));
    httpReq.write(payload);
    httpReq.end();
  });

  return { text, backend: "fm-serve" };
}
