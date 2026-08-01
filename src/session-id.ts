import path from "node:path";

/** Strict UUID (v1–v8 / nil-safe hex form used by crypto.randomUUID). */
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string): boolean {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
}

export function assertValidSessionId(sessionId: string): string {
  const id = sessionId?.trim?.() ?? "";
  if (!isValidSessionId(id)) {
    const err = Object.assign(new Error(`invalid sessionId: ${sessionId || "(empty)"}`), {
      code: -32602,
    });
    throw err;
  }
  return id;
}

/**
 * Build a transcript path under transcriptsDir for a validated session id.
 * Rejects any id that could escape via path segments.
 */
export function safeTranscriptPath(transcriptsDir: string, sessionId: string): string {
  const id = assertValidSessionId(sessionId);
  const root = path.resolve(transcriptsDir);
  const candidate = path.resolve(root, `${id}.json`);
  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = Object.assign(new Error(`transcript path escapes store: ${sessionId}`), {
      code: -32602,
    });
    throw err;
  }
  return candidate;
}

/** Ensure an absolute path stays inside root (after resolve). */
export function assertPathInsideRoot(rootDir: string, absolutePath: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(absolutePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = Object.assign(new Error(`path escapes root: ${absolutePath}`), {
      code: -32602,
    });
    throw err;
  }
  return resolved;
}
