import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  FmAcpError,
  type ModelAvailability,
  type ModelId,
  type PromptTurnRequest,
  type PromptTurnResult,
} from "../types.ts";

export const AFM_BRIDGE_DESCRIPTOR_ENV = "AFM_BRIDGE_DESCRIPTOR";
export const AFM_BRIDGE_BASE_ENV = "AFM_BRIDGE_BASE";

/** Default descriptor path used by Lab Agent Bridge + afm bridge prepare. */
export function defaultLabBridgeDescriptor(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AFM_BRIDGE_DESCRIPTOR_ENV]?.trim();
  if (override) return path.resolve(override);
  const base = env[AFM_BRIDGE_BASE_ENV]?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".afm");
  return path.join(path.resolve(base), "bridge", "connection.json");
}

export type LabBridgeEndpoint =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "unix"; socketPath: string };

export type LabBridgeDescriptor = {
  version: number;
  endpoint: LabBridgeEndpoint;
  bearerToken: string;
  processIdentifier: number;
  launchIdentifier: string;
  modelIdentifiers: string[];
  startedAt?: string;
  path: string;
};

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Parse AFMBridgeConnectionDescriptor JSON (Swift Codable shape). */
export function parseLabBridgeDescriptorJson(raw: string, filePath: string): LabBridgeDescriptor {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new FmAcpError(`invalid Lab bridge descriptor JSON at ${filePath}`);
  }
  const version = Number(obj.version ?? 0);
  if (version !== 1) {
    throw new FmAcpError(`unsupported Lab bridge descriptor version ${version} at ${filePath}`);
  }
  const token = typeof obj.bearerToken === "string" ? obj.bearerToken : "";
  if (!token || token.length < 16) {
    throw new FmAcpError(`Lab bridge descriptor missing bearerToken at ${filePath}`);
  }
  const models = Array.isArray(obj.modelIdentifiers)
    ? obj.modelIdentifiers.filter((m): m is string => typeof m === "string" && m.length > 0)
    : [];
  const endpointRaw = obj.endpoint;
  if (!endpointRaw || typeof endpointRaw !== "object") {
    throw new FmAcpError(`Lab bridge descriptor missing endpoint at ${filePath}`);
  }
  const ep = endpointRaw as Record<string, unknown>;
  let endpoint: LabBridgeEndpoint | null = null;
  if (ep.loopbackTCP && typeof ep.loopbackTCP === "object") {
    const tcp = ep.loopbackTCP as Record<string, unknown>;
    const host = String(tcp.host ?? "");
    const port = Number(tcp.port);
    if (!isLoopbackHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new FmAcpError(`Lab bridge descriptor has invalid loopbackTCP at ${filePath}`);
    }
    endpoint = { kind: "tcp", host, port };
  } else if (ep.unixSocket && typeof ep.unixSocket === "object") {
    const us = ep.unixSocket as Record<string, unknown>;
    const socketPath = String(us.path ?? "");
    if (!socketPath.startsWith("/")) {
      throw new FmAcpError(`Lab bridge descriptor has invalid unixSocket.path at ${filePath}`);
    }
    endpoint = { kind: "unix", socketPath };
  } else if (typeof ep.host === "string" && ep.port != null) {
    // Defensive flat shape
    const host = ep.host;
    const port = Number(ep.port);
    if (!isLoopbackHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new FmAcpError(`Lab bridge descriptor has invalid flat endpoint at ${filePath}`);
    }
    endpoint = { kind: "tcp", host, port };
  }
  if (!endpoint) {
    throw new FmAcpError(`Lab bridge descriptor endpoint not recognized at ${filePath}`);
  }
  return {
    version,
    endpoint,
    bearerToken: token,
    processIdentifier: Number(obj.processIdentifier ?? 0),
    launchIdentifier: String(obj.launchIdentifier ?? ""),
    modelIdentifiers: models,
    startedAt: typeof obj.startedAt === "string" ? obj.startedAt : undefined,
    path: filePath,
  };
}

export async function readLabBridgeDescriptor(
  descriptorPath: string = defaultLabBridgeDescriptor(),
): Promise<LabBridgeDescriptor | null> {
  try {
    const st = await fs.stat(descriptorPath);
    if (!st.isFile()) return null;
    // Prefer owner-only files (0600-ish); still attempt if slightly looser for debugging.
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `[fm-acp] Lab bridge descriptor ${descriptorPath} is group/world accessible (mode ${mode.toString(8)}); refusing`,
      );
      return null;
    }
    const raw = await fs.readFile(descriptorPath, "utf8");
    return parseLabBridgeDescriptorJson(raw, descriptorPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (err instanceof FmAcpError) throw err;
    return null;
  }
}

function requestJson(opts: {
  endpoint: LabBridgeEndpoint;
  bearerToken: string;
  method: string;
  urlPath: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers: http.OutgoingHttpHeaders = {
      Accept: "application/json",
      Authorization: `Bearer ${opts.bearerToken}`,
      ...(payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }
        : {}),
    };
    const common = {
      method: opts.method,
      path: opts.urlPath,
      headers,
    };
    const req =
      opts.endpoint.kind === "unix"
        ? http.request({ ...common, socketPath: opts.endpoint.socketPath })
        : http.request({
            ...common,
            host: opts.endpoint.host,
            port: opts.endpoint.port,
            family: opts.endpoint.host === "::1" ? 6 : 4,
          });

    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", (err) => {
      reject(new FmAcpError(`Lab bridge request failed: ${err.message}`, { details: err.message }));
    });
    const onAbort = () => {
      req.destroy(new Error("cancelled"));
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.on("close", () => {
      opts.signal?.removeEventListener("abort", onAbort);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function labBridgeHealth(
  descriptor: LabBridgeDescriptor,
  signal?: AbortSignal,
): Promise<{ ok: boolean; models: ModelAvailability[] } | null> {
  try {
    const res = await requestJson({
      endpoint: descriptor.endpoint,
      bearerToken: descriptor.bearerToken,
      method: "GET",
      urlPath: "/health",
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    let parsed: {
      models?: Array<{ name?: string; id?: string; available?: boolean; reason?: string }>;
      status?: string;
    };
    try {
      parsed = JSON.parse(res.body) as typeof parsed;
    } catch {
      return null;
    }
    const fromHealth = (parsed.models ?? []).map((m) => {
      const raw = String(m.name ?? m.id ?? "").toLowerCase();
      const id: ModelId = raw.includes("pcc") ? "pcc" : "system";
      return {
        id,
        available: Boolean(m.available),
        runnableInCurrentProcess: Boolean(m.available),
        reason: m.available ? null : (m.reason ?? "unavailable via Lab bridge"),
      } satisfies ModelAvailability;
    });
    // Fall back to descriptor model list if health omits models.
    const models =
      fromHealth.length > 0
        ? fromHealth
        : descriptor.modelIdentifiers.map((idRaw) => {
            const id: ModelId = idRaw.toLowerCase().includes("pcc") ? "pcc" : "system";
            return {
              id,
              available: true,
              runnableInCurrentProcess: true,
              reason: null,
            } satisfies ModelAvailability;
          });
    // Ensure unique ids
    const byId = new Map<ModelId, ModelAvailability>();
    for (const m of models) byId.set(m.id, m);
    return { ok: true, models: [...byId.values()] };
  } catch {
    return null;
  }
}

export async function labBridgeAvailable(
  descriptorPath: string = defaultLabBridgeDescriptor(),
  signal?: AbortSignal,
): Promise<ModelAvailability[] | null> {
  const descriptor = await readLabBridgeDescriptor(descriptorPath);
  if (!descriptor) return null;
  const health = await labBridgeHealth(descriptor, signal);
  return health?.models ?? null;
}

export async function labBridgePromptTurn(
  req: PromptTurnRequest,
  descriptorPath: string = defaultLabBridgeDescriptor(),
): Promise<PromptTurnResult> {
  const descriptor = await readLabBridgeDescriptor(descriptorPath);
  if (!descriptor) {
    throw new FmAcpError(
      `Lab Agent Bridge descriptor not found at ${descriptorPath}. Enable Agent Bridge in Foundation Lab (base folder ~/.afm) or start Terminal-hosted fm serve.`,
    );
  }
  const health = await labBridgeHealth(descriptor, req.signal);
  if (!health?.ok) {
    throw new FmAcpError(
      `Lab Agent Bridge not reachable (descriptor ${descriptor.path}). Re-enable Agent Bridge in Foundation Lab.`,
    );
  }
  const wanted = req.modelId;
  const model = health.models.find((m) => m.id === wanted);
  if (model && !model.runnableInCurrentProcess) {
    throw new FmAcpError(model.reason || `Lab bridge model ${wanted} not available`);
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });
  for (const h of req.history ?? []) {
    if (h.role === "system" || h.role === "user" || h.role === "assistant") {
      messages.push({ role: h.role, content: h.text });
    }
  }
  messages.push({ role: "user", content: req.prompt || "Describe the image(s)." });

  const res = await requestJson({
    endpoint: descriptor.endpoint,
    bearerToken: descriptor.bearerToken,
    method: "POST",
    urlPath: "/v1/chat/completions",
    body: {
      model: wanted,
      messages,
      stream: false,
    },
    signal: req.signal,
  });
  if (req.signal?.aborted) {
    throw new FmAcpError("cancelled", { code: -32000 });
  }
  if (res.status === 401 || res.status === 403) {
    throw new FmAcpError("Lab bridge authentication failed (stale descriptor?)");
  }
  if (res.status >= 400) {
    let msg = res.body.slice(0, 1000);
    try {
      const errObj = JSON.parse(res.body) as { error?: { message?: string } };
      if (errObj.error?.message) msg = errObj.error.message;
    } catch {
      // ignore
    }
    throw new FmAcpError(msg || `Lab bridge HTTP ${res.status}`);
  }
  const parsed = JSON.parse(res.body) as {
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
  };
  const choice = parsed.choices?.[0]?.message;
  const text = (choice?.content || choice?.refusal || "").trim();
  if (!text) throw new FmAcpError("Lab bridge returned empty response");
  await req.onText?.(text);
  return { text, backend: "afm-bridge" };
}
