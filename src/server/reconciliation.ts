import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Queryable } from "./db.js";
import type { ActiveUploads } from "./activeUploads.js";
import { deleteStoredFile, verifyStorageRoot } from "./storage.js";
import { reconcileUpload } from "./filesRepo.js";
import { verifyStorageAssociation } from "./storageIdentity.js";

// Only two fixed, app-owned directories. No recursive traversal or arbitrary
// filenames. A temp hardlink is just a removable directory entry, not authority
// to remove any final path referring to that inode.
export async function reconcileStorage(input: {
  root: string;
  db: Queryable;
  activeUploads: ActiveUploads;
  graceMs: number;
  now: Date;
}): Promise<{ removedBytes: number; failures: number }> {
  let removedBytes = 0,
    failures = 0;
  await verifyStorageRoot(input.root);
  await verifyStorageAssociation(input.root, input.db);
  const removedInodes = new Set<string>();
  for (const directory of [".tmp", "files"]) {
    const path = join(input.root, directory);
    let entries;
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        failures++;
        continue;
      }
      entries = await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failures++;
      continue;
    }
    for (const name of entries) {
      const key = `${directory}/${name}`;
      try {
        const info = await lstat(join(path, name));
        if (!info.isFile() || info.isSymbolicLink()) {
          failures++;
          continue;
        }
        const uuid =
          "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
        const pattern = new RegExp(
          `^${uuid}${directory === ".tmp" ? "\\.upload" : "(?:\\.[a-z0-9]{1,15})?"}$`,
        );
        if (!pattern.test(name)) {
          failures++;
          continue;
        }
        if (
          input.now.getTime() - info.mtimeMs < input.graceMs ||
          input.activeUploads.has(key)
        )
          continue;
        // Even temporary orphans need a healthy database before destruction.
        // The storage-key transaction lock waits out uncertain SQL allocation.
        const owner = await reconcileUpload(key, input.db);
        if (owner || input.activeUploads.has(key)) continue;
        const references = await input.db.query(
          "SELECT 1 FROM files WHERE storage_key=$1 OR thumbnail_key=$1 LIMIT 1",
          [key],
        );
        if (references.rows.length) continue;
        await verifyStorageRoot(input.root);
        if (input.activeUploads.has(key)) continue;
        await deleteStoredFile(input.root, key);
        const inode = `${info.dev}:${info.ino}`;
        if (info.nlink === 1 && !removedInodes.has(inode)) {
          removedBytes += info.size;
          removedInodes.add(inode);
        }
      } catch {
        failures++;
      }
    }
  }
  return { removedBytes, failures };
}
