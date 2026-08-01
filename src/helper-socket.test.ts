import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  ensureHelperDir,
  helperLogPath,
  helperPidPath,
  helperSocketPath,
  removeStaleSocket,
  socketExists,
} from "./helper-socket.ts";

describe("helper path resolution", () => {
  it("defaults under ~/.config/fm-acp", () => {
    const env = { HOME: "/tmp/fake-home" } as NodeJS.ProcessEnv;
    assert.equal(helperSocketPath(env), "/tmp/fake-home/.config/fm-acp/helper.sock");
    assert.equal(helperLogPath(env), "/tmp/fake-home/.config/fm-acp/helper.log");
    assert.equal(helperPidPath(env), "/tmp/fake-home/.config/fm-acp/helper.pid");
  });

  it("respects XDG_CONFIG_HOME", () => {
    const env = {
      HOME: "/tmp/fake-home",
      XDG_CONFIG_HOME: "/tmp/xdg",
    } as NodeJS.ProcessEnv;
    assert.equal(helperSocketPath(env), "/tmp/xdg/fm-acp/helper.sock");
  });

  it("honors FM_ACP_HELPER_SOCK / LOG / PID overrides", () => {
    const env = {
      HOME: "/tmp/fake-home",
      FM_ACP_HELPER_SOCK: "/custom/helper.sock",
      FM_ACP_HELPER_LOG: "/custom/helper.log",
      FM_ACP_HELPER_PID: "/custom/helper.pid",
    } as NodeJS.ProcessEnv;
    assert.equal(helperSocketPath(env), "/custom/helper.sock");
    assert.equal(helperLogPath(env), "/custom/helper.log");
    assert.equal(helperPidPath(env), "/custom/helper.pid");
  });

  it("derives log/pid next to a custom socket when only sock is set", () => {
    const env = {
      HOME: "/tmp/fake-home",
      FM_ACP_HELPER_SOCK: "/var/run/fm/helper.sock",
    } as NodeJS.ProcessEnv;
    assert.equal(helperLogPath(env), "/var/run/fm/helper.log");
    assert.equal(helperPidPath(env), "/var/run/fm/helper.pid");
  });
});

describe("ensureHelperDir + removeStaleSocket", () => {
  let tmp: string;

  after(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("creates the directory and removes a stale file", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-sock-"));
    const sock = path.join(tmp, "helper.sock");
    const env = { FM_ACP_HELPER_SOCK: sock } as NodeJS.ProcessEnv;

    const dir = await ensureHelperDir(env);
    assert.equal(dir, tmp);

    await writeFile(sock, "");
    assert.equal(socketExists(sock), true);
    await removeStaleSocket(sock);
    assert.equal(socketExists(sock), false);
    // second call is a no-op
    await removeStaleSocket(sock);
  });
});
