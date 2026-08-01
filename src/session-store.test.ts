import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionStore, sessionFromStored } from "./session-store.ts";
import type { Session } from "./types.ts";

function sampleSession(cwd: string): Session {
  return {
    modelId: "system",
    backendId: "auto",
    instructions: "secret instructions",
    useCase: "general",
    guardrails: "default",
    greedy: false,
    bridgeEnabled: true,
    cwd,
    transcriptPath: null,
    history: [{ role: "user", text: "hello" }],
    seenKeys: new Set(),
    title: null,
    updatedAt: new Date().toISOString(),
    activeAbort: null,
  };
}

describe("SessionStore", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it("writes private modes and rejects traversal ids", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-store-"));
    const store = new SessionStore({
      stateDir: tmp,
      stateFile: path.join(tmp, "sessions.json"),
      lockFile: path.join(tmp, "sessions.lock"),
      transcriptsDir: path.join(tmp, "transcripts"),
    });
    await store.init();

    const dirStat = await stat(tmp);
    assert.equal(dirStat.mode & 0o777, 0o700);

    const root = tmp!;
    const id = "550e8400-e29b-41d4-a716-446655440000";
    await store.save(id, sampleSession(root));
    const st = await stat(path.join(root, "sessions.json"));
    assert.equal(st.mode & 0o777, 0o600);

    await assert.rejects(() => store.save("../../../../tmp/x", sampleSession(root)), /invalid sessionId/);
    await assert.rejects(() => store.delete("../evil"), /invalid sessionId/);
  });

  it("quarantines corrupt store and refuses overwrite wipe", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-store-"));
    const stateFile = path.join(tmp, "sessions.json");
    await mkdir(tmp, { recursive: true });
    await writeFile(stateFile, "{not-json", "utf8");

    const store = new SessionStore({
      stateDir: tmp,
      stateFile,
      lockFile: path.join(tmp, "sessions.lock"),
      transcriptsDir: path.join(tmp, "transcripts"),
    });

    const id = "550e8400-e29b-41d4-a716-446655440000";
    await assert.rejects(() => store.get(id), /unreadable|corrupt|refusing/i);

    // Quarantine should have moved the bad file
    const entries = await (await import("node:fs/promises")).readdir(tmp);
    assert.ok(entries.some((e) => e.includes("corrupt")), `expected quarantine, got ${entries.join(",")}`);
  });

  it("round-trips a valid session", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-store-"));
    const store = new SessionStore({
      stateDir: tmp,
      stateFile: path.join(tmp, "sessions.json"),
      lockFile: path.join(tmp, "sessions.lock"),
      transcriptsDir: path.join(tmp, "transcripts"),
    });
    const id = "550e8400-e29b-41d4-a716-446655440001";
    const session = sampleSession(tmp);
    session.transcriptPath = store.transcriptPathFor(id);
    await store.save(id, session);
    const loaded = await store.get(id);
    assert.ok(loaded);
    const restored = sessionFromStored(loaded!, tmp);
    assert.equal(restored.instructions, "secret instructions");
    assert.equal(restored.history[0]?.text, "hello");
    const raw = await readFile(path.join(tmp, "sessions.json"), "utf8");
    assert.match(raw, /secret instructions/);
  });
});
