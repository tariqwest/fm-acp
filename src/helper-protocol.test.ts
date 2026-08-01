import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeEvents,
  encodeRequest,
  extractFinal,
  type HelperEvent,
  type HelperRequest,
} from "./helper-protocol.ts";

describe("encodeRequest", () => {
  it("appends a trailing newline", () => {
    const req: HelperRequest = { op: "ping", id: "p1" };
    const raw = encodeRequest(req);
    assert.equal(raw.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(raw.trim()), req);
  });

  it("round-trips a run request", () => {
    const req: HelperRequest = {
      op: "run",
      id: "r1",
      modelId: "pcc",
      prompt: "hi",
      instructions: "brief",
      greedy: true,
    };
    const decoded = JSON.parse(encodeRequest(req).trim());
    assert.equal(decoded.op, "run");
    assert.equal(decoded.modelId, "pcc");
    assert.equal(decoded.prompt, "hi");
    assert.equal(decoded.greedy, true);
  });
});

describe("decodeEvents", () => {
  it("parses complete lines and leaves a partial rest", () => {
    const buf =
      '{"id":"1","type":"text","data":"hel"}\n{"id":"1","type":"text","data":"lo"}\n{"id":"1","type":"do';
    const { events, rest } = decodeEvents(buf);
    assert.equal(events.length, 2);
    assert.equal((events[0] as { data: string }).data, "hel");
    assert.equal((events[1] as { data: string }).data, "lo");
    assert.equal(rest, '{"id":"1","type":"do');
  });

  it("skips blank and malformed lines", () => {
    const buf = '\nnot-json\n{"id":"x","type":"pong","version":"1"}\n';
    const { events, rest } = decodeEvents(buf);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "pong");
    assert.equal(rest, "");
  });

  it("requires id and type fields", () => {
    const buf = '{"foo":1}\n{"id":"a"}\n{"type":"text"}\n{"id":"b","type":"done","text":"ok","exitCode":0}\n';
    const { events } = decodeEvents(buf);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "done");
  });
});

describe("extractFinal", () => {
  it("returns the last done text", () => {
    const events: HelperEvent[] = [
      { id: "1", type: "text", data: "a" },
      { id: "1", type: "done", text: "final", exitCode: 0 },
      { id: "1", type: "text", data: "noise" },
    ];
    // last done wins even if followed by noise (shouldn't happen, but defensive)
    assert.equal(extractFinal(events), "final");
  });

  it("returns empty string when no done", () => {
    assert.equal(extractFinal([{ id: "1", type: "text", data: "x" }]), "");
  });
});
