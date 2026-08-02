#!/usr/bin/env node
/** Runtime: plain ESM — works under Bun or Node (npm/npx). Prefer `bun bin/fm-acp-terminal-helper.mjs` in dev. */
/**
 * fm-acp-terminal-helper
 *
 * Long-lived daemon that owns a Terminal.app ancestor process and exposes a
 * Unix socket for `fm-acp` to send `fm respond` requests to. This is the
 * legitimate way to obtain Private Cloud Compute attribution when fm-acp is
 * launched from a GUI process (Zed, VS Code, etc).
 *
 * Run manually inside Terminal.app:
 *   fm-acp-terminal-helper
 *
 * Or set FM_ACP_AUTO_BOOTSTRAP=1 in the host environment to let fm-acp spawn
 * this via AppleScript.
 *
 * Protocol: newline-delimited JSON. See src/helper-protocol.ts.
 *
 *   {"op":"ping","id":"p1"}                     → {"type":"pong","id":"p1",...}
 *   {"op":"run","id":"r1","modelId":"pcc",...}  → {"type":"started",...},
 *                                                  {"type":"text","data":"..."}*,
 *                                                  {"type":"done","text":...,"exitCode":n}
 *   {"op":"shutdown","id":"s1"}                 → closes connection, keeps daemon alive
 */

import net from "node:net";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

// Mirror of src/helper-protocol.ts. Kept in lockstep; the wire format is the
// contract, not the JS shape. If you change one, change the other.
const PROTOCOL_VERSION = "1";

function encode(obj) {
  return JSON.stringify(obj) + "\n";
}

function logToFile(logPath, ...args) {
  if (!logPath) return;
  try {
    const line =
      `[${new Date().toISOString()}] ${args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")}\n`;
    appendFileSync(logPath, line);
  } catch {
    // swallow — logging must never crash the helper
  }
}

// Resolve paths the same way src/helper-socket.ts does.
function socketPath(env) {
  const override = env.FM_ACP_HELPER_SOCK?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || os.homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path.join(home, ".config");
  return path.join(base, "fm-acp", "helper.sock");
}

function logPath(env, sock) {
  const override = env.FM_ACP_HELPER_LOG?.trim();
  if (override) return override;
  return path.join(path.dirname(sock), "helper.log");
}

function pidPath(env, sock) {
  const override = env.FM_ACP_HELPER_PID?.trim();
  if (override) return override;
  return path.join(path.dirname(sock), "helper.pid");
}

function ensureDirSync(p) {
  try {
    mkdirSync(p, { recursive: true });
  } catch {
    // ignore
  }
}

// Build the `fm respond` argv. Mirrors buildFmRespondArgs in src/backends/fm.ts.
function buildFmRespondArgs(opts) {
  const args = ["respond", "--model", opts.modelId];
  if (opts.instructions) args.push("--instructions", opts.instructions);
  if (opts.useCase) args.push("--use-case", opts.useCase);
  if (opts.guardrails) args.push("--guardrails", opts.guardrails);
  if (opts.greedy) args.push("--greedy");
  if (opts.stream === false) args.push("--no-stream");
  if (opts.transcriptPath) {
    if (opts.resume && existsSync(opts.transcriptPath)) {
      args.push("--resume", opts.transcriptPath);
    }
    args.push("--save-transcript", opts.transcriptPath);
  }
  for (const img of opts.images ?? []) {
    args.push("--image", img.path);
    if (img.label) args.push("--label", img.label);
  }
  args.push(opts.prompt);
  return args;
}

function resolveFmBin(env) {
  if (env.FM_BIN_PATH?.trim() && existsSync(env.FM_BIN_PATH.trim()))
    return env.FM_BIN_PATH.trim();
  if (env.FM_BIN?.trim() && existsSync(env.FM_BIN.trim()))
    return env.FM_BIN.trim();
  if (existsSync("/usr/bin/fm")) return "/usr/bin/fm";
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const cand = `${dir.replace(/\/$/, "")}/fm`;
    if (existsSync(cand)) return cand;
  }
  return null;
}

function writePidFile(pidFile) {
  try {
    mkdirSync(path.dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, `${process.pid}\n`);
  } catch (err) {
    console.error(`[helper] failed to write pid file ${pidFile}:`, err.message);
  }
}

// ---------- Server ----------

const env = process.env;
const SOCK = socketPath(env);
const LOGP = logPath(env, SOCK);
const PIDP = pidPath(env, SOCK);

// Restrict new files/dirs/sockets to owner.
try {
  process.umask(0o077);
} catch {
  // ignore
}

ensureDirSync(path.dirname(SOCK));
try {
  chmodSync(path.dirname(SOCK), 0o700);
} catch {
  // ignore
}

const startedAt = Date.now();
/** Daemon-global single active child (not per-connection). */
let globalActiveChild = null;
let globalActiveExited = true;

const server = net.createServer({ allowHalfOpen: false }, (socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.setNoDelay(true);

  const send = (obj) => {
    try {
      socket.write(encode(obj));
    } catch {
      // socket may have closed mid-write
    }
  };

  // First read: announce readiness.
  send({ id: "0", type: "ready", pid: process.pid, uptimeMs: Date.now() - startedAt, version: PROTOCOL_VERSION });

  const killActive = (signal = "SIGTERM") => {
    if (!globalActiveChild || globalActiveExited) return;
    try {
      globalActiveChild.kill(signal);
    } catch {
      // ignore
    }
    if (signal === "SIGTERM") {
      setTimeout(() => {
        if (!globalActiveExited && globalActiveChild) {
          try {
            globalActiveChild.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 1500).unref?.();
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let req;
      try {
        req = JSON.parse(t);
      } catch {
        send({ id: "?", type: "error", message: "malformed json request" });
        continue;
      }
      if (typeof req?.op !== "string") {
        send({ id: String(req?.id ?? "?"), type: "error", message: "missing op" });
        continue;
      }
      handleRequest(req);
    }
  });

  socket.on("error", (err) => {
    logToFile(LOGP, "socket error:", err.message);
  });

  socket.on("close", () => {
    killActive("SIGTERM");
  });

  function handleRequest(req) {
    switch (req.op) {
      case "ping":
        send({
          id: req.id,
          type: "pong",
          version: PROTOCOL_VERSION,
        });
        return;
      case "shutdown":
        send({ id: req.id, type: "done", text: "", exitCode: 0 });
        try {
          socket.end();
        } catch {
          // ignore
        }
        return;
      case "run": {
        if (globalActiveChild && !globalActiveExited) {
          send({
            id: req.id,
            type: "error",
            message: "another run is in progress",
            code: -32000,
          });
          return;
        }
        const fmBin = resolveFmBin(env);
        if (!fmBin) {
          send({
            id: req.id,
            type: "error",
            message: "fm binary not found",
            code: -32001,
          });
          return;
        }
        const args = buildFmRespondArgs({
          modelId: req.modelId,
          prompt: req.prompt ?? "",
          instructions: req.instructions ?? null,
          useCase: req.useCase ?? null,
          guardrails: req.guardrails ?? null,
          greedy: req.greedy ?? null,
          transcriptPath: req.transcriptPath ?? null,
          resume: Boolean(req.resume),
          stream: true,
          images: req.images ?? [],
        });
        let child;
        try {
          child = spawn(fmBin, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env,
          });
        } catch (err) {
          send({
            id: req.id,
            type: "error",
            message: `failed to spawn fm: ${err.message}`,
          });
          return;
        }
        globalActiveChild = child;
        globalActiveExited = false;
        // Do not echo full argv (contains prompts/instructions).
        send({
          id: req.id,
          type: "started",
          bin: fmBin,
          modelId: req.modelId ?? null,
        });

        let stdoutBuf = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdoutBuf += chunk;
          send({ id: req.id, type: "text", data: chunk });
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          logToFile(LOGP, "fm stderr:", chunk);
        });

        child.on("error", (err) => {
          send({
            id: req.id,
            type: "error",
            message: `fm spawn error: ${err.message}`,
          });
        });

        child.on("close", (code) => {
          globalActiveExited = true;
          globalActiveChild = null;
          send({
            id: req.id,
            type: "done",
            text: stdoutBuf,
            exitCode: code ?? 0,
            transcriptPath: req.transcriptPath ?? null,
          });
          try {
            socket.end();
          } catch {
            // ignore
          }
        });
        return;
      }
      default:
        send({
          id: String(req.id ?? "?"),
          type: "error",
          message: `unknown op: ${req.op}`,
        });
    }
  }
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`[helper] socket already in use: ${SOCK}`);
    process.exit(1);
  }
  logToFile(LOGP, "server error:", err.message);
  console.error(`[helper] server error: ${err.message}`);
  process.exit(1);
});

// If a stale socket file exists, remove it only when bind would fail otherwise.
// Prefer exclusive bind: if another helper is live, exit.
function listenExclusive() {
  if (existsSync(SOCK)) {
    try {
      unlinkSync(SOCK);
    } catch (err) {
      console.error(`[helper] could not remove socket ${SOCK}:`, err.message);
      process.exit(1);
    }
  }
  server.listen(SOCK, () => {
    try {
      chmodSync(SOCK, 0o600);
    } catch {
      // ignore
    }
    try {
      writeFileSync(PIDP, `${process.pid}\n`, { mode: 0o600 });
      chmodSync(PIDP, 0o600);
    } catch (err) {
      console.error(`[helper] failed to write pid file ${PIDP}:`, err.message);
    }
    logToFile(LOGP, `helper listening on ${SOCK} pid=${process.pid}`);
    console.error(`[helper] listening on ${SOCK} (pid=${process.pid})`);
  });
}
listenExclusive();

// Heartbeat so users can `tail -f` helper.log and see we're alive.
const heartbeat = setInterval(() => {
  logToFile(
    LOGP,
    `heartbeat uptime=${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
}, 30_000);
heartbeat.unref();

const shutdown = (signal) => {
  logToFile(LOGP, `received ${signal}, shutting down`);
  clearInterval(heartbeat);
  server.close(() => {
    try {
      if (existsSync(SOCK)) unlinkSync(SOCK);
    } catch {
      // ignore
    }
    try {
      if (existsSync(PIDP)) unlinkSync(PIDP);
    } catch {
      // ignore
    }
    process.exit(0);
  });
  // Hard exit after 2s if connections linger.
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));