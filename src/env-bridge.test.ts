import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFmAccessPccEnvBridge, withLabBridgeEnv } from "./env-bridge.ts";

describe("applyFmAccessPccEnvBridge", () => {
  it("maps FM_ACP_* into FM_ACCESS_PCC_* when unset", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/Users/t",
      FM_ACP_SERVE_SOCK: "/tmp/acp.sock",
      FM_ACP_AUTO_SERVE: "0",
    };
    applyFmAccessPccEnvBridge(env);
    assert.equal(env.FM_ACCESS_PCC_SERVE_SOCK, "/tmp/acp.sock");
    assert.equal(env.FM_ACCESS_PCC_AUTO_SERVE, "0");
    assert.equal(env.FM_ACP_SERVE_SOCK, "/tmp/acp.sock");
  });

  it("defaults socket under ~/.config/fm-acp", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/Users/t", XDG_CONFIG_HOME: "" };
    applyFmAccessPccEnvBridge(env);
    assert.match(env.FM_ACCESS_PCC_SERVE_SOCK ?? "", /fm-acp\/fm\.sock$/);
    assert.match(env.FM_ACP_SERVE_SOCK ?? "", /fm-acp\/fm\.sock$/);
    assert.match(env.FM_ACCESS_PCC_SERVE_LAUNCHER ?? "", /start-fm-serve\.command$/);
  });

  it("does not clobber existing FM_ACCESS_PCC values", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/Users/t",
      FM_ACP_SERVE_SOCK: "/tmp/acp.sock",
      FM_ACCESS_PCC_SERVE_SOCK: "/tmp/lib.sock",
    };
    applyFmAccessPccEnvBridge(env);
    assert.equal(env.FM_ACCESS_PCC_SERVE_SOCK, "/tmp/lib.sock");
  });
});

describe("withLabBridgeEnv", () => {
  it("temporarily sets FM_ACCESS_PCC_LAB_BRIDGE", () => {
    const env: NodeJS.ProcessEnv = {};
    const restore = withLabBridgeEnv(false, env);
    assert.equal(env.FM_ACCESS_PCC_LAB_BRIDGE, "0");
    restore();
    assert.equal(env.FM_ACCESS_PCC_LAB_BRIDGE, undefined);
  });
});
