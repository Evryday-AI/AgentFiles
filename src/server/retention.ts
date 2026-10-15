import type { Queryable } from "./db.js";
import { transaction } from "./filesRepo.js";
import { storedFileBytes, verifyStorageRoot } from "./storage.js";
import { lstat } from "node:fs/promises";
import { storagePath } from "./storage.js";
import { verifyStorageAssociation } from "./storageIdentity.js";
import {
  createMaintenanceState,
  type MaintenanceState,
} from "./maintenanceState.js";

export async function purgeRetainedDetails(input: {
  root: string;
  db: Queryable;
  now: Date;
  metadataRetentionDays: number;
  eventRetentionDays: number;
  maintenanceState?: MaintenanceState;
}): Promise<{
  files: number;
  events: number;
  shares: number;
  sessions: number;
  attempted: number;
  retained: number;
  failed: number;
  complete: boolean;
}> {
  const state = input.maintenanceState ?? createMaintenanceState();
  if (state.purge.complete) {
    state.purgeCursor = undefined;
    state.purge.retained = state.purge.failures = 0;
  }
  state.purge.complete = false;
  state.purge.last_attempt_at = input.now.toISOString();
  try {
    await verifyStorageRoot(input.root);
    await verifyStorageAssociation(input.root, input.db);
    const metadataBefore = new Date(
      +input.now - input.metadataRetentionDays * 86400000,
    );
    const eventsBefore = new Date(
      +input.now - input.eventRetentionDays * 86400000,
    );
    const result = await transaction(input.db, async (pinned) => {
      const files = await pinned.query<{
        id: string;
        storage_key: string;
        thumbnail_key: string | null;
        deleted_timestamp: string;
      }>(
        `SELECT id,storage_key,thumbnail_key,deleted_at::text AS deleted_timestamp FROM files
         WHERE lifecycle_state='deleted' AND deleted_at <= $1
         AND ($2::timestamptz IS NULL OR (deleted_at,id) > ($2::timestamptz,$3::uuid))
         ORDER BY deleted_at,id LIMIT 500 FOR UPDATE`,
        [
          metadataBefore,
          state.purgeCursor?.timestamp ?? null,
          state.purgeCursor?.id ?? null,
        ],
      );
      const absent: string[] = [];
      let retained = 0;
      let failed = 0;
      for (const file of files.rows) {
        try {
          // Zero-length is not absence. Validate containment/mount before lstat.
          let missing = true;
          for (const key of [file.storage_key, file.thumbnail_key].filter(
            (key): key is string => key !== null,
          )) {
            await storedFileBytes(input.root, key);
            try {
              await lstat(storagePath(input.root, key));
              missing = false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          if (missing) absent.push(file.id);
          else retained++;
        } catch {
          // Preserve the details on path/mount uncertainty, but let later rows
          // progress. The failed sweep cannot advance the success timestamp.
          failed++;
        }
      }
      // A root failure affects the whole page, unlike an individual bad path.
      await verifyStorageRoot(input.root);
      await verifyStorageAssociation(input.root, pinned);
      const events = await pinned.query(
        "DELETE FROM events WHERE created_at < $1 OR file_id=ANY($2::uuid[])",
        [eventsBefore, absent],
      );
      const shares = await pinned.query(
        "DELETE FROM share_links WHERE (expires_at < $1 OR revoked_at < $1) OR file_id=ANY($2::uuid[])",
        [metadataBefore, absent],
      );
      const sessions = await pinned.query(
        "DELETE FROM admin_sessions WHERE expires_at <= $1",
        [input.now],
      );
      const removed = await pinned.query(
        "DELETE FROM files WHERE id=ANY($1::uuid[]) AND lifecycle_state='deleted'",
        [absent],
      );
      // issued_file_codes has no age predicate or deletion path. API key metadata
      // remains until a separate operator retention policy is introduced.
      return {
        files: removed.rowCount ?? 0,
        events: events.rowCount ?? 0,
        shares: shares.rowCount ?? 0,
        sessions: sessions.rowCount ?? 0,
        attempted: files.rows.length,
        retained,
        failed,
        complete: files.rows.length < 500,
        cursor: files.rows.length
          ? {
              timestamp: files.rows[files.rows.length - 1].deleted_timestamp,
              id: files.rows[files.rows.length - 1].id,
            }
          : state.purgeCursor,
      };
    });
    // Publish progress only after the transaction has committed. An ambiguous
    // commit retries the same page; already purged rows are harmlessly absent.
    state.purgeCursor = result.cursor;
    state.purge.retained += result.retained;
    state.purge.failures += result.failed;
    state.purge.complete = result.complete;
    if (result.complete && !state.purge.retained && !state.purge.failures)
      state.purge.last_success_at = input.now.toISOString();
    const { cursor: _cursor, ...counts } = result;
    return counts;
  } catch (error) {
    state.purge.failures++;
    throw error;
  }
}
