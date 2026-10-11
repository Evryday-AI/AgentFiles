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
  reconcileUpload,
  UploadAllocationUncertainError,
  type CreateFileInput,
  type FileFilters,
  type FileRecord,
} from "./filesRepo.js";
import {
  deleteStoredFile,
  openDownloadStream,
  stageUpload,
  finalizeUpload,
  discardUpload,
  storedFileBytes,
  getStorageUsage,
  getFreeDiskBytes,
  type StagedUpload,
  type SavedUpload,
  type SaveUploadInput,
  MULTIPART_IDLE_TIMEOUT_MS,
} from "./storage.js";
import type { Readable } from "node:stream";
import {
  createUploadAdmission,
  type UploadAdmission,
} from "./uploadAdmission.js";
import { createActiveUploads, type ActiveUploads } from "./activeUploads.js";
import { completeDeletion } from "./deletion.js";
import { recordSafeEvent } from "./events.js";
import type { MaintenanceState } from "./maintenanceState.js";

interface FilesRepo {
  reconcileUpload: typeof reconcileUpload;
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
  stageUpload(
    input: SaveUploadInput & { maxBytes: number },
  ): Promise<StagedUpload>;
  finalizeUpload: typeof finalizeUpload;
  discardUpload: typeof discardUpload;
  storedFileBytes: typeof storedFileBytes;
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
  staged: StagedUpload;
}

export interface FilesRoutesDependencies {
  maintenanceState?: MaintenanceState;
  config: AppConfig;
  db?: Queryable;
  repo?: Partial<FilesRepo>;
  storage?: Partial<FilesStorage>;
  now?: () => Date;
  admission?: UploadAdmission;
  activeUploads?: ActiveUploads;
  uploadIdleTimeoutMs?: number;
  retainUnknown?: (work: () => Promise<boolean>) => void;
  resolvePrincipal?: (
    request: FastifyRequest,
    options: { config: AppConfig; db?: Queryable },
  ) => Promise<Principal | null>;
}

const defaultRepo: FilesRepo = {
  reconcileUpload,
  createFileRecord,
  findFileByCode,
  listFiles,
  claimFileDeletion,
  finalizeFileDeletion,
  setFileDurable,
};

const defaultStorage: FilesStorage = {
  stageUpload,
  finalizeUpload,
  discardUpload,
  storedFileBytes,
  openDownloadStream,
  deleteStoredFile,
};

// V1 internal defaults; promote these to AppConfig if deployment needs diverge.
const multipartLimits = {
  fields: 20,
  fieldSize: 4 * 1024,
  files: 1,
  parts: 25,
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
  const admission =
    dependencies.admission ??
    createUploadAdmission(config, 0, () =>
      getFreeDiskBytes(config.storageRoot),
    );
  const activeUploads = dependencies.activeUploads ?? createActiveUploads();
  if (!dependencies.admission)
    server.addHook("onReady", async () => {
      await admission.rescan(
        async () => (await getStorageUsage(config.storageRoot)).bytes,
      );
    });
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

      if (!config.issuanceEnabled)
        throw new FilePolicyError(
          503,
          "New file issuance is disabled pending complete registry recovery",
          "FILE_ISSUANCE_DISABLED",
        );
      const lease = await admission.acquire();
      const releases = new Map<string, () => void>();
      const hold = (key: string) => {
        if (!releases.has(key)) releases.set(key, activeUploads.hold(key));
      };
      let saved: SavedUpload | undefined;
      let uncertain = false;
      const confirmUpload = async (record: FileRecord) => {
        await lease.commit(saved!.sizeBytes);
        await recordSafeEvent(
          {
            fileId: record.id,
            eventType: "file.created",
            actorType: principal.type,
            actorId: principal.type === "api_key" ? principal.id : undefined,
          },
          db,
          dependencies.maintenanceState,
        );
      };
      const compensate = async () => {
        let retained = 0;
        for (const key of releases.keys()) {
          try {
            await storage.discardUpload(config.storageRoot, key);
          } catch {
            request.log.error(
              "Upload compensation failed; retained bytes remain charged",
            );
            try {
              retained += await storage.storedFileBytes(
                config.storageRoot,
                key,
              );
            } catch {
              retained += config.maxUploadBytes;
            }
          }
        }
        await lease.abort(retained);
      };
      try {
        const upload = await readUploadRequest(
          request,
          config.storageRoot,
          storage,
          config.maxUploadBytes,
          hold,
          (key) => activeUploads.hold(key),
          () => admission.checkpoint(),
          dependencies.uploadIdleTimeoutMs,
        );
        if (!upload)
          throw new FilePolicyError(
            400,
            "A file upload is required",
            "INVALID_INPUT",
          );
        strictObject(upload.fields, ["durable"]);
        const durable =
          upload.fields.durable === undefined
            ? false
            : formBoolean(upload.fields.durable);
        enforcePersistence(durable, principal, config);
        saved = await storage.finalizeUpload(
          config.storageRoot,
          upload.staged,
          hold,
          (key) => activeUploads.hold(key),
        );
        const record = await repo.createFileRecord(
          {
            originalName: upload.filename,
            storageKey: saved.storageKey,
            mimeType: normalizeUploadMimeType(upload.mimetype, upload.filename),
            sizeBytes: saved.sizeBytes,
            uploadedByType: principal.type,
            uploadedByName: principal.name,
            expiresAt: durable ? null : retentionExpiry(config, now()),
            isDurable: durable,
            sha256: saved.sha256,
            metadata: {},
          },
          db,
        );
        await confirmUpload(record);
        return reply.code(201).send(publicFile(record, config));
      } catch (error) {
        if (error instanceof UploadAllocationUncertainError && saved) {
          try {
            const record = await repo.reconcileUpload(saved.storageKey, db);
            if (record) {
              await confirmUpload(record);
              return reply.code(201).send(publicFile(record, config));
            }
          } catch {
            // Keep the reservation AND both path references. A missing row from
            // an unlocked query cannot prove a pending transaction rolled back.
            uncertain = true;
            dependencies.retainUnknown?.(async () => {
              const record = await repo.reconcileUpload(saved!.storageKey, db);
              if (record) await confirmUpload(record);
              else await compensate();
              for (const release of releases.values()) release();
              return true;
            });
            request.log.error(
              "Upload ownership unresolved; bytes protected and reservation retained",
            );
            throw new FilePolicyError(
              503,
              "Upload outcome unknown; do not automatically retry",
              "UPLOAD_OUTCOME_UNKNOWN",
            );
          }
          error = error.originalError;
        }
        await compensate();
        if (isErrorWithCode(error) && error.code === "ENOSPC")
          throw new FilePolicyError(
            507,
            "Storage capacity unavailable",
            "STORAGE_CAPACITY_EXCEEDED",
          );
        if (isMultipartLimitError(error))
          throw new FilePolicyError(
            413,
            "Multipart upload exceeds configured limits",
            "UPLOAD_TOO_LARGE",
          );
        if (
          error instanceof FilePolicyError &&
          error.code === "UPLOAD_IDLE_TIMEOUT" &&
          request.raw.readableEnded
        )
          throw new FilePolicyError(
            400,
            "Incomplete multipart upload",
            "INVALID_INPUT",
          );
        throw error;
      } finally {
        if (!uncertain) for (const release of releases.values()) release();
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
      await recordSafeEvent(
        {
          fileId: record.id,
          eventType: "file.durable_changed",
          actorType: principal.type,
          actorId: principal.type === "api_key" ? principal.id : undefined,
          details: { durable },
        },
        db,
        dependencies.maintenanceState,
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
      try {
        const record = await repo.claimFileDeletion(
          request.params.code,
          "manual",
          db,
          now,
          async (pinned) => {
            const current = await resolvePrincipal(request, {
              config,
              db: pinned,
            });
            if (!current)
              throw new FilePolicyError(401, "Authentication required");
            if (!principalHasPermission(current, "can_delete"))
              throw new FilePolicyError(
                403,
                "Permission denied",
                "PERMISSION_DENIED",
              );
          },
        );
        if (!record) return reply.code(404).send({ error: "File not found" });
        if (!record.deletionClaimId) throw new Error("Deletion claim missing");
        await completeDeletion({
          file: record,
          root: config.storageRoot,
          db: db ?? {
            query: async () => {
              throw new Error("Database required");
            },
          },
          maintenanceState: dependencies.maintenanceState,
          actorType: principal.type,
          actorId: principal.type === "api_key" ? principal.id : undefined,
          activeUploads,
          remove: storage.deleteStoredFile,
          finish: repo.finalizeFileDeletion,
          ...(dependencies.repo?.claimFileDeletion && !db
            ? { verify: async () => record }
            : {}),
          recount: () =>
            admission.rescan(
              async () => (await getStorageUsage(config.storageRoot)).bytes,
            ),
        });
        return { deleted: true, code: record.code };
      } catch (error) {
        if (error instanceof FilePolicyError) throw error;
        request.log.error("File deletion failed; claim retained for recovery");
        return reply.code(503).send({
          error: "File deletion is pending recovery",
          code: "FILE_DELETION_PENDING",
        });
      }
    },
  );
}

async function readUploadRequest(
  request: FastifyRequest,
  storageRoot: string,
  storage: FilesStorage,
  maxUploadBytes: number,
  hold: (key: string) => void,
  protectKey: (key: string) => () => void,
  checkpoint: () => Promise<void>,
  idleTimeoutMs?: number,
): Promise<ParsedUpload | null> {
  const fields: Record<string, unknown> = Object.create(null);
  let upload: ParsedUpload | null = null;
  let fieldCount = 0;
  let fileCount = 0;
  let partCount = 0;
  let currentStream: Readable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectIdle!: (error: Error) => void;
  const expired = new Promise<never>((_resolve, reject) => {
    rejectIdle = reject;
  });
  const fail = (error: Error) => {
    currentStream?.destroy(error);
    rejectIdle(error);
  };
  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        fail(
          request.raw.readableEnded
            ? new FilePolicyError(
                400,
                "Incomplete multipart upload",
                "INVALID_INPUT",
              )
            : new FilePolicyError(
                408,
                "Upload idle timeout",
                "UPLOAD_IDLE_TIMEOUT",
              ),
        ),
      idleTimeoutMs ?? MULTIPART_IDLE_TIMEOUT_MS,
    );
    timer.unref();
  };
  const aborted = () =>
    fail(new FilePolicyError(400, "Upload interrupted", "INVALID_INPUT"));
  request.raw.on("data", resetIdle);
  request.raw.on("aborted", aborted);
  request.raw.on("error", aborted);
  resetIdle();

  try {
    const parts = request.parts({
      limits: { ...multipartLimits, fileSize: maxUploadBytes },
    });
    while (true) {
      const next = await Promise.race([parts.next(), expired]);
      if (next.done) break;
      const part = next.value;
      partCount += 1;
      if (partCount > multipartLimits.parts) {
        throw multipartLimitError();
      }

      if (part.type === "file") {
        currentStream = part.file;
        fileCount += 1;
        if (fileCount > multipartLimits.files || upload) {
          await drainFilePart(part);
          throw multipartLimitError();
        }

        if (part.fieldname !== "file") invalidInput("Expected file part");
        validateFilename(part.filename);
        const staged = await storage.stageUpload({
          storageRoot,
          originalName: part.filename,
          stream: part.file,
          maxBytes: maxUploadBytes,
          onKey: hold,
          protectKey,
          checkpoint,
          idleTimeoutMs,
        });
        hold(staged.tempKey);
        await drainFilePart(part);
        currentStream = undefined;
        if (part.file.truncated) {
          throw multipartLimitError();
        }
        upload = {
          filename: part.filename,
          mimetype: part.mimetype,
          fields,
          staged,
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
  } finally {
    clearTimeout(timer);
    request.raw.off("data", resetIdle);
    request.raw.off("aborted", aborted);
    request.raw.off("error", aborted);
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
