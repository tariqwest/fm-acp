import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import type * as acp from "@agentclientprotocol/sdk";
import {
  applyConfigOptionValue,
  buildSessionConfigOptions,
  MODEL_CONFIG_ID,
  type ConfigState,
} from "./config-options.ts";
import {
  defaultModelFromAvailability,
  probeAvailability,
  resolveBackends,
  runPromptTurn,
  type ResolvedBackends,
} from "./backends/resolve.ts";
import {
  decideStopReason,
  extractPromptImages,
  flattenPromptText,
  mapFmTranscript,
  mapHistory,
} from "./map.ts";
import { assertValidSessionId } from "./session-id.ts";
import { SessionStore, sessionFromStored } from "./session-store.ts";
import type { ModelAvailability, ModelId, Session } from "./types.ts";
import { FmAcpError } from "./types.ts";

const require = createRequire(import.meta.url);
const PACKAGE_VERSION: string =
  (require("../package.json") as { version?: string }).version ?? "0.0.0";
const MAX_SESSIONS = 64;

type AgentContext = {
  notify: (method: string, params: unknown) => Promise<void> | void;
  signal?: AbortSignal;
};

function cwdFromParams(params: { cwd?: string } | undefined, fallback: string): string {
  const cwd = params?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : fallback;
}

export type FmAcpAgentDeps = {
  store?: SessionStore;
  defaultCwd?: string;
  resolveBackends?: typeof resolveBackends;
  probeAvailability?: typeof probeAvailability;
  runPromptTurn?: typeof runPromptTurn;
};

export class FmAcpAgent {
  private readonly sessions = new Map<string, Session>();
  private readonly store: SessionStore;
  private readonly defaultCwd: string;
  private readonly resolveBackendsFn: typeof resolveBackends;
  private readonly probeAvailabilityFn: typeof probeAvailability;
  private readonly runPromptTurnFn: typeof runPromptTurn;
  private backends: ResolvedBackends = {
    afmBin: null,
    fmBin: null,
    preferred: null,
    helperSocketPath: "",
    helperEnabled: false,
    serveSocketPath: "",
    serveEnabled: false,
  };
  private models: ModelAvailability[] = [];
  private modelsLoaded = false;
  private availabilitySource: "afm" | "fm" | "fm-serve" | "none" = "none";
  private availabilityInflight: Promise<void> | null = null;

  constructor(opts: FmAcpAgentDeps = {}) {
    this.store = opts.store ?? new SessionStore();
    this.defaultCwd = opts.defaultCwd ?? process.cwd() ?? process.env.HOME ?? "/tmp";
    this.resolveBackendsFn = opts.resolveBackends ?? resolveBackends;
    this.probeAvailabilityFn = opts.probeAvailability ?? probeAvailability;
    this.runPromptTurnFn = opts.runPromptTurn ?? runPromptTurn;
  }

  async initAvailability(): Promise<void> {
    if (this.availabilityInflight) return this.availabilityInflight;
    this.availabilityInflight = (async () => {
      await this.store.init();
      this.backends = await this.resolveBackendsFn("auto");
      const probed = await this.probeAvailabilityFn(this.backends);
      this.models = probed.models;
      this.availabilitySource = probed.source;
      this.modelsLoaded = true;
      console.error(
        `[fm-acp] backends serve=${this.backends.serveEnabled ? this.backends.serveSocketPath : "—"} afm=${this.backends.afmBin ?? "—"} fm=${this.backends.fmBin ?? "—"} preferred=${this.backends.preferred ?? "—"} helper=${this.backends.helperEnabled ? "up" : "down"} availability=${this.availabilitySource}`,
      );
      for (const m of this.models) {
        console.error(
          `[fm-acp] model ${m.id}: available=${m.available} runnable=${m.runnableInCurrentProcess}${m.reason ? ` (${m.reason})` : ""}`,
        );
      }
    })().finally(() => {
      this.availabilityInflight = null;
    });
    return this.availabilityInflight;
  }

  private async ensureAvailability(): Promise<void> {
    if (!this.modelsLoaded) await this.initAvailability();
  }

  private configState(session: Session): ConfigState {
    return {
      modelId: session.modelId,
      backendId: session.backendId,
      instructions: session.instructions,
      useCase: session.useCase,
      guardrails: session.guardrails,
      greedy: session.greedy,
      bridgeEnabled: session.bridgeEnabled,
    };
  }

  private sessionConfigOptionsJson(session: Session) {
    return buildSessionConfigOptions({
      models: this.models,
      state: this.configState(session),
      hasAfm: Boolean(this.backends.afmBin),
      hasFm: Boolean(this.backends.fmBin),
    });
  }

  private sessionModelsJson(session: Session) {
    const current = session.modelId ?? defaultModelFromAvailability(this.models);
    const available = this.models.length
      ? this.models
      : [{ id: "system" as const, available: true, runnableInCurrentProcess: true }];
    return {
      currentModelId: current,
      availableModels: available.map((m) => ({
        modelId: m.id,
        name:
          m.id === "system"
            ? m.runnableInCurrentProcess
              ? "System (on-device)"
              : "System (on-device, limited)"
            : m.runnableInCurrentProcess
              ? "PCC"
              : "PCC (not runnable here)",
      })),
    };
  }

  private sessionConfigResult(sessionId: string, session: Session) {
    return {
      sessionId,
      models: this.sessionModelsJson(session),
      configOptions: this.sessionConfigOptionsJson(session),
    };
  }

  private emptySession(cwd: string): Session {
    const modelId = defaultModelFromAvailability(this.models);
    return {
      modelId,
      backendId: "auto",
      instructions: null,
      useCase: "general",
      guardrails: "default",
      greedy: false,
      bridgeEnabled: true,
      cwd,
      transcriptPath: null,
      history: [],
      seenKeys: new Set(),
      title: null,
      updatedAt: new Date().toISOString(),
      activeAbort: null,
    };
  }

  private touch(session: Session) {
    session.updatedAt = new Date().toISOString();
  }

  private evictIfNeeded() {
    while (this.sessions.size >= MAX_SESSIONS) {
      const first = this.sessions.keys().next().value;
      if (!first) break;
      this.sessions.delete(first);
    }
  }

  private async restoreSession(sessionId: string): Promise<Session | null> {
    const id = assertValidSessionId(sessionId);
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const stored = await this.store.get(id);
    if (!stored) return null;
    const session = sessionFromStored(stored, this.defaultCwd);
    this.evictIfNeeded();
    this.sessions.set(id, session);
    return session;
  }

  private async persist(sessionId: string, session: Session) {
    this.touch(session);
    await this.store.save(sessionId, session);
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    await this.ensureAvailability();
    return {
      protocolVersion: 1,
      agentInfo: {
        name: "fm",
        title: "Apple Foundation Models",
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          text: true,
          // Absolute local file paths only today; not full ACP image data blocks.
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          resume: {},
          list: {},
          delete: {},
          close: {},
        },
      } as acp.AgentCapabilities,
      authMethods: [],
      _meta: {
        backends: {
          afm: this.backends.afmBin,
          fm: this.backends.fmBin,
          preferred: this.backends.preferred,
          availabilitySource: this.availabilitySource,
        },
        models: this.models,
      },
    } as acp.InitializeResponse;
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    await this.ensureAvailability();
    const sessionId = randomUUID();
    const session = this.emptySession(cwdFromParams(params, this.defaultCwd));
    session.transcriptPath = this.store.transcriptPathFor(sessionId);
    this.evictIfNeeded();
    this.sessions.set(sessionId, session);
    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.NewSessionResponse;
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    cx?: AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    await this.ensureAvailability();
    const sessionId = assertValidSessionId(params.sessionId ?? "");
    let session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), { code: -32000 });
    }
    if (params.cwd?.trim()) session.cwd = params.cwd.trim();

    if (cx) {
      // Prefer fm transcript file when present; else history.
      // Missing transcript is OK (fall through). Corrupt/unreadable transcript fails closed.
      let replayed = false;
      if (session.transcriptPath) {
        let raw: string | null = null;
        try {
          raw = await fsp.readFile(session.transcriptPath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw Object.assign(
              new Error(`failed to read transcript: ${(err as Error).message}`),
              { code: -32000 },
            );
          }
        }
        if (raw != null) {
          let doc: unknown;
          try {
            doc = JSON.parse(raw);
          } catch (err) {
            throw Object.assign(
              new Error(`corrupt transcript JSON: ${(err as Error).message}`),
              { code: -32000 },
            );
          }
          const deltas = mapFmTranscript(doc, new Set());
          for (const d of deltas) {
            session.seenKeys.add(d.key);
            await cx.notify("session/update", { sessionId, update: d.update });
          }
          replayed = deltas.length > 0;
        }
      }
      if (!replayed && session.history.length) {
        const deltas = mapHistory(session.history, new Set());
        for (const d of deltas) {
          session.seenKeys.add(d.key);
          await cx.notify("session/update", { sessionId, update: d.update });
        }
      }
    }

    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.LoadSessionResponse;
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    await this.ensureAvailability();
    const sessionId = assertValidSessionId(params.sessionId ?? "");
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), { code: -32000 });
    }
    if (params.cwd?.trim()) session.cwd = params.cwd.trim();
    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.ResumeSessionResponse;
  }

  async listSessions(params: acp.ListSessionsRequest = {}): Promise<acp.ListSessionsResponse> {
    const listed = await this.store.list();
    const cwdFilter = params.cwd?.trim() || null;
    let sessions = listed.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd ?? this.defaultCwd,
      title: s.title ?? undefined,
      updatedAt: s.updatedAt ?? undefined,
      _meta: {
        modelId: s.modelId,
        backendId: s.backendId,
        transcriptPath: s.transcriptPath,
      },
    }));
    if (cwdFilter) {
      sessions = sessions.filter((s) => s.cwd === cwdFilter);
    }
    // Cursor is a simple offset encoded as decimal string.
    const cursorRaw = params.cursor?.trim();
    let offset = 0;
    if (cursorRaw) {
      const n = Number.parseInt(cursorRaw, 10);
      if (Number.isFinite(n) && n > 0) offset = n;
    }
    const pageSize = 50;
    const page = sessions.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < sessions.length ? String(nextOffset) : null;
    return {
      sessions: page,
      nextCursor,
    } as acp.ListSessionsResponse;
  }

  async deleteSession(params: { sessionId: string }): Promise<Record<string, never>> {
    const sessionId = assertValidSessionId(params.sessionId ?? "");
    const session = this.sessions.get(sessionId);
    session?.activeAbort?.abort();
    this.sessions.delete(sessionId);
    await this.store.delete(sessionId);
    return {};
  }

  async closeSession(params: { sessionId: string }): Promise<Record<string, never>> {
    const sessionId = assertValidSessionId(params.sessionId ?? "");
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activeAbort?.abort();
      // Persist latest in-memory state, then drop from hot map (keep on disk).
      try {
        await this.persist(sessionId, session);
      } catch {
        // best-effort
      }
      this.sessions.delete(sessionId);
    }
    return {};
  }

  async setSessionModel(params: {
    sessionId: string;
    modelId: string;
  }): Promise<Record<string, never>> {
    const sessionId = assertValidSessionId(params.sessionId ?? "");
    const modelId = params.modelId;
    if (!modelId) {
      throw Object.assign(new Error("missing modelId"), { code: -32602 });
    }
    await this.ensureAvailability();
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), { code: -32000 });
    }
    const next = applyConfigOptionValue({
      configId: MODEL_CONFIG_ID,
      value: modelId,
      state: this.configState(session),
    });
    session.modelId = next.modelId;
    await this.persist(sessionId, session);
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const sessionId = assertValidSessionId(params.sessionId ?? "");
    const configId = params.configId;
    const value = params.value as unknown;
    if (!configId || value === undefined || value === null) {
      throw Object.assign(new Error("missing configId or value"), { code: -32602 });
    }
    await this.ensureAvailability();
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), { code: -32000 });
    }

    let next: ConfigState;
    try {
      next = applyConfigOptionValue({
        configId,
        value,
        state: this.configState(session),
      });
    } catch (err) {
      throw Object.assign(new Error((err as Error).message), {
        code: (err as { code?: number }).code ?? -32602,
      });
    }

    session.modelId = next.modelId;
    session.backendId = next.backendId;
    session.instructions = next.instructions;
    session.useCase = next.useCase;
    session.guardrails = next.guardrails;
    session.greedy = next.greedy;
    session.bridgeEnabled = next.bridgeEnabled;
    await this.persist(sessionId, session);
    return {
      configOptions: this.sessionConfigOptionsJson(session),
    } as acp.SetSessionConfigOptionResponse;
  }

  cancel(params: { sessionId: string }) {
    let sessionId: string;
    try {
      sessionId = assertValidSessionId(params.sessionId ?? "");
    } catch {
      return;
    }
    const session = this.sessions.get(sessionId);
    session?.activeAbort?.abort();
  }

  async prompt(params: acp.PromptRequest, cx: AgentContext): Promise<acp.PromptResponse> {
    await this.ensureAvailability();
    const sessionId = assertValidSessionId(params.sessionId ?? "");

    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), { code: -32000 });
    }
    if (!session.transcriptPath) {
      session.transcriptPath = this.store.transcriptPathFor(sessionId);
    }

    if (session.activeAbort) {
      throw Object.assign(new Error("session is busy with another prompt"), { code: -32000 });
    }

    const promptText = flattenPromptText(params.prompt);
    const images = extractPromptImages(params.prompt);
    if (!promptText && !images.length) {
      throw Object.assign(new Error("empty prompt"), { code: -32602 });
    }

    const abort = new AbortController();
    session.activeAbort = abort;
    const onCxAbort = () => abort.abort();
    cx.signal?.addEventListener("abort", onCxAbort, { once: true });

    const emit = async (update: Record<string, unknown>) => {
      await cx.notify("session/update", { sessionId, update });
    };

    const modelId: ModelId = session.modelId ?? "system";
    const messageId = `fm-${sessionId}-${Date.now()}`;
    let hadText = false;
    let chunkIndex = 0;

    try {
      session.history.push({ role: "user", text: promptText || "[image]" });

      const result = await this.runPromptTurnFn(
        this.backends,
        {
          prompt: promptText || "Describe the image(s).",
          images,
          modelId,
          instructions: session.instructions,
          useCase: session.useCase,
          guardrails: session.guardrails,
          greedy: session.greedy,
          transcriptPath: session.transcriptPath,
          history: session.history.slice(0, -1),
          signal: abort.signal,
          onText: async (text) => {
            if (!text) return;
            hadText = true;
            const key = `stream:${messageId}:${chunkIndex++}`;
            session.seenKeys.add(key);
            await emit({
              sessionUpdate: "agent_message_chunk",
              messageId,
              content: { type: "text", text },
            });
          },
        },
        {
          backendPreference: session.backendId,
          bridgeEnabled: session.bridgeEnabled,
        },
      );

      if (result.transcriptPath) session.transcriptPath = result.transcriptPath;
      if (result.text) {
        session.history.push({ role: "assistant", text: result.text });
        // If streaming produced nothing but we have final text, emit once.
        if (!hadText) {
          hadText = true;
          await emit({
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text: result.text },
          });
        }
      }

      await this.persist(sessionId, session);
      const decision = decideStopReason({
        cancelled: abort.signal.aborted,
        hadText,
      });
      if (decision.error) {
        throw Object.assign(new Error(decision.error), { code: -32000 });
      }
      return { stopReason: decision.stopReason ?? "end_turn" };
    } catch (err) {
      if (abort.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      const message =
        err instanceof FmAcpError ? err.message : `fm-acp prompt failed: ${(err as Error).message}`;
      throw Object.assign(new Error(message), {
        code: err instanceof FmAcpError ? err.code : -32000,
      });
    } finally {
      cx.signal?.removeEventListener("abort", onCxAbort);
      if (session.activeAbort === abort) session.activeAbort = null;
    }
  }
}
