import { randomUUID } from "node:crypto";
import {
  fileIsAvailable,
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
): Promise<FileRecord> {
  const callerProvidedCode = input.code !== undefined;

  for (let attempt = 0; attempt < FILE_CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
    const code = input.code ?? createFileCode();
    if (!FILE_CODE_PATTERN.test(code))
      throw new FilePolicyError(400, "Invalid file code", "INVALID_INPUT");
    try {
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
    } catch (error) {
      if (callerProvidedCode || !isFileCodeUniqueViolation(error)) {
        throw error;
      }
    }
  }

  const count = await client.query<{ count: string }>(
    "SELECT count(*) AS count FROM issued_file_codes",
  );
  if (Number(count.rows[0]?.count) >= FILE_CODE_NAMESPACE_SIZE)
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

async function transaction<T>(
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
): Promise<FileRecord | null> {
  return transaction(client, async (pinned) => {
    const file = await lockedFile(code, pinned);
    if (!file || file.lifecycleState === "deleted" || file.deletedAt)
      return null;
    if (file.lifecycleState === "deleting") return file;
    const at = now();
    if (
      reason === "expired" &&
      (file.isDurable ||
        file.expiresAt === null ||
        file.expiresAt.getTime() > at.getTime())
    )
      return null;
    const result = await pinned.query<FileRow>(
      `UPDATE files SET lifecycle_state='deleting', deletion_claim_id=$2,
      deletion_claimed_at=$3, deletion_claim_reason=$4, updated_at=$3
      WHERE code=$1 AND lifecycle_state='active' RETURNING ${fileColumns}`,
      [code, randomUUID(), at, reason],
    );
    return result.rows[0] ? mapFileRow(result.rows[0]) : null;
  });
}

// Called only after unlink confirms absence. A claim survives any unlink or DB
// failure; retries use its original identity and never restore active state.
export async function finalizeFileDeletion(
  code: string,
  claimId: string,
  client: Queryable = db,
): Promise<FileRecord | null> {
  const result = await client.query<FileRow>(
    `UPDATE files SET lifecycle_state='deleted', deleted_at=clock_timestamp(),
    deleted_reason=deletion_claim_reason, updated_at=clock_timestamp()
    WHERE code=$1 AND lifecycle_state='deleting' AND deletion_claim_id=$2 RETURNING ${fileColumns}`,
    [code, claimId],
  );
  return result.rows[0] ? mapFileRow(result.rows[0]) : null;
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
  return transaction(client, async (pinned) => {
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
      `UPDATE files SET is_durable=$2, expires_at=$3, updated_at=$4
      WHERE code=$1 AND lifecycle_state='active' RETURNING ${fileColumns}`,
      [code, durable, newExpiry, at],
    );
    if (!result.rows[0]) throw new FilePolicyError(404, "File not found");
    return mapFileRow(result.rows[0]);
  });
}

function mapFileRow(row: FileRow): FileRecord {
  return {
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

function isFileCodeUniqueViolation(error: unknown): boolean {
  return (
    isErrorWithPgCode(error) &&
    error.code === "23505" &&
    (error.constraint === "files_code_key" ||
      error.message.includes("files_code_key"))
  );
}

function isErrorWithPgCode(
  error: unknown,
): error is Error & { code?: string; constraint?: string } {
  return error instanceof Error;
}

function isQueryable(value: unknown): value is Queryable {
  return typeof value === "object" && value !== null && "query" in value;
}
