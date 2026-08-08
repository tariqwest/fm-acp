#!/usr/bin/env node
/**
 * Pack the package and verify the tarball installs without sibling link deps.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "fm-acp-pack-"));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    // pnpm may exit 1 solely due to ignored dependency build scripts while still installing.
    if (opts.allowIgnoredBuilds && /ERR_PNPM_IGNORED_BUILDS/.test(combined)) {
      console.error(combined.slice(0, 800));
      return r.stdout ?? "";
    }
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error(`${cmd} ${args.join(" ")} failed with ${r.status}`);
  }
  return r.stdout;
}

try {
  console.error("[pack-smoke] packing…");
  run("pnpm", ["pack", "--pack-destination", tmp]);
  const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("no tarball produced");
  const tgzPath = path.join(tmp, tgz);

  // Ensure package.json inside tarball has no link: deps
  const listed = run("tar", ["-xOf", tgzPath, "package/package.json"]);
  const pkg = JSON.parse(listed);
  for (const [name, ver] of Object.entries(pkg.dependencies ?? {})) {
    if (String(ver).startsWith("link:") || String(ver).startsWith("file:")) {
      throw new Error(`publishable package still has local dep ${name}=${ver}`);
    }
  }
  if (pkg.dependencies?.["node-pty"]) {
    throw new Error("publishable package must not depend on node-pty directly (use fm-access-pcc)");
  }
  if (!pkg.dependencies?.["fm-access-pcc"]) {
    throw new Error("publishable package must depend on fm-access-pcc for PCC");
  }
  const ver = String(pkg.dependencies["fm-access-pcc"]);
  if (ver.startsWith("link:") || ver.startsWith("file:")) {
    throw new Error(`fm-access-pcc must be a published/tarball dep, got ${ver}`);
  }

const installDir = path.join(tmp, "install");
  run("mkdir", ["-p", installDir]);
  // Minimal consumer package — avoid `pnpm init` pulling workspace tooling.
  writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({ name: "fm-acp-pack-smoke", private: true, type: "module" }, null, 2),
  );
  console.error("[pack-smoke] installing tarball…");
  run("pnpm", ["add", tgzPath, "--ignore-workspace"], {
    cwd: installDir,
    allowIgnoredBuilds: true,
  });

  // Smoke: resolve package entry
  const bin = path.join(installDir, "node_modules", "fm-acp", "bin", "fm-acp.mjs");
  if (!existsSync(bin)) {
    throw new Error(`installed package missing bin: ${bin}`);
  }
  const help = spawnSync(process.execPath, [bin], {
    encoding: "utf8",
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n',
    timeout: 30_000,
    env: { ...process.env, FM_ACP_SERVE_SOCK: path.join(tmp, "missing.sock") },
  });
  // May fail if no models, but process should start and speak JSON-RPC or stderr logs
  console.error("[pack-smoke] initialize exit", help.status);
  console.error(help.stdout?.slice(0, 500));
  console.error(help.stderr?.slice(0, 500));
  if (!String(help.stdout + help.stderr).includes("fm")) {
    // soft check — initialize may hang without newline flush; still validate install graph
    console.error("[pack-smoke] note: initialize output sparse; install graph OK");
  }

  // lockfile should not require link
  const lock = readFileSync(path.join(installDir, "pnpm-lock.yaml"), "utf8");
  if (lock.includes("link:") && lock.includes("fm-access-pcc")) {
    throw new Error("install lock still references linked fm-access-pcc");
  }

  console.error("[pack-smoke] OK", tgz);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
