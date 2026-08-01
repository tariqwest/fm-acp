import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { FmAcpAgent } from "./adapter.ts";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

async function main() {
  const agentImpl = new FmAcpAgent();
  // Single-flight availability; safe to kick off early.
  void agentImpl.initAvailability();

  // ndJsonStream(output, input): write responses to stdout, read requests from stdin.
  const output = Writable.toWeb(process.stdout);
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  const app = acp.agent({ name: "fm" });
  const activePrompts = new Map<string, AbortController>();

  const emitUpdate = async (
    client: { sessionUpdate?: (p: unknown) => Promise<void>; notify: (m: string, p?: unknown) => Promise<void> },
    body: unknown,
  ) => {
    if (typeof client.sessionUpdate === "function") {
      await client.sessionUpdate(body);
      return;
    }
    await client.notify(acp.methods.client.session.update, body);
  };

  app.onRequest(acp.methods.agent.initialize, async ({ params }) => {
    return agentImpl.initialize(params as never);
  });

  app.onRequest(acp.methods.agent.session.new, async ({ params }) => {
    return agentImpl.newSession(params as never);
  });

  app.onRequest(acp.methods.agent.session.load, async ({ params, client, signal }) => {
    return agentImpl.loadSession(params as never, {
      notify: async (method, body) => {
        if (method === "session/update" || method === acp.methods.client.session.update) {
          await emitUpdate(client, body);
          return;
        }
        await client.notify(method, body);
      },
      signal,
    });
  });

  app.onRequest(acp.methods.agent.session.resume, async ({ params }) => {
    return agentImpl.resumeSession(params as never);
  });

  app.onRequest(acp.methods.agent.session.list, async ({ params }) => {
    return agentImpl.listSessions((params ?? {}) as never);
  });

  app.onRequest(acp.methods.agent.session.delete, async ({ params }) => {
    return agentImpl.deleteSession(params as { sessionId: string });
  });

  app.onRequest(acp.methods.agent.session.close, async ({ params }) => {
    return agentImpl.closeSession(params as { sessionId: string });
  });

  app.onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => {
    return agentImpl.setSessionConfigOption(params as never);
  });

  // Compatibility aliases used by some hosts (custom methods need a params parser).
  const identityParser = {
    parse: (params: unknown) => params,
  };

  app.onRequest(
    "session/set_model",
    identityParser,
    async ({ params }) => {
      const p = asRecord(params);
      return agentImpl.setSessionModel({
        sessionId: String(p.sessionId ?? ""),
        modelId: String(p.modelId ?? ""),
      });
    },
  );
  app.onRequest(
    "session/setModel",
    identityParser,
    async ({ params }) => {
      const p = asRecord(params);
      return agentImpl.setSessionModel({
        sessionId: String(p.sessionId ?? ""),
        modelId: String(p.modelId ?? ""),
      });
    },
  );

  app.onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
    const p = asRecord(params);
    const sessionId = String(p.sessionId ?? "");
    // Reject overlapping prompts at the transport layer too.
    if (sessionId && activePrompts.has(sessionId)) {
      throw Object.assign(new Error("session is busy with another prompt"), { code: -32000 });
    }
    const abort = new AbortController();
    if (sessionId) activePrompts.set(sessionId, abort);

    const onCxAbort = () => abort.abort();
    signal.addEventListener("abort", onCxAbort, { once: true });

    try {
      return await agentImpl.prompt(params as never, {
        notify: async (method, body) => {
          if (method === "session/update" || method === acp.methods.client.session.update) {
            await emitUpdate(client, body);
            return;
          }
          await client.notify(method, body);
        },
        signal: abort.signal,
      });
    } finally {
      signal.removeEventListener("abort", onCxAbort);
      if (sessionId && activePrompts.get(sessionId) === abort) {
        activePrompts.delete(sessionId);
      }
    }
  });

  app.onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    const p = asRecord(params);
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId) {
      activePrompts.get(sessionId)?.abort();
      agentImpl.cancel({ sessionId });
    }
  });

  app.connect(stream);
}

main().catch((err) => {
  console.error("[fm-acp] fatal:", err);
  process.exit(1);
});
