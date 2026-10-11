import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  principalHasPermission,
  resolvePrincipal as defaultResolvePrincipal,
  type Permission,
  type Principal,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import { unconfiguredDatabase, type Queryable } from "./db.js";
import { findFileByCode, type FileRecord, type UploadedByType } from "./filesRepo.js";
import { openDownloadStream as defaultOpenDownloadStream } from "./storage.js";

export interface ShareLinkRecord {
  id: string;
  fileId: string;
  fileCode?: string;
  tokenHash: string;
  expiresAt: Date;
  maxDownloads: number | null;
  downloadCount: number;
  createdByType: UploadedByType;
  createdByName: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  file?: FileRecord;
}

export interface CreateShareLinkInput {
  fileId: string;
  tokenHash: string;
  expiresAt: Date;
  maxDownloads: number | null;
  createdByType: UploadedByType;
  createdByName: string | null;
}

interface ShareRepo {
  findFileByCode(code: string, client?: Queryable): Promise<FileRecord | null>;
  createShareLink(input: CreateShareLinkInput, client?: Queryable): Promise<ShareLinkRecord>;
  revokeShareLink(id: string, client?: Queryable): Promise<ShareLinkRecord | null>;
  claimShareDownload(
    tokenHash: string,
    now: Date,
    client?: Queryable,
  ): Promise<ShareLinkRecord | null>;
}

interface ShareStorage {
  openDownloadStream(storageRoot: string, storageKey: string): Promise<NodeJS.ReadableStream>;
}

export interface ShareRoutesDependencies {
  config: AppConfig;
  db?: Queryable;
  repo?: Partial<ShareRepo>;
  storage?: Partial<ShareStorage>;
  now?: () => Date;
  resolvePrincipal?: (
    request: FastifyRequest,
    options: { config: AppConfig; db?: Queryable },
  ) => Promise<Principal | null>;
}

const db = unconfiguredDatabase;

const defaultRepo: ShareRepo = {
  findFileByCode,
  createShareLink,
  revokeShareLink,
  claimShareDownload,
};

const defaultStorage: ShareStorage = {
  openDownloadStream: defaultOpenDownloadStream,
};

export async function registerShareRoutes(
  server: FastifyInstance,
  dependencies: ShareRoutesDependencies,
) {
  const config = dependencies.config;
  const client = dependencies.db;
  const repo = { ...defaultRepo, ...dependencies.repo };
  const storage = { ...defaultStorage, ...dependencies.storage };
  const now = dependencies.now ?? (() => new Date());
  const resolvePrincipal = dependencies.resolvePrincipal ?? defaultResolvePrincipal;

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: Permission,
  ): Promise<Principal | null> {
    const principal = await resolvePrincipal(request, { config, db: client });
    if (!principal) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    if (!principalHasPermission(principal, permission)) {
      reply.code(403).send({ error: "Permission denied" });
      return null;
    }
    return principal;
  }

  server.post<{ Params: { code: string }; Body: Record<string, unknown> }>(
    "/api/files/:code/share",
    async (request, reply) => {
      const principal = await requirePermission(request, reply, "can_share");
      if (!principal) return reply;

      const input = parseCreateShareBody(request.body, now());
      if ("error" in input) {
        return reply.code(400).send({ error: input.error });
      }

      const file = await repo.findFileByCode(request.params.code, client);
      if (!file) {
        return reply.code(404).send({ error: "File not found" });
      }
      if (!isFileAvailable(file, now())) {
        return reply.code(410).send({ error: "File has expired" });
      }
      if (!file.isDurable && file.expiresAt !== null && input.expiresAt > file.expiresAt) {
        return reply
          .code(400)
          .send({ error: "share expiry cannot be later than the file expiry" });
      }

      const token = createShareToken();
      const share = await repo.createShareLink(
        {
          fileId: file.id,
          tokenHash: hashShareToken(token),
          expiresAt: input.expiresAt,
          maxDownloads: input.maxDownloads,
          createdByType: principal.type,
          createdByName: principal.name,
        },
        client,
      );

      return reply.code(201).send(publicShareLink(share, config, token, file.code));
    },
  );

  server.delete<{ Params: { id: string } }>("/api/share-links/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "can_share");
    if (!principal) return reply;

    const share = await repo.revokeShareLink(request.params.id, client);
    if (!share) {
      return reply.code(404).send({ error: "Share link not found" });
    }

    return { revoked: true, id: share.id };
  });

  server.get<{ Params: { token: string } }>("/s/:token", async (request, reply) => {
    const share = await repo.claimShareDownload(hashShareToken(request.params.token), now(), client);
    if (!share?.file) {
      return reply.code(410).send({ error: "Share link is no longer available" });
    }

    const stream = await storage.openDownloadStream(config.storageRoot, share.file.storageKey);

    return reply
      .type(safeMimeType(share.file.mimeType))
      .header("content-disposition", contentDispositionAttachment(share.file.originalName))
      .send(stream);
  });
}

function parseCreateShareBody(
  body: Record<string, unknown> | undefined,
  now: Date,
): { expiresAt: Date; maxDownloads: number | null } | { error: string } {
  const rawExpiresAt = body?.expires_at ?? body?.expiresAt;
  if (typeof rawExpiresAt !== "string") {
    return { error: "expires_at is required" };
  }

  const expiresAt = new Date(rawExpiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    return { error: "expires_at must be a future ISO date" };
  }

  const rawMaxDownloads = body?.max_downloads ?? body?.maxDownloads;
  if (rawMaxDownloads === undefined || rawMaxDownloads === null) {
    return { expiresAt, maxDownloads: null };
  }

  const maxDownloads = Number(rawMaxDownloads);
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1) {
    return { error: "max_downloads must be a positive integer" };
  }

  return { expiresAt, maxDownloads };
}

function createShareToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function createShareLink(
  input: CreateShareLinkInput,
  client: Queryable = db,
): Promise<ShareLinkRecord> {
  const result = await client.query<ShareLinkRow>(
    `
      INSERT INTO share_links (
        file_id,
        token_hash,
        expires_at,
        max_downloads,
        created_by_type,
        created_by_name
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING ${shareLinkColumns}
    `,
    [
      input.fileId,
      input.tokenHash,
      input.expiresAt,
      input.maxDownloads,
      input.createdByType,
      input.createdByName,
    ],
  );

  return mapShareLinkRow(requiredRow(result.rows[0], "Share link insert did not return a row"));
}

async function revokeShareLink(
  id: string,
  client: Queryable = db,
): Promise<ShareLinkRecord | null> {
  const result = await client.query<ShareLinkRow>(
    `
      UPDATE share_links
      SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING ${shareLinkColumns}
    `,
    [id],
  );

  return result.rows[0] ? mapShareLinkRow(result.rows[0]) : null;
}

async function claimShareDownload(
  tokenHash: string,
  now: Date,
  client: Queryable = db,
): Promise<ShareLinkRecord | null> {
  const result = await client.query<ShareLinkDownloadRow>(
    `
      WITH updated AS (
        UPDATE share_links sl
        SET download_count = sl.download_count + 1
        WHERE sl.token_hash = $1
          AND sl.revoked_at IS NULL
          AND sl.expires_at > $2
          AND (sl.max_downloads IS NULL OR sl.download_count < sl.max_downloads)
          AND EXISTS (
            SELECT 1
            FROM files f
            WHERE f.id = sl.file_id
              AND f.deleted_at IS NULL
              AND (f.is_durable OR f.expires_at IS NULL OR f.expires_at > $2)
          )
        RETURNING
          sl.id,
          sl.file_id,
          sl.token_hash,
          sl.expires_at,
          sl.max_downloads,
          sl.download_count,
          sl.created_by_type,
          sl.created_by_name,
          sl.created_at,
          sl.revoked_at
      )
      SELECT
        updated.id,
        updated.file_id,
        f.code AS file_code,
        updated.token_hash,
        updated.expires_at,
        updated.max_downloads,
        updated.download_count,
        updated.created_by_type,
        updated.created_by_name,
        updated.created_at,
        updated.revoked_at,
        f.id AS download_file_id,
        f.code AS download_file_code,
        f.original_name AS download_original_name,
        f.storage_key AS download_storage_key,
        f.mime_type AS download_mime_type,
        f.size_bytes AS download_size_bytes,
        f.uploaded_by_type AS download_uploaded_by_type,
        f.uploaded_by_name AS download_uploaded_by_name,
        f.created_at AS download_created_at,
        f.updated_at AS download_updated_at,
        f.expires_at AS download_expires_at,
        f.is_durable AS download_is_durable,
        f.deleted_at AS download_deleted_at,
        f.deleted_reason AS download_deleted_reason,
        f.sha256 AS download_sha256,
        f.thumbnail_key AS download_thumbnail_key,
        f.metadata AS download_metadata
      FROM updated
      JOIN files f ON f.id = updated.file_id
      WHERE f.deleted_at IS NULL
        AND (f.is_durable OR f.expires_at IS NULL OR f.expires_at > $2)
      LIMIT 1
    `,
    [tokenHash, now],
  );

  const row = result.rows[0];
  return row ? { ...mapShareLinkRow(row), file: mapDownloadFileRow(row) } : null;
}

function publicShareLink(
  share: ShareLinkRecord,
  config: AppConfig,
  token: string,
  fallbackFileCode: string,
) {
  return {
    id: share.id,
    file_code: share.fileCode ?? fallbackFileCode,
    public_url: absoluteUrl(config.publicBaseUrl, `/s/${token}`),
    expires_at: share.expiresAt.toISOString(),
    max_downloads: share.maxDownloads,
    download_count: share.downloadCount,
    revoked_at: share.revokedAt?.toISOString() ?? null,
    created_at: share.createdAt.toISOString(),
  };
}

function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

function isFileAvailable(file: FileRecord, at: Date): boolean {
  return file.isDurable || file.expiresAt === null || file.expiresAt > at;
}

interface ShareLinkRow {
  id: string;
  file_id: string;
  file_code?: string;
  token_hash: string;
  expires_at: Date | string;
  max_downloads: number | string | null;
  download_count: number | string;
  created_by_type: UploadedByType;
  created_by_name: string | null;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

interface ShareLinkDownloadRow extends ShareLinkRow {
  download_file_id: string;
  download_file_code: string;
  download_original_name: string;
  download_storage_key: string;
  download_mime_type: string;
  download_size_bytes: number | string;
  download_uploaded_by_type: UploadedByType;
  download_uploaded_by_name: string | null;
  download_created_at: Date | string;
  download_updated_at: Date | string;
  download_expires_at: Date | string | null;
  download_is_durable: boolean;
  download_deleted_at: Date | string | null;
  download_deleted_reason: string | null;
  download_sha256: string | null;
  download_thumbnail_key: string | null;
  download_metadata: Record<string, unknown> | null;
}

const shareLinkColumns = `
  id,
  file_id,
  token_hash,
  expires_at,
  max_downloads,
  download_count,
  created_by_type,
  created_by_name,
  created_at,
  revoked_at
`;

function mapShareLinkRow(row: ShareLinkRow): ShareLinkRecord {
  return {
    id: row.id,
    fileId: row.file_id,
    fileCode: row.file_code,
    tokenHash: row.token_hash,
    expiresAt: mapDate(row.expires_at),
    maxDownloads: row.max_downloads === null ? null : Number(row.max_downloads),
    downloadCount: Number(row.download_count),
    createdByType: row.created_by_type,
    createdByName: row.created_by_name,
    createdAt: mapDate(row.created_at),
    revokedAt: mapNullableDate(row.revoked_at),
  };
}

function mapDownloadFileRow(row: ShareLinkDownloadRow): FileRecord {
  return {
    id: row.download_file_id,
    code: row.download_file_code,
    originalName: row.download_original_name,
    storageKey: row.download_storage_key,
    mimeType: row.download_mime_type,
    sizeBytes: Number(row.download_size_bytes),
    uploadedByType: row.download_uploaded_by_type,
    uploadedByName: row.download_uploaded_by_name,
    createdAt: mapDate(row.download_created_at),
    updatedAt: mapDate(row.download_updated_at),
    expiresAt: mapNullableDate(row.download_expires_at),
    isDurable: row.download_is_durable,
    deletedAt: mapNullableDate(row.download_deleted_at),
    deletedReason: row.download_deleted_reason,
    sha256: row.download_sha256,
    thumbnailKey: row.download_thumbnail_key,
    metadata: row.download_metadata ?? {},
  };
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function mapDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : mapDate(value);
}

function safeMimeType(value: string | null | undefined): string {
  if (!value || /[\x00-\x1F\x7F]/.test(value)) {
    return "application/octet-stream";
  }
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
    ? value
    : "application/octet-stream";
}

function contentDispositionAttachment(filename: string): string {
  const utf8Filename = sanitizeHeaderFilename(filename) || "download";
  const asciiFilename = asciiFallbackFilename(utf8Filename) || "download";
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeRfc5987ValueChars(utf8Filename)}`;
}

function sanitizeHeaderFilename(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]+/g, "_").replace(/[\\/]+/g, "_");
}

function asciiFallbackFilename(value: string): string {
  return value
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\;:]+/g, "_")
    .replace(/[\x00-\x1F\x7F]+/g, "_");
}

function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
