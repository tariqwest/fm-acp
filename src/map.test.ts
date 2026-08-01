import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flattenPromptText, mapFmTranscript, mapHistory } from "./map.ts";

describe("flattenPromptText", () => {
  it("joins text blocks", () => {
    assert.equal(
      flattenPromptText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
      "a\nb",
    );
  });
});

describe("mapFmTranscript", () => {
  it("maps entries", () => {
    const doc = {
      modelName: "system",
      transcript: {
        transcript: {
          entries: [
            { id: "1", role: "user", contents: [{ type: "text", text: "hi" }] },
            { id: "2", role: "response", contents: [{ type: "text", text: "hello" }] },
          ],
        },
      },
    };
    const deltas = mapFmTranscript(doc, new Set());
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0]!.update.sessionUpdate, "user_message_chunk");
    assert.equal(deltas[1]!.update.sessionUpdate, "agent_message_chunk");
  });
});

describe("mapHistory", () => {
  it("maps history messages", () => {
    const deltas = mapHistory(
      [
        { role: "user", text: "u" },
        { role: "assistant", text: "a" },
      ],
      new Set(),
    );
    assert.equal(deltas.length, 2);
  });
});
