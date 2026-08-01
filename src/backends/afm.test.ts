import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAfmAvailableArgs,
  buildAfmBridgeChatArgs,
  buildAfmModelStatusArgs,
  buildAfmSessionStreamArgs,
  extractAfmDeltaText,
  extractAfmFinalText,
  parseAfmAvailability,
  parseAfmNdjsonEvents,
} from "./afm.ts";

describe("afm args", () => {
  it("builds stream args", () => {
    const args = buildAfmSessionStreamArgs({
      prompt: "hi",
      modelId: "system",
      instructions: "be brief",
    });
    assert.deepEqual(args.slice(0, 3), ["session", "stream", "--output"]);
    assert.ok(args.includes("--prompt"));
    assert.ok(args.includes("hi"));
    assert.ok(args.includes("--system-prompt"));
  });

  it("builds chat args with history", () => {
    const args = buildAfmSessionStreamArgs({
      prompt: "again",
      modelId: "system",
      history: [
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
      ],
    });
    assert.equal(args[0], "session");
    assert.equal(args[1], "chat");
    assert.ok(args.filter((a) => a === "--message").length >= 3);
  });

  it("builds bridge args", () => {
    assert.deepEqual(buildAfmBridgeChatArgs({ prompt: "x", modelId: "pcc" }), [
      "bridge",
      "chat",
      "--model",
      "pcc",
      "--prompt",
      "x",
      "--output",
      "json",
    ]);
  });

  it("builds available args", () => {
    assert.ok(buildAfmAvailableArgs("system").includes("on-device"));
    assert.ok(buildAfmAvailableArgs("pcc").includes("pcc"));
  });

  it("builds model status args for Homebrew 0.1.0", () => {
    assert.deepEqual(buildAfmModelStatusArgs(), ["model", "status", "--output", "json"]);
  });
});

describe("afm ndjson", () => {
  it("parses delta events", () => {
    const events = parseAfmNdjsonEvents('{"type":"delta","text":"Hel"}\n{"type":"delta","text":"lo"}');
    assert.equal(events.length, 2);
    assert.equal(extractAfmDeltaText(events[0]!), "Hel");
    assert.equal(extractAfmDeltaText(events[1]!), "lo");
  });

  it("extracts final response", () => {
    const out = extractAfmFinalText('{"type":"started"}\n{"type":"completed","response":"done"}');
    assert.equal(out, "done");
  });
});

describe("afm availability parse", () => {
  it("parses json models", () => {
    const models = parseAfmAvailability(
      JSON.stringify({
        models: [
          { id: "system", isAvailable: true, isRunnableInCurrentProcess: true },
          { id: "pcc", isAvailable: true, isRunnableInCurrentProcess: false, reason: "no entitlement" },
        ],
      }),
    );
    assert.equal(models.length, 2);
    assert.equal(models[0]!.id, "system");
    assert.equal(models[1]!.runnableInCurrentProcess, false);
  });

  it("parses Homebrew model status json as on-device only", () => {
    const models = parseAfmAvailability(
      JSON.stringify({
        isAvailable: true,
        provider: "Foundation Models",
        reason: "Apple Intelligence is available and ready to use.",
        status: "available",
        useCase: "general",
      }),
    );
    assert.equal(models.length, 2);
    assert.equal(models[0]!.id, "system");
    assert.equal(models[0]!.runnableInCurrentProcess, true);
    assert.equal(models[1]!.id, "pcc");
    assert.equal(models[1]!.runnableInCurrentProcess, false);
  });
});
