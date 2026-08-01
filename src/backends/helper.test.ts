import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { encodeRequest } from "../helper-protocol.ts";
import { runHelperPromptTurn } from "./helper.ts";
import { FmAcpError } from "../types.ts";

function startFakeHelper(
  sockPath: string,
  handler: (req: Record<string, unknown>, send: (obj: unknown) => void) => void,
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      const send = (obj: unknown) => {
        try {
          socket.write(JSON.stringify(obj) + "\n");
        } catch {
          // ignore
        }
      };
      // Ready handshake, matching the real daemon.
      send({ id: "0", type: "ready", pid: process.pid, uptimeMs: 0 });

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let req: Record<string, unknown>;
          try {
            req = JSON.parse(t) as Record<string, unknown>;
          } catch {
            send({ id: "?", type: "error", message: "bad json" });
            continue;
          }
          handler(req, send);
        }
      });
    });
    server.unref();
    server.once("error", reject);
    server.listen(sockPath, () => resolve(server));
  });
}

async function closeServer(server: net.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Force-drop lingering connections so close always resolves.
    (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  });
}

describe("runHelperPromptTurn", () => {
  let tmp: string | null = null;
  let server: net.Server | null = null;

  afterEach(async () => {
    await closeServer(server);
    server = null;
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it("streams text events and returns done payload", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-helper-"));
    const sock = path.join(tmp, "helper.sock");

    server = await startFakeHelper(sock, (req, send) => {
      assert.equal(req.op, "run");
      assert.equal(req.modelId, "pcc");
      assert.equal(req.prompt, "hello");
      send({ id: req.id, type: "started", bin: "/usr/bin/fm", argv: ["respond"] });
      send({ id: req.id, type: "text", data: "hel" });
      send({ id: req.id, type: "text", data: "lo!" });
      send({
        id: req.id,
        type: "done",
        text: "hello!",
        exitCode: 0,
        transcriptPath: "/tmp/t.json",
      });
    });

    const chunks: string[] = [];
    const result = await runHelperPromptTurn(null, {
      prompt: "hello",
      modelId: "pcc",
      onText: (t) => {
        chunks.push(t);
      },
    }, {
      socketPath: sock,
      skipBootstrap: true,
    });

    assert.deepEqual(chunks, ["hel", "lo!"]);
    assert.equal(result.text, "hello!");
    assert.equal(result.backend, "fm-helper");
    assert.equal(result.transcriptPath, "/tmp/t.json");
  });

  it("propagates helper error events", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-helper-"));
    const sock = path.join(tmp, "helper.sock");

    server = await startFakeHelper(sock, (req, send) => {
      send({ id: req.id, type: "error", message: "fm binary not found", code: -32001 });
    });

    await assert.rejects(
      () =>
        runHelperPromptTurn(
          null,
          { prompt: "x", modelId: "pcc" },
          { socketPath: sock, skipBootstrap: true },
        ),
      (err: unknown) => {
        assert.ok(err instanceof FmAcpError);
        assert.match((err as Error).message, /fm binary not found/);
        return true;
      },
    );
  });

  it("cancels when the AbortSignal fires", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-helper-"));
    const sock = path.join(tmp, "helper.sock");

    server = await startFakeHelper(sock, (_req, _send) => {
      // Never reply — the client must cancel via abort.
    });

    const ac = new AbortController();
    const p = runHelperPromptTurn(
      null,
      { prompt: "x", modelId: "pcc", signal: ac.signal },
      { socketPath: sock, skipBootstrap: true },
    );
    // Give the connect a tick, then abort.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof FmAcpError);
      assert.match((err as Error).message, /cancelled/);
      return true;
    });
  });

  it("throws when socket is missing and bootstrap is skipped", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-helper-"));
    const sock = path.join(tmp, "no-such.sock");
    await assert.rejects(
      () =>
        runHelperPromptTurn(
          null,
          { prompt: "x", modelId: "pcc" },
          { socketPath: sock, skipBootstrap: true },
        ),
      /helper socket not found/,
    );
  });
});

describe("encodeRequest (sanity with helper client)", () => {
  it("produces a trailing newline the daemon expects", () => {
    const raw = encodeRequest({ op: "ping", id: "p" });
    assert.equal(raw.endsWith("\n"), true);
  });
});
