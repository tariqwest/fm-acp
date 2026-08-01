import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  AUTO_SERVE_ENV,
  buildCuaDriverLaunchArgs,
  buildServeLauncherScript,
  ensureFmServe,
  ensureServeLauncher,
} from "./serve-bootstrap.ts";

describe("serve-bootstrap", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it("builds a zsh launcher that execs fm serve", () => {
    const s = buildServeLauncherScript("/tmp/fm.sock", "/usr/bin/fm");
    assert.match(s, /^#!\/bin\/zsh/m);
    assert.match(s, /serve --socket/);
    assert.match(s, /BIN='\/usr\/bin\/fm'/);
    assert.match(s, /\/tmp\/fm\.sock/);
  });

  it("writes executable launcher once", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-serve-"));
    const launcher = path.join(tmp, "start-fm-serve.command");
    const sock = path.join(tmp, "fm.sock");
    await ensureServeLauncher({ socketPath: sock, launcherPath: launcher });
    const body = await readFile(launcher, "utf8");
    assert.match(body, /serve --socket/);
    assert.ok(body.includes(sock));
  });

  it("buildCuaDriverLaunchArgs matches validated Phase 0 shape", () => {
    const args = buildCuaDriverLaunchArgs("/tmp/start.command");
    assert.equal(args[0], "call");
    assert.equal(args[1], "launch_app");
    const payload = JSON.parse(args[2]!);
    assert.equal(payload.bundle_id, "com.apple.Terminal");
    assert.deepEqual(payload.additional_arguments, ["/tmp/start.command"]);
    assert.equal(payload.creates_new_application_instance, true);
    assert.equal(args[3], "--compact");
  });

  it("declines when auto is off and serve is down", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-serve-"));
    const sock = path.join(tmp, "missing.sock");
    const result = await ensureFmServe({
      auto: false,
      socketPath: sock,
      launcherPath: path.join(tmp, "start.command"),
      healthFn: async () => null,
      env: { HOME: tmp } as NodeJS.ProcessEnv,
    });
    assert.equal(result.status, "declined");
    if (result.status === "declined") {
      assert.match(result.reason, new RegExp(AUTO_SERVE_ENV));
    }
  });

  it("returns already_running when health is up", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-serve-"));
    const sock = path.join(tmp, "fm.sock");
    const result = await ensureFmServe({
      auto: true,
      socketPath: sock,
      launcherPath: path.join(tmp, "start.command"),
      healthFn: async () => ({ status: "ok", models: [] }),
      env: { HOME: tmp } as NodeJS.ProcessEnv,
    });
    assert.equal(result.status, "already_running");
  });

  it("starts via cua-driver when auto and health becomes ready", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-serve-"));
    const sock = path.join(tmp, "fm.sock");
    const launcher = path.join(tmp, "start.command");
    let calls = 0;
    const spawned: { cmd: string; args: string[] } = { cmd: "", args: [] };

    const fakeSpawn = ((cmd: string, args: readonly string[]) => {
      spawned.cmd = cmd;
      spawned.args = [...args];
      const ee = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
      (ee as unknown as { unref: () => void }).unref = () => undefined;
      return ee;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await ensureFmServe({
      auto: true,
      socketPath: sock,
      launcherPath: launcher,
      timeoutMs: 1000,
      env: { HOME: tmp } as NodeJS.ProcessEnv,
      spawnFn: fakeSpawn,
      resolveCuaDriver: () => "/opt/bin/cua-driver",
      healthFn: async () => {
        calls += 1;
        // first probe: down; after spawn probes: up
        if (calls === 1) return null;
        return { status: "fm serve is running", models: [{ name: "pcc", available: true }] };
      },
    });

    assert.equal(result.status, "started");
    if (result.status === "started") {
      assert.equal(result.method, "cua-driver");
    }
    assert.equal(spawned.cmd, "/opt/bin/cua-driver");
    assert.equal(spawned.args[0], "call");
    assert.equal(spawned.args[1], "launch_app");
  });

  it("falls back to open -a Terminal when cua-driver missing", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-serve-"));
    const sock = path.join(tmp, "fm.sock");
    const launcher = path.join(tmp, "start.command");
    const spawned: { cmd: string; args: string[] } = { cmd: "", args: [] };
    let calls = 0;

    const fakeSpawn = ((cmd: string, args: readonly string[]) => {
      spawned.cmd = cmd;
      spawned.args = [...args];
      const ee = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
      (ee as unknown as { unref: () => void }).unref = () => undefined;
      return ee;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await ensureFmServe({
      auto: true,
      socketPath: sock,
      launcherPath: launcher,
      timeoutMs: 800,
      env: { HOME: tmp } as NodeJS.ProcessEnv,
      spawnFn: fakeSpawn,
      resolveCuaDriver: () => null,
      healthFn: async () => {
        calls += 1;
        if (calls <= 1) return null;
        return { status: "ok" };
      },
    });

    assert.equal(result.status, "started");
    if (result.status === "started") assert.equal(result.method, "open-terminal");
    assert.equal(spawned.cmd, "open");
    assert.deepEqual(spawned.args.slice(0, 2), ["-a", "Terminal"]);
  });
});
