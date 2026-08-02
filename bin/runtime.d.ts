export function launchEntry(opts: {
  entry: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "pipe";
}): import("node:child_process").ChildProcess;

export function packageRootFrom(importMetaUrl: string): string;
export function detectRuntime(env?: NodeJS.ProcessEnv): "bun" | "node" | null;
export function bunAvailable(env?: NodeJS.ProcessEnv): boolean;
export function runWithPreferredRuntime(
  entry: string,
  argv?: string[],
  env?: NodeJS.ProcessEnv,
): import("node:child_process").SpawnSyncReturns<string>;
