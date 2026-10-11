import { createFileCode } from "./fileCodes.js";
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

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = input.code ?? createFileCode();
    try {
      const result = await client.query<FileRow>(
        `
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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

      return mapFileRow(requiredRow(result.rows[0], "File insert did not return a row"));
    } catch (error) {
      if (callerProvidedCode || !isFileCodeUniqueViolation(error) || attempt === 4) {
        throw error;
      }
    }
  }

  throw new Error("Unable to create a unique file code.");
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
    where.push(`(is_durable = true OR expires_at IS NULL OR expires_at > $${params.length})`);
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

export async function markFileDeleted(
  code: string,
  client: Queryable = db,
): Promise<FileRecord | null> {
  const result = await client.query<FileRow>(
    `
      UPDATE files SET deleted_at = now(), updated_at = now()
      WHERE code = $1 AND deleted_at IS NULL
      RETURNING ${fileColumns}
    `,
    [code],
  );

  return result.rows[0] ? mapFileRow(result.rows[0]) : null;
}

export function setFileDurable(
  code: string,
  durable: true,
  client?: Queryable,
): Promise<FileRecord>;
export function setFileDurable(
  code: string,
  durable: false,
  expiresAt: Date,
  client?: Queryable,
): Promise<FileRecord>;
export async function setFileDurable(
  code: string,
  durable: boolean,
  expiresAtOrClient?: Date | Queryable | null,
  maybeClient?: Queryable,
): Promise<FileRecord> {
  const expiresAt = expiresAtOrClient instanceof Date ? expiresAtOrClient : null;
  const client = isQueryable(expiresAtOrClient) ? expiresAtOrClient : maybeClient ?? db;

  if (!durable && expiresAt === null) {
    throw new Error("A new expiry is required when removing durable state.");
  }

  const result = await client.query<FileRow>(
    `
      UPDATE files
      SET is_durable = $2,
          expires_at = $3,
          updated_at = now()
      WHERE code = $1 AND deleted_at IS NULL
        AND (is_durable = true OR expires_at IS NULL OR expires_at > now())
      RETURNING ${fileColumns}
    `,
    [code, durable, durable ? null : expiresAt],
  );

  if (!result.rows[0]) {
    throw new Error(`File not found: ${code}`);
  }

  return mapFileRow(result.rows[0]);
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
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
    sha256: row.sha256,
    thumbnailKey: row.thumbnail_key,
    metadata: row.metadata ?? {},
  };
}

function mapDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : mapDate(value);
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
    (error.constraint === "files_code_key" || error.message.includes("files_code_key"))
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
