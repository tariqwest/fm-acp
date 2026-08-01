import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFmRespondArgs, parseFmAvailability } from "./fm.ts";

describe("fm args", () => {
  it("builds respond with resume/save", () => {
    const args = buildFmRespondArgs({
      prompt: "hi",
      modelId: "system",
      instructions: "brief",
      transcriptPath: "/tmp/t.json",
      resume: false,
      greedy: true,
    });
    assert.ok(args.includes("respond"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("system"));
    assert.ok(args.includes("--instructions"));
    assert.ok(args.includes("--save-transcript"));
    assert.ok(args.includes("--greedy"));
    assert.ok(!args.includes("--resume"));
  });
});

describe("fm availability", () => {
  it("parses mixed system ok + pcc error", () => {
    const models = parseFmAvailability(
      "System model available\n",
      "Error: Private Cloud Compute is not available in this context. Please use the Terminal app.\n",
    );
    const system = models.find((m) => m.id === "system");
    const pcc = models.find((m) => m.id === "pcc");
    assert.equal(system?.available, true);
    assert.equal(pcc?.runnableInCurrentProcess, false);
  });
});

import { normalizeFmOutputText } from "./fm.ts";

describe("normalizeFmOutputText", () => {
  it("unwraps response field", () => {
    assert.equal(
      normalizeFmOutputText('{"status":"completed","response":"pong"}'),
      "pong",
    );
  });

  it("throws on pcc context error text", () => {
    assert.throws(() =>
      normalizeFmOutputText(
        "Error: Private Cloud Compute is not available in this context. Please use the Terminal app.",
      ),
    );
  });
});

  it("unwraps fenced json response", () => {
    assert.equal(
      normalizeFmOutputText('```json\n{"status":"completed","response":"ok"}\n```'),
      "ok",
    );
  });
