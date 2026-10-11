import fastifyMultipart, { type MultipartFile } from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fileIsAvailable, FilePolicyError } from "./filePolicy.js";
import {
  checkMutationPolicy,
  registerResponsePolicy,
  sendControlledError,
  strictObject,
  strictBoolean,
  formBoolean,
  boundedInteger,
  invalidInput,
  validateFilename,
} from "./requestPolicy.js";
import {
  principalHasPermission,
  resolvePrincipal as defaultResolvePrincipal,
  type Permission,
  type Principal,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import type { Queryable } from "./db.js";
import {
  createFileRecord,
  findFileByCode,
  listFiles,
  claimFileDeletion,
  finalizeFileDeletion,
  setFileDurable,
  type CreateFileInput,
  type FileFilters,
  type FileRecord,
} from "./filesRepo.js";
import {
  deleteStoredFile,
  openDownloadStream,
  saveUploadStream,
  type SavedUpload,
  type SaveUploadInput,
} from "./storage.js";

interface FilesRepo {
  createFileRecord(
    input: CreateFileInput,
    client?: Queryable,
  ): Promise<FileRecord>;
  findFileByCode(code: string, client?: Queryable): Promise<FileRecord | null>;
  listFiles(filters?: FileFilters, client?: Queryable): Promise<FileRecord[]>;
  claimFileDeletion: typeof claimFileDeletion;
  finalizeFileDeletion: typeof finalizeFileDeletion;
  setFileDurable: typeof setFileDurable;
}

interface FilesStorage {
  saveUploadStream(input: SaveUploadInput): Promise<SavedUpload>;
  openDownloadStream(
    storageRoot: string,
    storageKey: string,
  ): Promise<NodeJS.ReadableStream>;
  deleteStoredFile(storageRoot: string, storageKey: string): Promise<void>;
}

interface ParsedUpload {
  filename: string;
  mimetype: string;
  fields: Record<string, unknown>;
  saved: SavedUpload;
}

export interface FilesRoutesDependencies {
  config: AppConfig;
  db?: Queryable;
  repo?: Partial<FilesRepo>;
  storage?: Partial<FilesStorage>;
  now?: () => Date;
  resolvePrincipal?: (
    request: FastifyRequest,
    options: { config: AppConfig; db?: Queryable },
  ) => Promise<Principal | null>;
}

const defaultRepo: FilesRepo = {
  createFileRecord,
  findFileByCode,
  listFiles,
  claimFileDeletion,
  finalizeFileDeletion,
  setFileDurable,
};

const defaultStorage: FilesStorage = {
  saveUploadStream,
  openDownloadStream,
  deleteStoredFile,
};

// V1 internal defaults; promote these to AppConfig if deployment needs diverge.
const multipartLimits = {
  fields: 20,
  fieldSize: 4 * 1024,
  files: 1,
  parts: 25,
  fileSize: 1024 * 1024 * 1024,
};

const filenameMimeTypes: Record<string, string> = {
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

export async function registerFilesRoutes(
  server: FastifyInstance,
  dependencies: FilesRoutesDependencies,
) {
  registerResponsePolicy(server);
  server.setErrorHandler(sendControlledError);
  const config = dependencies.config;
  const db = dependencies.db;
  const repo = { ...defaultRepo, ...dependencies.repo };
  const storage = { ...defaultStorage, ...dependencies.storage };
  const now = dependencies.now ?? (() => new Date());
  const resolvePrincipal =
    dependencies.resolvePrincipal ?? defaultResolvePrincipal;

  await server.register(fastifyMultipart, {
    limits: { ...multipartLimits, fileSize: config.maxUploadBytes },
  });

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: Permission,
  ): Promise<Principal | null> {
    checkMutationPolicy(
      request,
      config,
      request.headers.authorization === undefined &&
        Boolean(request.cookies?.agentfiles_admin),
    );
    const principal = await resolvePrincipal(request, { config, db });
    if (!principal) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    if (!principalHasPermission(principal, permission)) {
      reply
        .code(403)
        .send({ error: "Permission denied", code: "PERMISSION_DENIED" });
      return null;
    }
    checkMutationPolicy(request, config, principal.type === "admin");
    return principal;
  }

  const uploadPrincipals = new WeakMap<FastifyRequest, Principal>();
  const uploadLimiter = server.hasDecorator("rateLimit")
    ? server.rateLimit({
        max: 30,
        timeWindow: "1 minute",
        keyGenerator: (request) => {
          const principal = uploadPrincipals.get(request);
          return principal?.type === "api_key" ? principal.id : "admin";
        },
      })
    : null;
  server.post(
    "/api/files",
    {
      onRequest: async (request, reply) => {
        const principal = await requirePermission(request, reply, "can_upload");
        if (!principal) return;
        uploadPrincipals.set(request, principal);
        if (uploadLimiter) await uploadLimiter.call(server, request, reply);
      },
    },
    async (request, reply) => {
      const principal = uploadPrincipals.get(request);
      if (!principal) return reply;

      let upload: ParsedUpload | null;
      try {
        upload = await readUploadRequest(
          request,
          config.storageRoot,
          storage,
          config.maxUploadBytes,
        );
      } catch (error) {
        if (isMultipartLimitError(error)) {
          return reply
            .code(413)
            .send({ error: "Multipart upload exceeds configured limits" });
        }
        throw error;
      }
      if (!upload) {
        return reply.code(400).send({ error: "A file upload is required" });
      }

      try {
        strictObject(upload.fields, ["durable"]);
        const durable =
          upload.fields.durable === undefined
            ? false
            : formBoolean(upload.fields.durable);
        enforcePersistence(durable, principal, config);
        const record = await repo.createFileRecord(
          {
            originalName: upload.filename,
            storageKey: upload.saved.storageKey,
            mimeType: normalizeUploadMimeType(upload.mimetype, upload.filename),
            sizeBytes: upload.saved.sizeBytes,
            uploadedByType: principal.type,
            uploadedByName: principal.name,
            expiresAt: durable ? null : retentionExpiry(config, now()),
            isDurable: durable,
            sha256: upload.saved.sha256,
            metadata: {},
          },
          db,
        );
        return reply.code(201).send(publicFile(record, config));
      } catch (error) {
        await storage.deleteStoredFile(
          config.storageRoot,
          upload.saved.storageKey,
        );
        throw error;
      }
    },
  );

  server.get("/api/files", async (request, reply) => {
    const principal = await requirePermission(request, reply, "can_list");
    if (!principal) return reply;

    const currentTime = now();
    const filters = { ...listFilters(request.query), availableAt: currentTime };
    const files = await repo.listFiles(filters, db);
    return {
      files: files
        .filter((record) => fileIsAvailable(record, currentTime))
        .map((record) => publicFile(record, config)),
    };
  });

  server.get<{ Params: { code: string } }>(
    "/api/files/:code",
    async (request, reply) => {
      const principal = await requirePermission(request, reply, "can_download");
      if (!principal) return reply;

      const record = await repo.findFileByCode(request.params.code, db);
      if (
        !record ||
        record.deletedAt !== null ||
        record.lifecycleState === "deleted"
      ) {
        return reply.code(404).send({ error: "File not found" });
      }
      if (!fileIsAvailable(record, now())) {
        return reply.code(410).send({ error: "File has expired" });
      }
      return publicFile(record, config);
    },
  );

  server.get<{ Params: { code: string } }>(
    "/api/files/:code/download",
    async (request, reply) => {
      const principal = await requirePermission(request, reply, "can_download");
      if (!principal) return reply;

      const record = await repo.findFileByCode(request.params.code, db);
      if (
        !record ||
        record.deletedAt !== null ||
        record.lifecycleState === "deleted"
      ) {
        return reply.code(404).send({ error: "File not found" });
      }
      if (!fileIsAvailable(record, now())) {
        return reply.code(410).send({ error: "File has expired" });
      }

      const stream = await storage.openDownloadStream(
        config.storageRoot,
        record.storageKey,
      );
      return reply
        .type(safeMimeType(record.mimeType))
        .header(
          "content-disposition",
          contentDispositionAttachment(record.originalName),
        )
        .send(stream);
    },
  );

  server.patch<{ Params: { code: string }; Body: { durable?: unknown } }>(
    "/api/files/:code",
    async (request, reply) => {
      const principal = await requirePermission(
        request,
        reply,
        "can_mark_durable",
      );
      if (!principal) return reply;

      const input = strictObject(request.body, ["durable"]);
      const durable = strictBoolean(input.durable);
      enforcePersistence(durable, principal, config);
      const record = await repo.setFileDurable(
        request.params.code,
        durable,
        undefined,
        db,
        {
          now,
          retentionDays: config.retentionDays,
          authorize: async (pinned) => {
            // Recheck principal permissions and operator policy under the file lock.
            const lockedPrincipal = await resolvePrincipal(request, {
              config,
              db: pinned,
            });
            if (!lockedPrincipal)
              throw new FilePolicyError(401, "Authentication required");
            if (!principalHasPermission(lockedPrincipal, "can_mark_durable"))
              throw new FilePolicyError(
                403,
                "Permission denied",
                "PERMISSION_DENIED",
              );
            enforcePersistence(durable, lockedPrincipal, config);
          },
        },
      );
      return publicFile(record, config);
    },
  );

  server.delete<{ Params: { code: string } }>(
    "/api/files/:code",
    async (request, reply) => {
      const principal = await requirePermission(request, reply, "can_delete");
      if (!principal) return reply;

      if (request.body !== undefined) strictObject(request.body, []);
      const record = await repo.claimFileDeletion(
        request.params.code,
        "manual",
        db,
        now,
      );
      if (!record) return reply.code(404).send({ error: "File not found" });
      if (!record.deletionClaimId) throw new Error("Deletion claim missing");
      try {
        await storage.deleteStoredFile(config.storageRoot, record.storageKey);
        if (record.thumbnailKey)
          await storage.deleteStoredFile(
            config.storageRoot,
            record.thumbnailKey,
          );
        const deleted = await repo.finalizeFileDeletion(
          record.code,
          record.deletionClaimId,
          db,
        );
        if (!deleted) throw new Error("Deletion finalization failed");
      } catch {
        request.log.error("File deletion failed; claim retained for recovery");
        return reply
          .code(500)
          .send({ error: "File deletion could not be completed" });
      }
      return { deleted: true, code: record.code };
    },
  );
}

async function readUploadRequest(
  request: FastifyRequest,
  storageRoot: string,
  storage: FilesStorage,
  maxUploadBytes: number,
): Promise<ParsedUpload | null> {
  const fields: Record<string, unknown> = {};
  let upload: ParsedUpload | null = null;
  let fieldCount = 0;
  let fileCount = 0;
  let partCount = 0;

  try {
    for await (const part of request.parts({
      limits: { ...multipartLimits, fileSize: maxUploadBytes },
    })) {
      partCount += 1;
      if (partCount > multipartLimits.parts) {
        throw multipartLimitError();
      }

      if (part.type === "file") {
        fileCount += 1;
        if (fileCount > multipartLimits.files || upload) {
          await drainFilePart(part);
          throw multipartLimitError();
        }

        if (part.fieldname !== "file") invalidInput("Expected file part");
        validateFilename(part.filename);
        const saved = await storage.saveUploadStream({
          storageRoot,
          originalName: part.filename,
          stream: part.file,
        });
        await drainFilePart(part);
        if (part.file.truncated) {
          await storage.deleteStoredFile(storageRoot, saved.storageKey);
          throw multipartLimitError();
        }
        upload = {
          filename: part.filename,
          mimetype: part.mimetype,
          fields,
          saved,
        };
      } else {
        fieldCount += 1;
        if (
          fieldCount > multipartLimits.fields ||
          fieldValueSize(part.value) > multipartLimits.fieldSize ||
          part.valueTruncated
        ) {
          throw multipartLimitError();
        }
        if (Object.hasOwn(fields, part.fieldname))
          invalidInput("Duplicate multipart field");
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    if (upload) {
      await storage
        .deleteStoredFile(storageRoot, upload.saved.storageKey)
        .catch(() => {});
    }
    if (
      isErrorWithCode(error) &&
      error.code === "ERR_STREAM_PREMATURE_CLOSE" &&
      (fieldCount >= multipartLimits.fields ||
        fileCount > multipartLimits.files ||
        partCount >= multipartLimits.parts)
    ) {
      throw multipartLimitError();
    }
    throw error;
  }

  return upload;
}

function multipartLimitError(): Error & { statusCode: number } {
  const error = new Error(
    "Multipart upload exceeds configured limits",
  ) as Error & {
    statusCode: number;
  };
  error.statusCode = 413;
  return error;
}

function fieldValueSize(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(value);
  }
  if (Buffer.isBuffer(value)) {
    return value.byteLength;
  }
  return Buffer.byteLength(String(value));
}

async function drainFilePart(part: MultipartFile): Promise<void> {
  try {
    for await (const _chunk of part.file) {
      // Drain rejected extra files so the multipart parser can finish cleanly.
    }
  } catch (error) {
    if (
      !isErrorWithCode(error) ||
      error.code !== "ERR_STREAM_PREMATURE_CLOSE"
    ) {
      throw error;
    }
  }
}

function retentionExpiry(config: AppConfig, from: Date): Date {
  return new Date(from.getTime() + config.retentionDays * 86400000);
}

function enforcePersistence(
  durable: boolean,
  principal: Principal,
  config: AppConfig,
): void {
  if (!durable) return;
  if (!config.allowPersistentFiles)
    throw new FilePolicyError(
      403,
      "Persistence disabled by installation policy",
      "PERSISTENCE_DISABLED",
    );
  if (!principalHasPermission(principal, "can_mark_durable"))
    throw new FilePolicyError(403, "Permission denied", "PERMISSION_DENIED");
}

function listFilters(query: unknown): FileFilters {
  const raw = strictObject(query, ["limit", "offset", "durable"]);
  return {
    ...(raw.limit === undefined
      ? {}
      : { limit: boundedInteger(raw.limit, 1, 500) }),
    ...(raw.offset === undefined
      ? {}
      : { offset: boundedInteger(raw.offset, 0, 2147483647) }),
    ...(raw.durable === undefined
      ? {}
      : { isDurable: formBoolean(raw.durable) }),
  };
}

function publicFile(record: FileRecord, config: AppConfig) {
  return {
    code: record.code,
    name: record.originalName,
    mime_type: record.mimeType,
    size: record.sizeBytes,
    size_bytes: record.sizeBytes,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    expiry: record.expiresAt?.toISOString() ?? null,
    expires_at: record.expiresAt?.toISOString() ?? null,
    durable: record.isDurable,
    is_durable: record.isDurable,
    sha256: record.sha256,
    private_url: absoluteUrl(config.publicBaseUrl, `/files/${record.code}`),
    api_download_url: absoluteUrl(
      config.publicBaseUrl,
      `/api/files/${record.code}/download`,
    ),
    uploaded_by: {
      type: record.uploadedByType,
      name: record.uploadedByName,
    },
    metadata: record.metadata,
  };
}

function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

function isMultipartLimitError(error: unknown): boolean {
  return (
    (isErrorWithCode(error) &&
      [
        "FST_PARTS_LIMIT",
        "FST_FILES_LIMIT",
        "FST_FIELDS_LIMIT",
        "FST_REQ_FILE_TOO_LARGE",
      ].includes(error.code)) ||
    (isErrorWithStatusCode(error) && error.statusCode === 413)
  );
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function isErrorWithStatusCode(
  error: unknown,
): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function safeMimeType(value: string | null | undefined): string {
  if (!value || /[\x00-\x1F\x7F]/.test(value)) {
    return "application/octet-stream";
  }
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(
    value,
  )
    ? value
    : "application/octet-stream";
}

function normalizeUploadMimeType(
  value: string | null | undefined,
  filename: string,
): string {
  const safeType = safeMimeType(value);
  if (safeType !== "application/octet-stream") {
    return safeType;
  }

  const extension = filename.match(/\.[^./\\]+$/)?.[0]?.toLowerCase();
  return (extension && filenameMimeTypes[extension]) || safeType;
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
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
