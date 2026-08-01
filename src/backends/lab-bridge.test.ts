import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultLabBridgeDescriptor,
  parseLabBridgeDescriptorJson,
} from "./lab-bridge.ts";

// Construct addresses without hardcoding dotted quads in a way that tooling mangles.
const LOOPBACK = [127, 0, 0, 1].join(".");
const NON_LOOPBACK = [10, 0, 0, 1].join(".");

describe("lab bridge descriptor", () => {
  it("defaults to ~/.afm/bridge/connection.json", () => {
    const p = defaultLabBridgeDescriptor({ HOME: "/Users/demo" });
    assert.equal(p, "/Users/demo/.afm/bridge/connection.json");
  });

  it("parses loopbackTCP descriptor", () => {
    const d = parseLabBridgeDescriptorJson(
      JSON.stringify({
        version: 1,
        endpoint: { loopbackTCP: { host: LOOPBACK, port: 54321 } },
        bearerToken: "a".repeat(43),
        processIdentifier: 123,
        launchIdentifier: "11111111-1111-1111-1111-111111111111",
        modelIdentifiers: ["system", "pcc"],
        startedAt: "2026-06-22T00:00:00Z",
      }),
      "/tmp/connection.json",
    );
    assert.equal(d.endpoint.kind, "tcp");
    if (d.endpoint.kind === "tcp") {
      assert.equal(d.endpoint.host, LOOPBACK);
      assert.equal(d.endpoint.port, 54321);
    }
    assert.deepEqual(d.modelIdentifiers, ["system", "pcc"]);
  });

  it("rejects non-loopback hosts", () => {
    assert.throws(() =>
      parseLabBridgeDescriptorJson(
        JSON.stringify({
          version: 1,
          endpoint: { loopbackTCP: { host: NON_LOOPBACK, port: 80 } },
          bearerToken: "a".repeat(43),
          processIdentifier: 1,
          launchIdentifier: "x",
          modelIdentifiers: ["system"],
        }),
        "/tmp/c.json",
      ),
    );
  });
});
