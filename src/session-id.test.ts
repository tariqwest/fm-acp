import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPathInsideRoot,
  assertValidSessionId,
  isValidSessionId,
  safeTranscriptPath,
} from "./session-id.ts";

describe("session-id", () => {
  it("accepts UUID session ids", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(isValidSessionId(id), true);
    assert.equal(assertValidSessionId(id), id);
  });

  it("rejects path traversal session ids", () => {
    assert.equal(isValidSessionId("../../../../tmp/victim"), false);
    assert.throws(() => assertValidSessionId("../../../../tmp/victim"), /invalid sessionId/);
    assert.throws(() => assertValidSessionId(""), /invalid sessionId/);
    assert.throws(() => assertValidSessionId("not-a-uuid"), /invalid sessionId/);
  });

  it("safeTranscriptPath stays under transcripts dir", () => {
    const root = "/tmp/fm-acp-transcripts";
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const p = safeTranscriptPath(root, id);
    assert.equal(p, `${root}/${id}.json`);
    assert.throws(() => safeTranscriptPath(root, "../evil"), /invalid sessionId/);
  });

  it("assertPathInsideRoot rejects escapes", () => {
    assert.equal(assertPathInsideRoot("/tmp/root", "/tmp/root/a.json"), "/tmp/root/a.json");
    assert.throws(() => assertPathInsideRoot("/tmp/root", "/tmp/other/a.json"), /escapes/);
  });
});
