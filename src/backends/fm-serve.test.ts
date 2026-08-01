import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultFmServeSocket, parseChatCompletionSse } from "./fm-serve.ts";

describe("parseChatCompletionSse", () => {
  it("extracts delta content chunks", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    assert.equal(parseChatCompletionSse(raw), "hello");
  });

  it("ignores malformed chunks", () => {
    const raw = "data: not-json\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n";
    assert.equal(parseChatCompletionSse(raw), "x");
  });
});

describe("defaultFmServeSocket", () => {
  it("uses env override", () => {
    assert.equal(
      defaultFmServeSocket({ FM_ACP_SERVE_SOCK: "/tmp/custom.sock" } as NodeJS.ProcessEnv),
      "/tmp/custom.sock",
    );
  });

  it("defaults under config home", () => {
    const p = defaultFmServeSocket({ HOME: "/Users/t", XDG_CONFIG_HOME: "" } as NodeJS.ProcessEnv);
    assert.match(p, /fm-acp\/fm\.sock$/);
  });
});
