import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectRuntime } from "../bin/runtime.mjs";

describe("runtime detection", () => {
  it("honors FM_ACP_RUNTIME=node when tsx is present", () => {
    // In this package tsx is a dependency, so node path should resolve.
    const r = detectRuntime({ ...process.env, FM_ACP_RUNTIME: "node", PATH: process.env.PATH });
    assert.equal(r, "node");
  });

  it("prefers bun when available and no override", () => {
    const r = detectRuntime({ ...process.env, FM_ACP_RUNTIME: "", PATH: process.env.PATH });
    // bun is installed in this environment
    assert.equal(r, "bun");
  });

  it("honors FM_ACP_RUNTIME=bun", () => {
    const r = detectRuntime({ ...process.env, FM_ACP_RUNTIME: "bun", PATH: process.env.PATH });
    assert.equal(r, "bun");
  });
});
