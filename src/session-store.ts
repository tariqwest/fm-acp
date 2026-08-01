import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensurePrivateDir,
  migratePrivateTree,
  writePrivateFile,
} from "./private-fs.ts";
import { assertValidSessionId, safeTranscriptPath } from "./session-id.ts";
import {
  SessionStoreSchema,
  type Session,
  type SessionStoreFile,
  type StoredSession,
} from "./types.ts";

export type SessionStorePaths = {
  stateDir: string;
  stateFile: string;
  lockFile: string;
  transcriptsDir: string;
};

export function defaultStorePaths(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME || os.homedir(),
): SessionStorePaths {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const stateDir = xdgConfigHome
    ? path.join(xdgConfigHome, "fm-acp")
    : path.join(home, ".config", "fm-acp");
  return {
    stateDir,
    stateFile: path.join(stateDir, "sessions.json"),
    lockFile: path.join(stateDir, "sessions.lock"),
    transcriptsDir: path.join(stateDir, "transcripts"),
  };
}

function storedFromSession(session: Session): StoredSession {
  return {
    modelId: session.modelId,
    backendId: session.backendId,
    instructions: session.instructions,
    useCase: session.useCase,
    guardrails: session.guardrails,
    greedy: session.greedy,
    bridgeEnabled: session.bridgeEnabled,
    cwd: session.cwd,
    transcriptPath: session.transcriptPath,
    history: session.history,
    seenKeys: [...session.seenKeys],
    title: session.title,
    updatedAt: session.updatedAt ?? new Date().toISOString(),
  };
}

export function sessionFromStored(stored: StoredSession, fallbackCwd: string): Session {
  return {
    modelId: stored.modelId ?? null,
    backendId: stored.backendId ?? null,
    instructions: stored.instructions ?? null,
    useCase: stored.useCase ?? null,
    guardrails: stored.guardrails ?? null,
    greedy: stored.greedy ?? null,
    bridgeEnabled: stored.bridgeEnabled ?? null,
    cwd: stored.cwd || fallbackCwd,
    transcriptPath: stored.transcriptPath ?? null,
    history: stored.history ?? [],
    seenKeys: new Set(stored.seenKeys ?? []),
    title: stored.title ?? null,
    updatedAt: stored.updatedAt ?? null,
    activeAbort: null,
  };
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

async function tryRemoveStaleLock(lockFile: string): Promise<boolean> {
  try {
    const st = await fsp.stat(lockFile);
    const age = Date.now() - st.mtimeMs;
    if (age > LOCK_STALE_MS) {
      await fsp.unlink(lockFile);
      return true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
  }
  return false;
}

async function withExclusiveLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
  await ensurePrivateDir(path.dirname(lockFile));
  const start = Date.now();
  let handle: fsp.FileHandle | null = null;
  while (!handle) {
    try {
      handle = await fsp.open(lockFile, "wx");
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        const removed = await tryRemoveStaleLock(lockFile);
        if (removed) continue;
        throw new Error(`timed out waiting for session store lock: ${lockFile}`);
      }
      if (Date.now() - start > 2_000) {
        await tryRemoveStaleLock(lockFile);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fsp.unlink(lockFile).catch(() => undefined);
  }
}

export class SessionStore {
  readonly paths: SessionStorePaths;
  private migrated = false;
  private corrupt = false;
  private corruptError: Error | null = null;

  constructor(paths: SessionStorePaths = defaultStorePaths()) {
    this.paths = paths;
  }

  async init(): Promise<void> {
    await ensurePrivateDir(this.paths.stateDir);
    await ensurePrivateDir(this.paths.transcriptsDir);
    if (!this.migrated) {
      await migratePrivateTree(this.paths.stateDir);
      this.migrated = true;
    }
  }

  transcriptPathFor(sessionId: string): string {
    return safeTranscriptPath(this.paths.transcriptsDir, sessionId);
  }

  private async loadUnlocked(): Promise<SessionStoreFile> {
    try {
      const raw = await fsp.readFile(this.paths.stateFile, "utf8");
      const parsed = SessionStoreSchema.parse(JSON.parse(raw));
      this.corrupt = false;
      this.corruptError = null;
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.corrupt = false;
        this.corruptError = null;
        return { sessions: {} };
      }
      this.corrupt = true;
      this.corruptError = err instanceof Error ? err : new Error(String(err));
      console.error("[fm-acp] ERROR: session store corrupt or unreadable:", err);
      try {
        const bak = `${this.paths.stateFile}.corrupt.${Date.now()}`;
        await fsp.rename(this.paths.stateFile, bak);
        console.error(`[fm-acp] quarantined corrupt store to ${bak}`);
      } catch {
        // ignore quarantine failure
      }
      throw new Error(
        `session store unreadable; quarantined if possible. Fix or remove ${this.paths.stateFile}`,
        { cause: err },
      );
    }
  }

  private assertWritable() {
    if (this.corrupt) {
      throw new Error(
        `session store is in corrupt state and refuses writes: ${this.corruptError?.message ?? "unknown"}`,
      );
    }
  }

  async get(sessionId: string): Promise<StoredSession | null> {
    const id = assertValidSessionId(sessionId);
    await this.init();
    return withExclusiveLock(this.paths.lockFile, async () => {
      const store = await this.loadUnlocked();
      return store.sessions[id] ?? null;
    });
  }

  async list(): Promise<Array<{ sessionId: string } & StoredSession>> {
    await this.init();
    return withExclusiveLock(this.paths.lockFile, async () => {
      const store = await this.loadUnlocked();
      return Object.entries(store.sessions).map(([sessionId, stored]) => ({
        sessionId,
        ...stored,
      }));
    });
  }

  async save(sessionId: string, session: Session): Promise<void> {
    const id = assertValidSessionId(sessionId);
    await this.init();
    await withExclusiveLock(this.paths.lockFile, async () => {
      this.assertWritable();
      let store: SessionStoreFile;
      try {
        store = await this.loadUnlocked();
      } catch {
        throw new Error("refusing to save over unreadable session store");
      }
      store.sessions[id] = storedFromSession(session);
      await this.writeUnlocked(store);
    });
  }

  async delete(sessionId: string): Promise<void> {
    const id = assertValidSessionId(sessionId);
    await this.init();
    await withExclusiveLock(this.paths.lockFile, async () => {
      this.assertWritable();
      let store: SessionStoreFile;
      try {
        store = await this.loadUnlocked();
      } catch {
        throw new Error("refusing to delete while session store is unreadable");
      }
      delete store.sessions[id];
      await this.writeUnlocked(store);
    });
    const tp = this.transcriptPathFor(id);
    await fsp.unlink(tp).catch(() => undefined);
  }

  private async writeUnlocked(store: SessionStoreFile): Promise<void> {
    await ensurePrivateDir(this.paths.stateDir);
    await writePrivateFile(this.paths.stateFile, JSON.stringify(store, null, 2));
  }
}
