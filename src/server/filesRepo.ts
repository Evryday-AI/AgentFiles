import { randomUUID } from "node:crypto";
import {
  fileIsAvailable,
  expiryIsAfter,
  FilePolicyError,
  type FileLifecycleState,
} from "./filePolicy.js";
import { FILE_CODE_PATTERN } from "./requestPolicy.js";
import {
  createFileCode,
  FILE_CODE_NAMESPACE_SIZE,
  FILE_CODE_ALLOCATION_ATTEMPTS,
} from "./fileCodes.js";
import { unconfiguredDatabase, type Queryable } from "./db.js";

export type { Queryable };

export type UploadedByType = "admin" | "api_key";

export interface FileRecord {
  id: string;
  code: string;
  originalName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByType: UploadedByType;
  uploadedByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  expiresAtExact?: string | null;
  isDurable: boolean;
  deletedAt: Date | null;
  deletedReason: string | null;
  lifecycleState: FileLifecycleState;
  deletionClaimId: string | null;
  deletionClaimedAt: Date | null;
  deletionClaimReason: "manual" | "expired" | null;
  sha256: string | null;
  thumbnailKey: string | null;
  metadata: Record<string, unknown>;
  sweepTimestamp?: string;
  claimCreated?: boolean;
}

export interface CreateFileInput {
  code?: string;
  originalName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByType: UploadedByType;
  uploadedByName?: string | null;
  expiresAt?: Date | null;
  isDurable?: boolean;
  sha256?: string | null;
  thumbnailKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FileFilters {
  includeDeleted?: boolean;
  isDurable?: boolean;
  uploadedByType?: UploadedByType;
  expiresBefore?: Date;
  availableAt?: Date;
  limit?: number;
  offset?: number;
}

interface FileRow {
  sweep_timestamp?: string;
  id: string;
  code: string;
  original_name: string;
  storage_key: string;
  mime_type: string;
  size_bytes: string | number;
  uploaded_by_type: UploadedByType;
  uploaded_by_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
  expires_at_exact?: string | null;
  is_durable: boolean;
  deleted_at: Date | string | null;
  deleted_reason: string | null;
  lifecycle_state: FileLifecycleState;
  deletion_claim_id: string | null;
  deletion_claimed_at: Date | string | null;
  deletion_claim_reason: "manual" | "expired" | null;
  sha256: string | null;
  thumbnail_key: string | null;
  metadata: Record<string, unknown> | null;
}

const fileColumns = `
  id,
  code,
  original_name,
  storage_key,
  mime_type,
  size_bytes,
  uploaded_by_type,
  uploaded_by_name,
  created_at,
  updated_at,
  expires_at,
  expires_at::text AS expires_at_exact,
  is_durable,
  deleted_at,
  deleted_reason,
  lifecycle_state,
  deletion_claim_id,
  deletion_claimed_at,
  deletion_claim_reason,
  sha256,
  thumbnail_key,
  metadata
`;

const db = unconfiguredDatabase;

export async function createFileRecord(
  input: CreateFileInput,
  client: Queryable = db,
  allocation: {
    generateCode?: () => string;
    namespace?: readonly string[];
  } = {},
): Promise<FileRecord> {
  const database = client as Queryable & {
    withClient?: <T>(work: (pinned: Queryable) => Promise<T>) => Promise<T>;
  };
  if (!database.withClient)
    throw new Error("Pinned database transaction required");
  return database.withClient(async (pinned) => {
    let commitAttempted = false;
    await pinned.query("BEGIN");
    try {
      await uploadOwnershipLock(pinned, input.storageKey);
      const record = await allocateFileRecord(input, pinned, allocation);
      commitAttempted = true;
      await pinned.query("COMMIT");
      return record;
    } catch (error) {
      if (!commitAttempted) {
        let rolledBack = false;
        try {
          await pinned.query("ROLLBACK");
          rolledBack = true;
        } catch {
          /* Outcome remains unknown. */
        }
        if (rolledBack) throw error;
      }
      throw new UploadAllocationUncertainError(error);
    }
  });
}

export class UploadAllocationUncertainError extends Error {
  constructor(readonly originalError: unknown) {
    super("Upload allocation outcome requires reconciliation");
  }
}
async function uploadOwnershipLock(pinned: Queryable, key: string) {
  await pinned.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}
// Waiting for this transaction lock proves the original allocator has ended.
// A lock/query timeout throws: it never converts uncertainty to absence.
export async function reconcileUpload(
  storageKey: string,
  client: Queryable = db,
): Promise<FileRecord | null> {
  return transaction(client, async (pinned) => {
    await pinned.query("SET LOCAL lock_timeout='2000ms'");
    await uploadOwnershipLock(pinned, storageKey);
    const result = await pinned.query<FileRow & { code_issued: boolean }>(
      `SELECT ${fileColumns}, EXISTS(SELECT 1 FROM issued_file_codes WHERE issued_file_codes.code=files.code) AS code_issued FROM files WHERE storage_key=$1`,
      [storageKey],
    );
    if (result.rows[0] && !result.rows[0].code_issued)
      throw new Error("Upload registry ownership is inconsistent");
    return result.rows[0] ? mapFileRow(result.rows[0]) : null;
  });
}

async function allocateFileRecord(
  input: CreateFileInput,
  client: Queryable,
  allocation: { generateCode?: () => string; namespace?: readonly string[] },
): Promise<FileRecord> {
  const callerProvidedCode = input.code !== undefined;

  for (let attempt = 0; attempt < FILE_CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
    const code = input.code ?? (allocation.generateCode ?? createFileCode)();
    if (!FILE_CODE_PATTERN.test(code))
      throw new FilePolicyError(400, "Invalid file code", "INVALID_INPUT");
    const result = await client.query<FileRow>(
      `
          WITH reserved AS (
            INSERT INTO issued_file_codes(code) VALUES($1) ON CONFLICT DO NOTHING RETURNING code
          )
          INSERT INTO files (
            code,
            original_name,
            storage_key,
            mime_type,
            size_bytes,
            uploaded_by_type,
            uploaded_by_name,
            expires_at,
            is_durable,
            sha256,
            thumbnail_key,
            metadata
          )
          SELECT code, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 FROM reserved
          RETURNING ${fileColumns}
        `,
      [
        code,
        input.originalName,
        input.storageKey,
        input.mimeType,
        input.sizeBytes,
        input.uploadedByType,
        input.uploadedByName ?? null,
        input.expiresAt ?? null,
        input.isDurable ?? false,
        input.sha256 ?? null,
        input.thumbnailKey ?? null,
        input.metadata ?? {},
      ],
    );

    if (result.rows[0]) return mapFileRow(result.rows[0]);
    if (callerProvidedCode)
      throw new FilePolicyError(
        503,
        "Code reservation already exists",
        "CODE_ALLOCATION_RETRY_EXHAUSTED",
      );
  }

  const namespace = allocation.namespace;
  if (
    namespace &&
    (!namespace.length ||
      new Set(namespace).size !== namespace.length ||
      namespace.some((code) => !FILE_CODE_PATTERN.test(code)))
  )
    throw new Error("Invalid code namespace");
  const count = await client.query<{ count: string }>(
    namespace
      ? "SELECT count(*) AS count FROM issued_file_codes WHERE code = ANY($1::text[])"
      : "SELECT count(*) AS count FROM issued_file_codes WHERE code ~ '^F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$'",
    namespace ? [namespace] : [],
  );
  const value = count.rows[0]?.count;
  if (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) === BigInt(namespace?.length ?? FILE_CODE_NAMESPACE_SIZE)
  )
    throw new FilePolicyError(
      507,
      "Code namespace exhausted",
      "CODE_SPACE_EXHAUSTED",
    );
  throw new FilePolicyError(
    503,
    "Code allocation retries exhausted",
    "CODE_ALLOCATION_RETRY_EXHAUSTED",
  );
}

export async function findFileByCode(
  code: string,
  client: Queryable = db,
): Promise<FileRecord | null> {
  const result = await client.query<FileRow>(
    `
      SELECT ${fileColumns}
      FROM files
      WHERE code = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [code],
  );

  return result.rows[0] ? mapFileRow(result.rows[0]) : null;
}

export async function listFiles(
  filters: FileFilters = {},
  client: Queryable = db,
): Promise<FileRecord[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  if (!filters.includeDeleted) {
    where.push("deleted_at IS NULL");
    where.push("lifecycle_state = 'active'");
  }

  if (filters.isDurable !== undefined) {
    params.push(filters.isDurable);
    where.push(`is_durable = $${params.length}`);
  }

  if (filters.uploadedByType) {
    params.push(filters.uploadedByType);
    where.push(`uploaded_by_type = $${params.length}`);
  }

  if (filters.expiresBefore) {
    params.push(filters.expiresBefore);
    where.push(`expires_at IS NOT NULL AND expires_at <= $${params.length}`);
  }

  if (filters.availableAt) {
    params.push(filters.availableAt);
    where.push(
      `(lifecycle_state = 'active' AND deleted_at IS NULL AND (is_durable OR expires_at > $${params.length}))`,
    );
  }

  const limit = clampInteger(filters.limit ?? 100, 1, 500);
  const offset = clampInteger(filters.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const result = await client.query<FileRow>(
    `
      SELECT ${fileColumns}
      FROM files
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `,
    params,
  );

  return result.rows.map(mapFileRow);
}

export interface RetentionPolicy {
  now?: () => Date;
  authorize?: (pinned: Queryable) => void | Promise<void>;
  retentionDays?: number;
}

export async function transaction<T>(
  client: Queryable,
  work: (pinned: Queryable) => Promise<T>,
): Promise<T> {
  const database = client as Queryable & {
    withClient?: (work: (pinned: Queryable) => Promise<T>) => Promise<T>;
  };
  if (!database.withClient)
    throw new Error("Pinned database transaction required");
  return database.withClient(async (pinned) => {
    await pinned.query("BEGIN");
    try {
      const result = await work(pinned);
      await pinned.query("COMMIT");
      return result;
    } catch (error) {
      await pinned.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

async function lockedFile(
  code: string,
  pinned: Queryable,
): Promise<FileRecord | null> {
  const result = await pinned.query<FileRow>(
    `SELECT ${fileColumns} FROM files WHERE code=$1 FOR UPDATE`,
    [code],
  );
  return result.rows[0] ? mapFileRow(result.rows[0]) : null;
}

export async function claimFileDeletion(
  code: string,
  reason: "manual" | "expired",
  client: Queryable = db,
  now: () => Date = () => new Date(),
  authorize?: (pinned: Queryable) => Promise<void>,
): Promise<FileRecord | null> {
  let intended: FileRecord | null = null;
  try {
    return await transaction(client, async (pinned) => {
      const file = await lockedFile(code, pinned);
      await authorize?.(pinned);
      if (!file) return null;
      if (file.lifecycleState === "deleted" || file.deletedAt)
        return reason === "manual" ? file : null;
      if (file.lifecycleState === "deleting") return file;
      const at = now();
      if (
        reason === "expired" &&
        (file.isDurable || file.expiresAt === null || expiryIsAfter(file, at))
      )
        return null;
      const result = await pinned.query<FileRow>(
        `UPDATE files SET lifecycle_state='deleting', deletion_claim_id=$2,
      deletion_claimed_at=$3, deletion_claim_reason=$4, updated_at=$3
      WHERE code=$1 AND lifecycle_state='active' RETURNING ${fileColumns}`,
        [code, randomUUID(), at, reason],
      );
      intended = result.rows[0] ? mapFileRow(result.rows[0]) : null;
      if (intended) intended.claimCreated = true;
      return intended;
    });
  } catch (error) {
    // A fresh row lock waits for the original transaction to settle. A timeout
    // never grants deletion authority; the durable claim is retried later.
    if (!intended) throw error;
    const verified = await readDeletionOwnership(code, client);
    if (verified?.deletionClaimId !== (intended as FileRecord).deletionClaimId)
      throw error;
    return verified;
  }
}

export async function readDeletionOwnership(
  code: string,
  client: Queryable = db,
) {
  return transaction(client, async (pinned) => {
    await pinned.query("SET LOCAL lock_timeout='2000ms'");
    return lockedFile(code, pinned);
  });
}

// Called only after unlink confirms absence. A claim survives any unlink or DB
// failure; retries use its original identity and never restore active state.
export async function finalizeFileDeletion(
  code: string,
  claimId: string,
  client: Queryable = db,
): Promise<FileRecord | null> {
  try {
    const result = await client.query<FileRow>(
      `UPDATE files SET lifecycle_state='deleted', deleted_at=clock_timestamp(),
    deleted_reason=deletion_claim_reason, updated_at=clock_timestamp()
    WHERE code=$1 AND lifecycle_state='deleting' AND deletion_claim_id=$2 RETURNING ${fileColumns}`,
      [code, claimId],
    );
    if (result.rows[0]) return mapFileRow(result.rows[0]);
  } catch {
    /* Fresh ownership verification resolves a lost commit reply. */
  }
  const verified = await readDeletionOwnership(code, client);
  return verified?.deletionClaimId === claimId &&
    verified.lifecycleState === "deleted"
    ? verified
    : null;
}

export interface SweepCursor {
  timestamp: string;
  id: string;
}
export async function findExpiredBatch(
  input: { now: Date; after?: SweepCursor; limit: number },
  client: Queryable = db,
): Promise<FileRecord[]> {
  const result = await client.query<FileRow>(
    `SELECT ${fileColumns}, expires_at::text AS sweep_timestamp FROM files
    WHERE lifecycle_state='active' AND deleted_at IS NULL AND NOT is_durable AND expires_at <= $1
    AND ($2::timestamptz IS NULL OR (expires_at,id) > ($2::timestamptz,$3::uuid))
    ORDER BY expires_at,id LIMIT $4`,
    [
      input.now,
      input.after?.timestamp ?? null,
      input.after?.id ?? null,
      input.limit,
    ],
  );
  return result.rows.map(mapFileRow);
}

export async function findPendingBatch(
  input: { after?: SweepCursor; limit: number },
  client: Queryable = db,
): Promise<FileRecord[]> {
  const result = await client.query<FileRow>(
    `SELECT ${fileColumns}, deletion_claimed_at::text AS sweep_timestamp FROM files
    WHERE lifecycle_state='deleting'
    AND ($1::timestamptz IS NULL OR (deletion_claimed_at,id) > ($1::timestamptz,$2::uuid))
    ORDER BY deletion_claimed_at,id LIMIT $3`,
    [input.after?.timestamp ?? null, input.after?.id ?? null, input.limit],
  );
  return result.rows.map(mapFileRow);
}

export async function claimDeletion(
  input: { id: string; reason: "expired" | "manual"; now: () => Date },
  client: Queryable,
) {
  const row = await client.query<{ code: string }>(
    "SELECT code FROM files WHERE id=$1",
    [input.id],
  );
  if (!row.rows[0]) return { status: "ineligible" as const };
  const file = await claimFileDeletion(
    row.rows[0].code,
    input.reason,
    client,
    input.now,
  );
  return file
    ? {
        status:
          file.lifecycleState === "deleted"
            ? ("deleted" as const)
            : file.claimCreated
              ? ("claimed" as const)
              : ("already-claimed" as const),
        file,
      }
    : { status: "ineligible" as const };
}

export async function finishDeletion(
  input: { id: string; claimId: string },
  client: Queryable,
) {
  const row = await client.query<{ code: string }>(
    "SELECT code FROM files WHERE id=$1",
    [input.id],
  );
  return row.rows[0]
    ? finalizeFileDeletion(row.rows[0].code, input.claimId, client)
    : null;
}

export async function listDeletionCandidates(
  at: Date,
  limit = 100,
  client: Queryable = db,
): Promise<FileRecord[]> {
  const result = await client.query<FileRow>(
    `SELECT ${fileColumns} FROM files
    WHERE lifecycle_state='deleting' OR (lifecycle_state='active' AND deleted_at IS NULL AND NOT is_durable AND expires_at <= $1)
    ORDER BY COALESCE(deletion_claimed_at, expires_at), id LIMIT $2`,
    [at, limit],
  );
  return result.rows.map(mapFileRow);
}

export async function setFileDurable(
  code: string,
  durable: boolean,
  expiresAtOrClient?: Date | Queryable | null,
  maybeClient?: Queryable,
  policy: RetentionPolicy = {},
): Promise<FileRecord> {
  const expiry = expiresAtOrClient instanceof Date ? expiresAtOrClient : null;
  const client = isQueryable(expiresAtOrClient)
    ? expiresAtOrClient
    : (maybeClient ?? db);
  if (!durable && !expiry && !policy.retentionDays)
    throw new Error("A new expiry is required when removing durable state.");
  const mutationId = randomUUID();
  let attempted = false;
  try {
    return await transaction(client, async (pinned) => {
      const file = await lockedFile(code, pinned);
      const at = (policy.now ?? (() => new Date()))();
      await policy.authorize?.(pinned);
      if (!file || file.lifecycleState === "deleted" || file.deletedAt)
        throw new FilePolicyError(404, "File not found");
      if (file.lifecycleState === "deleting")
        throw new FilePolicyError(
          409,
          "File deletion in progress",
          "FILE_DELETION_IN_PROGRESS",
        );
      if (!fileIsAvailable(file, at))
        throw new FilePolicyError(410, "File has expired");
      const newExpiry = durable
        ? null
        : policy.retentionDays
          ? new Date(at.getTime() + policy.retentionDays * 86400000)
          : expiry;
      const result = await pinned.query<FileRow>(
        `UPDATE files SET is_durable=$2, expires_at=$3, updated_at=$4, retention_mutation_id=$5
      WHERE code=$1 AND lifecycle_state='active' RETURNING ${fileColumns}`,
        [code, durable, newExpiry, at, mutationId],
      );
      if (!result.rows[0]) throw new FilePolicyError(404, "File not found");
      attempted = true;
      return mapFileRow(result.rows[0]);
    });
  } catch (error) {
    if (!attempted) throw error;
    try {
      return await transaction(client, async (pinned) => {
        const file = await lockedFile(code, pinned);
        const result = await pinned.query<{ retention_mutation_id: string }>(
          "SELECT retention_mutation_id FROM files WHERE code=$1",
          [code],
        );
        if (
          !file ||
          file.lifecycleState !== "active" ||
          result.rows[0]?.retention_mutation_id !== mutationId
        )
          throw error;
        return file;
      });
    } catch {
      throw new FilePolicyError(
        503,
        "Retention outcome requires verification",
        "FILE_RETENTION_PENDING",
      );
    }
  }
}

function mapFileRow(row: FileRow): FileRecord {
  return {
    sweepTimestamp: row.sweep_timestamp,
    id: row.id,
    code: row.code,
    originalName: row.original_name,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    uploadedByType: row.uploaded_by_type,
    uploadedByName: row.uploaded_by_name,
    createdAt: mapDate(row.created_at),
    updatedAt: mapDate(row.updated_at),
    expiresAt: mapNullableDate(row.expires_at),
    expiresAtExact: row.expires_at_exact,
    isDurable: row.is_durable,
    deletedAt: mapNullableDate(row.deleted_at),
    deletedReason: row.deleted_reason,
    lifecycleState: row.lifecycle_state,
    deletionClaimId: row.deletion_claim_id,
    deletionClaimedAt: mapNullableDate(row.deletion_claimed_at),
    deletionClaimReason: row.deletion_claim_reason,
    sha256: row.sha256,
    thumbnailKey: row.thumbnail_key,
    metadata: row.metadata ?? {},
  };
}

function mapDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapNullableDate(value: Date | string | null): Date | null {
  return value == null ? null : mapDate(value);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isQueryable(value: unknown): value is Queryable {
  return typeof value === "object" && value !== null && "query" in value;
}
