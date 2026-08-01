import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CUA_DRIVER_ENSURE_ENV,
  ensureCuaDriver,
  resolveCuaDriverBin,
} from "./cua-driver.ts";

describe("cua-driver ensure", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it("resolveCuaDriverBin finds env override", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-cua-"));
    const bin = path.join(tmp, "cua-driver");
    await writeFile(bin, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    await chmod(bin, 0o755);
    const found = resolveCuaDriverBin({ CUA_DRIVER_BIN: bin, PATH: "" } as NodeJS.ProcessEnv);
    assert.equal(found, bin);
  });

  it("returns present without install when resolver finds bin", async () => {
    const result = await ensureCuaDriver({
      env: {} as NodeJS.ProcessEnv,
      resolveBin: () => "/opt/bin/cua-driver",
      installFn: async () => {
        throw new Error("should not install");
      },
    });
    assert.equal(result.status, "present");
    if (result.status === "present") assert.equal(result.bin, "/opt/bin/cua-driver");
  });

  it("skips install when ensure disabled", async () => {
    const result = await ensureCuaDriver({
      env: { [CUA_DRIVER_ENSURE_ENV]: "0" } as NodeJS.ProcessEnv,
      resolveBin: () => null,
      installFn: async () => {
        throw new Error("should not install");
      },
    });
    assert.equal(result.status, "skipped");
  });

  it("installs when missing and allowInstall", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "fm-acp-cua-"));
    const bin = path.join(tmp, "cua-driver");
    let installed = false;
    const result = await ensureCuaDriver({
      env: { HOME: tmp } as NodeJS.ProcessEnv,
      binDir: tmp,
      allowInstall: true,
      resolveBin: (env) => {
        // after install, PATH includes binDir
        if (installed && env.PATH?.includes(tmp!)) return bin;
        return null;
      },
      installFn: async () => {
        installed = true;
        await writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
      },
    });
    assert.equal(result.status, "installed");
    if (result.status === "installed") assert.equal(result.bin, bin);
  });

  it("reports failed install", async () => {
    const result = await ensureCuaDriver({
      env: {} as NodeJS.ProcessEnv,
      allowInstall: true,
      resolveBin: () => null,
      installFn: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.match(result.reason, /network down/);
  });
});
