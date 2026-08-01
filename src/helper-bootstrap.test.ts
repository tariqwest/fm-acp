import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildAppleScript,
  defaultHelperBin,
  ensureHelper,
  helperSnapshot,
} from "./helper-bootstrap.ts";

async function closeServer(server: net.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  });
}

describe("buildAppleScript", () => {
  it("tells Terminal.app to do script with the helper bin (single launch)", () => {
    const script = buildAppleScript({
      helperBin: "/opt/fm-acp/bin/fm-acp-terminal-helper.mjs",
      socketPath: "/tmp/helper.sock",
      logPath: "/tmp/helper.log",
      pidPath: "/tmp/helper.pid",
      env: process.env,
    });
    assert.match(script, /tell application "Terminal"/);
    assert.match(script, /do script "/);
    assert.match(script, /fm-acp-terminal-helper\.mjs/);
    assert.match(script, /activate/);
    // Must not dual-launch via independent nohup shell.
    assert.doesNotMatch(script, /do shell script/);
    assert.doesNotMatch(script, /nohup/);
  });

  it("shell-quotes paths with special characters", () => {
    const script = buildAppleScript({
      helperBin: '/tmp/weird"path/helper.mjs',
      socketPath: "/tmp/helper.sock",
      logPath: "/tmp/helper.log",
      pidPath: "/tmp/helper.pid",
      env: process.env,
    });
    // Path is single-quoted for the shell; embedded quotes broken out safely.
    assert.match(script, /weird/);
    assert.match(script, /helper\.mjs/);
    assert.doesNotMatch(script, /do shell script/);
  });
});

describe("defaultHelperBin", () => {
  it("resolves relative to the package bin/", () => {
    const bin = defaultHelperBin();
    assert.match(bin, /fm-acp-terminal-helper\.mjs$/);
    assert.match(bin, /\/bin\//);
  });
});

describe("helperSnapshot", () => {
  it("reflects env overrides", () => {
    const snap = helperSnapshot({
      HOME: "/home/u",
      FM_ACP_HELPER_SOCK: "/s.sock",
      FM_ACP_AUTO_BOOTSTRAP: "1",
    } as NodeJS.ProcessEnv);
    assert.equal(snap.socketPath, "/s.sock");
    assert.equal(snap.autoBootstrap, true);
  });
});

describe("ensureHelper", () => {
  let tmp: string | null = null;
  let fakeServer: net.Server | null = null;

  afterEach(async () => {
    await closeServer(fakeServer);
    fakeServer = null;
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it("returns declined when auto is off and helper is down", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-boot-"));
    const sock = path.join(tmp, "helper.sock");
    // A real helper bin file so the existence check passes.
    const helperBin = path.join(tmp, "helper.mjs");
    await writeFile(helperBin, "#!/usr/bin/env node\n");

    const result = await ensureHelper({
      helperBin,
      auto: false,
      env: { HOME: tmp, FM_ACP_HELPER_SOCK: sock } as NodeJS.ProcessEnv,
      timeoutMs: 200,
    });
    assert.equal(result.status, "declined");
    if (result.status === "declined") {
      assert.match(result.reason, /helper not running/);
      assert.match(result.reason, /FM_ACP_AUTO_BOOTSTRAP/);
    }
  });

  it("returns already_running when a live socket is present", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-boot-"));
    const sock = path.join(tmp, "helper.sock");
    const helperBin = path.join(tmp, "helper.mjs");
    await writeFile(helperBin, "#!/usr/bin/env node\n");

fakeServer = net.createServer((c) => c.end());
    fakeServer.unref();
    await new Promise<void>((resolve, reject) => {
      fakeServer!.once("error", reject);
      fakeServer!.listen(sock, () => resolve());
    });

    const result = await ensureHelper({
      helperBin,
      auto: false,
      env: { HOME: tmp, FM_ACP_HELPER_SOCK: sock } as NodeJS.ProcessEnv,
    });
    assert.equal(result.status, "already_running");
    if (result.status === "already_running") {
      assert.equal(result.socketPath, sock);
    }
  });

  it("fails when helper binary is missing", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-boot-"));
    const sock = path.join(tmp, "helper.sock");
    const result = await ensureHelper({
      helperBin: path.join(tmp, "no-such-helper.mjs"),
      auto: true,
      env: { HOME: tmp, FM_ACP_HELPER_SOCK: sock } as NodeJS.ProcessEnv,
    });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.reason, /helper binary not found/);
    }
  });

  it("invokes osascript with the constructed script when auto is on", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-boot-"));
    const sock = path.join(tmp, "helper.sock");
    const helperBin = path.join(tmp, "helper.mjs");
    await writeFile(helperBin, "#!/usr/bin/env node\n");

    let capturedArgs: string[] | null = null;
    const fakeSpawn = ((_cmd: string, args: readonly string[]) => {
      capturedArgs = [...args];
// Immediately bring up a fake socket so waitForSocket succeeds.
      const s = net.createServer((c) => c.end());
      s.unref();
      fakeServer = s;
      s.listen(sock);
      const ee = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
      // minimal ChildProcess surface used by ensureHelper
      (ee as unknown as { kill: (sig?: string) => boolean }).kill = () => true;
      return ee;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await ensureHelper({
      helperBin,
      auto: true,
      env: { HOME: tmp, FM_ACP_HELPER_SOCK: sock } as NodeJS.ProcessEnv,
      timeoutMs: 2000,
      spawnOsascript: fakeSpawn,
    });

    assert.ok(capturedArgs);
    assert.equal(capturedArgs![0], "-e");
    assert.match(capturedArgs![1], /tell application "Terminal"/);
    assert.match(capturedArgs![1], new RegExp(helperBin.replace(/\//g, "\\/")));
    assert.equal(result.status, "started");
  });
});
