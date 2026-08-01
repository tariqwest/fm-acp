import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyConfigOptionValue, buildSessionConfigOptions } from "./config-options.ts";

describe("config options", () => {
  it("builds options", () => {
    const opts = buildSessionConfigOptions({
      models: [{ id: "system", available: true, runnableInCurrentProcess: true }],
      state: {
        modelId: "system",
        backendId: "auto",
        instructions: null,
        useCase: "general",
        guardrails: "default",
        greedy: false,
        bridgeEnabled: true,
      },
      hasAfm: false,
      hasFm: true,
    });
    assert.ok(opts.some((o) => o.id === "model"));
    assert.ok(opts.some((o) => o.id === "backend"));
  });

  it("applies model", () => {
    const next = applyConfigOptionValue({
      configId: "model",
      value: "pcc",
      state: {
        modelId: "system",
        backendId: "auto",
        instructions: null,
        useCase: null,
        guardrails: null,
        greedy: null,
        bridgeEnabled: null,
      },
    });
    assert.equal(next.modelId, "pcc");
  });
});
