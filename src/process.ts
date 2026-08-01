import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { split as splitShellWords } from "./shell-words.ts";
import { FmAcpError } from "./types.ts";

export type RunCommandOptions = {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
  stdin?: string | null;
};

export type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function attachAbort(child: ChildProcessWithoutNullStreams, signal?: AbortSignal) {
  if (!signal) return () => undefined;
  let exited = false;
  const onExit = () => {
    exited = true;
  };
  child.once("exit", onExit);
  child.once("close", onExit);

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 1500).unref();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
    child.removeListener("exit", onExit);
    child.removeListener("close", onExit);
  };
}

export async function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  return await new Promise<RunCommandResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new FmAcpError(`failed to spawn ${opts.bin}: ${(err as Error).message}`, {
          details: String(err),
        }),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let callbackChain: Promise<void> = Promise.resolve();
    const detachAbort = attachAbort(child, opts.signal);

    const enqueue = (fn: () => void | Promise<void>) => {
      callbackChain = callbackChain.then(fn, fn);
      return callbackChain;
    };

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 1500).unref();
      }, opts.timeoutMs);
      timer.unref();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (opts.onStdout) {
        void enqueue(() => opts.onStdout!(chunk));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (opts.onStderr) {
        void enqueue(() => opts.onStderr!(chunk));
      }
    });

    if (opts.stdin != null) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }

    const finish = async (fn: () => void) => {
      if (settled) return;
      settled = true;
      timer && clearTimeout(timer);
      detachAbort();
      try {
        await callbackChain;
      } catch (err) {
        reject(
          err instanceof FmAcpError
            ? err
            : new FmAcpError(`stream callback failed: ${(err as Error).message}`),
        );
        return;
      }
      fn();
    };

    child.on("error", (err) => {
      void finish(() => {
        reject(
          new FmAcpError(`failed to spawn ${opts.bin}: ${err.message}`, {
            details: err.message,
          }),
        );
      });
    });

    child.on("close", (code, signalName) => {
      void finish(() => {
        if (opts.signal?.aborted) {
          reject(new FmAcpError("cancelled"));
          return;
        }
        if (timedOut) {
          reject(
            new FmAcpError(`command timed out after ${opts.timeoutMs}ms: ${opts.bin}`, {
              details: stderr.slice(0, 2000),
            }),
          );
          return;
        }
        // Preserve signal termination as non-zero when code is null.
        const exitCode = code == null ? (signalName ? 1 : 0) : code;
        resolve({
          stdout,
          stderr,
          exitCode,
        });
      });
    });
  });
}

export function parseExtraArgs(envName: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[envName]?.trim();
  if (!raw) return [];
  try {
    return splitShellWords(raw);
  } catch (err) {
    console.error(`[fm-acp] WARN: failed to parse ${envName}, ignoring:`, err);
    return [];
  }
}

export function resolveBinary(
  names: string[],
  opts: {
    envPathKeys?: string[];
    defaultPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | null {
  const env = opts.env ?? process.env;
  for (const key of opts.envPathKeys ?? []) {
    const v = env[key]?.trim();
    if (v && existsSync(v)) return v;
  }
  for (const name of names) {
    if (name.includes("/") && existsSync(name)) return name;
    const found = whichPath(name, env);
    if (found) return found;
  }
  if (opts.defaultPath && existsSync(opts.defaultPath)) return opts.defaultPath;
  return null;
}

function whichPath(bin: string, env: NodeJS.ProcessEnv): string | null {
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\/$/, "")}/${bin}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function extractCliError(stdout: string, stderr: string): string | null {
  const combined = `${stderr}\n${stdout}`.trim();
  if (!combined) return null;

  for (const line of combined.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.status === "error" && typeof obj.message === "string") {
        return obj.message;
      }
      if (typeof obj.message === "string" && /error/i.test(String(obj.status ?? "error"))) {
        return obj.message;
      }
    } catch {
      // ignore
    }
  }

  const errLine = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("Error:") || l.startsWith("error:"));
  if (errLine) return errLine.replace(/^Error:\s*/i, "");

  try {
    const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (obj.status === "error" && typeof obj.message === "string") return obj.message;
  } catch {
    // ignore
  }

  return null;
}
