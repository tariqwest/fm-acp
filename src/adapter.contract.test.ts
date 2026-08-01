import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { FmAcpAgent } from "./adapter.ts";
import type { ResolvedBackends } from "./backends/resolve.ts";
import { SessionStore } from "./session-store.ts";
import type { PromptTurnRequest, PromptTurnResult } from "./types.ts";

describe("FmAcpAgent contract", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  function backendsFor(dir: string): ResolvedBackends {
    return {
      afmBin: null,
      fmBin: "/usr/bin/fm",
      preferred: "fm",
      helperSocketPath: path.join(dir, "helper.sock"),
      helperEnabled: false,
      serveSocketPath: path.join(dir, "fm.sock"),
      serveEnabled: false,
    };
  }

  async function makeAgent(opts: {
    runPromptTurn?: (b: ResolvedBackends, req: PromptTurnRequest) => Promise<PromptTurnResult>;
  } = {}) {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-contract-"));
    const store = new SessionStore({
      stateDir: tmp,
      stateFile: path.join(tmp, "sessions.json"),
      lockFile: path.join(tmp, "sessions.lock"),
      transcriptsDir: path.join(tmp, "transcripts"),
    });

    const agent = new FmAcpAgent({
      store,
      defaultCwd: tmp,
      resolveBackends: async () => backendsFor(tmp!),
      probeAvailability: async () => ({
        models: [
          { id: "system", available: true, runnableInCurrentProcess: true },
          { id: "pcc", available: false, runnableInCurrentProcess: false, reason: "need serve" },
        ],
        source: "fm",
      }),
      runPromptTurn:
        opts.runPromptTurn ??
        (async (_b, req) => {
          await req.onText?.("hello-from-mock");
          return { text: "hello-from-mock", backend: "fm" };
        }),
    });
    await agent.initAvailability();
    return { agent, store };
  }

  it("initialize advertises close/list/delete/resume and no images", async () => {
    const { agent } = await makeAgent();
    const init = await agent.initialize({ protocolVersion: 1 } as never);
    assert.equal(init.agentInfo?.name, "fm");
    const caps = init.agentCapabilities as {
      loadSession?: boolean;
      promptCapabilities?: { image?: boolean; text?: boolean };
      sessionCapabilities?: { close?: object; list?: object; delete?: object; resume?: object };
    };
    assert.equal(caps.loadSession, true);
    assert.equal(caps.promptCapabilities?.text, true);
    assert.equal(caps.promptCapabilities?.image, false);
    assert.ok(caps.sessionCapabilities?.close);
    assert.ok(caps.sessionCapabilities?.list);
    assert.ok(caps.sessionCapabilities?.delete);
    assert.ok(caps.sessionCapabilities?.resume);
  });

  it("new → prompt → load replay → close → reject unknown prompt", async () => {
    const { agent } = await makeAgent();
    const created = await agent.newSession({ cwd: tmp! } as never);
    const sessionId = (created as { sessionId: string }).sessionId;
    assert.match(sessionId, /^[0-9a-f-]{36}$/i);

    const updates: unknown[] = [];
    const promptRes = await agent.prompt(
      {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      } as never,
      {
        notify: async (_m, body) => {
          updates.push(body);
        },
      },
    );
    assert.equal(promptRes.stopReason, "end_turn");
    assert.ok(updates.length >= 1);

    const loadUpdates: unknown[] = [];
    await agent.loadSession({ sessionId, cwd: tmp! } as never, {
      notify: async (_m, body) => {
        loadUpdates.push(body);
      },
    });
    assert.ok(loadUpdates.length >= 1);

    const listed = await agent.listSessions({});
    assert.ok((listed.sessions as unknown[]).some((s) => (s as { sessionId: string }).sessionId === sessionId));
    const info = (listed.sessions as Array<{ sessionId: string; updatedAt?: string }>).find(
      (s) => s.sessionId === sessionId,
    );
    assert.ok(info?.updatedAt);

    await agent.closeSession({ sessionId });
    const again = await agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "again" }] } as never,
      { notify: async () => undefined },
    );
    assert.equal(again.stopReason, "end_turn");

    await assert.rejects(
      () =>
        agent.prompt(
          {
            sessionId: "00000000-0000-4000-8000-000000000099",
            prompt: [{ type: "text", text: "nope" }],
          } as never,
          { notify: async () => undefined },
        ),
      /unknown sessionId/,
    );
  });

  it("rejects concurrent prompts and invalid session ids", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const { agent } = await makeAgent({
      runPromptTurn: async (_b, req) => {
        await req.onText?.("partial");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error("cancelled"));
          if (req.signal?.aborted) onAbort();
          else req.signal?.addEventListener("abort", onAbort, { once: true });
          gate.then(() => {
            req.signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        return { text: "done", backend: "fm" };
      },
    });

    const created = await agent.newSession({ cwd: tmp! } as never);
    const sessionId = (created as { sessionId: string }).sessionId;

    const first = agent.prompt(
      { sessionId, prompt: [{ type: "text", text: "one" }] } as never,
      { notify: async () => undefined },
    );
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
      () =>
        agent.prompt(
          { sessionId, prompt: [{ type: "text", text: "two" }] } as never,
          { notify: async () => undefined },
        ),
      /busy/,
    );
    release();
    await first;

    await assert.rejects(() => agent.deleteSession({ sessionId: "../evil" }), /invalid sessionId/);
  });

  it("load fails closed on corrupt transcript", async () => {
    const { agent, store } = await makeAgent();
    const created = await agent.newSession({ cwd: tmp! } as never);
    const sessionId = (created as { sessionId: string }).sessionId;
    const tp = path.join(tmp!, "transcripts", `${sessionId}.json`);
    await writeFile(tp, "{not-json", "utf8");
    await store.save(sessionId, {
      modelId: "system",
      backendId: "auto",
      instructions: null,
      useCase: "general",
      guardrails: "default",
      greedy: false,
      bridgeEnabled: true,
      cwd: tmp!,
      transcriptPath: tp,
      history: [],
      seenKeys: new Set(),
      title: null,
      updatedAt: new Date().toISOString(),
      activeAbort: null,
    });

    const agent2 = new FmAcpAgent({
      store,
      defaultCwd: tmp!,
      resolveBackends: async () => backendsFor(tmp!),
      probeAvailability: async () => ({
        models: [{ id: "system", available: true, runnableInCurrentProcess: true }],
        source: "fm",
      }),
      runPromptTurn: async () => ({ text: "x", backend: "fm" }),
    });
    await agent2.initAvailability();

    await assert.rejects(
      () =>
        agent2.loadSession({ sessionId, cwd: tmp! } as never, {
          notify: async () => undefined,
        }),
      /corrupt transcript/,
    );
  });
});
