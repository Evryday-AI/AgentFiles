import { randomUUID } from "node:crypto";
import { open, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Queryable } from "./db.js";
import { transaction } from "./filesRepo.js";
import { verifyStorageRoot } from "./storage.js";

export const VOLUME_MARKER = ".agentfiles-volume";
async function marker(root: string): Promise<string | null> {
  await verifyStorageRoot(root);
  const path = join(root, VOLUME_MARKER);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 36)
      throw new Error("Storage volume marker is invalid");
    const id = await readFile(path, "utf8");
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw new Error("Storage volume marker is invalid");
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function verifyStorageAssociation(
  root: string,
  db: Queryable,
): Promise<void> {
  const id = await marker(root);
  const result = await db.query<{ volume_id: string }>(
    "SELECT volume_id FROM storage_volume_identity WHERE singleton",
  );
  if (!id || result.rows[0]?.volume_id !== id)
    throw new Error("Storage volume identity is unconfirmed");
}
export async function initializeStorageAssociation(
  root: string,
  db: Queryable,
): Promise<void> {
  await transaction(db, async (pinned) => {
    await pinned.query("SELECT pg_advisory_xact_lock(1946157021)");
    const existing = await pinned.query<{ volume_id: string }>(
      "SELECT volume_id FROM storage_volume_identity WHERE singleton",
    );
    if (existing.rows.length) {
      await verifyStorageAssociation(root, pinned);
      return;
    }
    const history = await pinned.query(
      "SELECT 1 FROM issued_file_codes LIMIT 1",
    );
    if (history.rows.length)
      throw new Error(
        "Nonempty installation requires verified storage volume recovery",
      );
    let id = await marker(root);
    if (!id) {
      id = randomUUID();
      const handle = await open(join(root, VOLUME_MARKER), "wx", 0o600);
      try {
        await handle.writeFile(id);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await pinned.query(
      "INSERT INTO storage_volume_identity(singleton,volume_id) VALUES(true,$1)",
      [id],
    );
  });
}
