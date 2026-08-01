import fsp from "node:fs/promises";
import path from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function ensurePrivateDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fsp.chmod(dir, PRIVATE_DIR_MODE);
  } catch {
    // ignore filesystems that don't support chmod
  }
}

export async function writePrivateFile(
  filePath: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): Promise<void> {
  const mode = opts.mode ?? PRIVATE_FILE_MODE;
  await ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, data, { mode });
  try {
    await fsp.chmod(tmp, mode);
  } catch {
    // ignore
  }
  await fsp.rename(tmp, filePath);
  try {
    await fsp.chmod(filePath, mode);
  } catch {
    // ignore
  }
}

/** Best-effort chmod of existing state tree (dir 0700, files 0600). */
export async function migratePrivateTree(root: string): Promise<void> {
  try {
    await fsp.chmod(root, PRIVATE_DIR_MODE);
  } catch {
    return;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    try {
      if (ent.isDirectory()) {
        await fsp.chmod(full, PRIVATE_DIR_MODE);
        await migratePrivateTree(full);
      } else if (ent.isFile() || ent.isSocket()) {
        await fsp.chmod(full, PRIVATE_FILE_MODE);
      }
    } catch {
      // ignore individual failures
    }
  }
}
