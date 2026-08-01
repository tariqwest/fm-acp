import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCliError } from "./process.ts";

describe("extractCliError", () => {
  it("parses json error line", () => {
    const msg = extractCliError('{"status":"error","message":"boom"}', "");
    assert.equal(msg, "boom");
  });

  it("parses Error: prefix", () => {
    const msg = extractCliError("", "Error: nope");
    assert.equal(msg, "nope");
  });
});
