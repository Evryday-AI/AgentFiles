import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cookieIsSecure, type AppConfig } from "./config.js";
import { query as defaultQuery, type Queryable } from "./db.js";
import {
  ADMIN_SESSION_COOKIE_NAME,
  createApiKeySecret,
  createSessionToken,
  hashApiKey,
  hashSessionToken,
  parseApiKeySecret,
  resolvePrincipal,
  verifyApiKeySecret,
  type AdminPrincipal,
  type ApiKeyPrincipal,
} from "./auth.js";
import { getStorageUsage as defaultGetStorageUsage } from "./storage.js";

interface AdminRoutesOptions {
  config: AppConfig;
  db?: Queryable;
  storage?: Partial<AdminStorage>;
}

interface AdminStorage {
  getStorageUsage(storageRoot: string): Promise<{ bytes: number }>;
}

interface ApiKeyRow {
  id: string;
  name: string;
  lookup_id: string;
  key_hash: string;
  can_upload: boolean;
  can_download: boolean;
  can_list: boolean;
  can_delete: boolean;
  can_mark_durable: boolean;
  can_share: boolean;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface ApiKeyBody {
  name?: unknown;
  can_upload?: unknown;
  can_download?: unknown;
  can_list?: unknown;
  can_delete?: unknown;
  can_mark_durable?: unknown;
  can_share?: unknown;
}

const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const apiKeyColumns = `
  id,
  name,
  lookup_id,
  key_hash,
  can_upload,
  can_download,
  can_list,
  can_delete,
  can_mark_durable,
  can_share,
  created_at,
  last_used_at,
  revoked_at
`;

const db: Queryable = {
  query: defaultQuery,
};

const defaultStorage: AdminStorage = {
  getStorageUsage: defaultGetStorageUsage,
};

export async function registerAdminRoutes(
  server: FastifyInstance,
  options: AdminRoutesOptions,
) {
  const client = options.db ?? db;
  const config = options.config;
  const storage = { ...defaultStorage, ...options.storage };

  server.addHook("onRequest", async (request) => {
    if (isBodylessJsonLogoutRequest(request)) {
      delete request.headers["content-type"];
    }
  });

  server.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const body = asRecord(request.body);
      const username = typeof body?.username === "string" ? body.username : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const passwordMatches = await verifyApiKeySecret(config.adminPasswordHash, password);

      if (username !== config.adminUsername || !passwordMatches) {
        return reply.code(401).send({ error: "Invalid username or password" });
      }

      const token = createSessionToken();
      const expiresAt = new Date(Date.now() + sessionTtlMs);
      await client.query(
        `
        INSERT INTO admin_sessions (session_hash, expires_at)
        VALUES ($1, $2)
        RETURNING id
      `,
        [hashSessionToken(token), expiresAt],
      );

      reply.setCookie(ADMIN_SESSION_COOKIE_NAME, token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: cookieIsSecure(config),
        signed: true,
        maxAge: Math.floor(sessionTtlMs / 1000),
      });

      return {
        authenticated: true,
        principal: publicAdminPrincipal(config),
      };
    },
  );

  server.post("/api/auth/logout", async (request, reply) => {
    const token = getSessionTokenFromRequest(request);
    if (token) {
      await client.query(
        `
          UPDATE admin_sessions
          SET revoked_at = now()
          WHERE session_hash = $1 AND revoked_at IS NULL
        `,
        [hashSessionToken(token)],
      );
    }

    clearSessionCookie(reply, config);
    return { authenticated: false };
  });

  server.get("/api/auth/session", async (request) => {
    const principal = await resolvePrincipal(request, { config, db: client });
    if (!principal) {
      return { authenticated: false, principal: null };
    }

    return {
      authenticated: true,
      principal:
        principal.type === "admin" ? publicAdminPrincipal(config) : publicApiKeyPrincipal(principal),
    };
  });

  server.get("/api/admin/api-keys", async (request, reply) => {
    const principal = await requireAdmin(request, reply, config, client);
    if (!principal) {
      return;
    }

    const result = await client.query<ApiKeyRow>(
      `
        SELECT ${apiKeyColumns}
        FROM api_keys
        WHERE revoked_at IS NULL
        ORDER BY created_at DESC
      `,
    );

    return { apiKeys: result.rows.map(publicApiKeyRecord) };
  });

  server.get("/api/admin/storage-usage", async (request, reply) => {
    const principal = await requireAdmin(request, reply, config, client);
    if (!principal) {
      return;
    }

    return storage.getStorageUsage(config.storageRoot);
  });

  server.post("/api/admin/api-keys", async (request, reply) => {
    const principal = await requireAdmin(request, reply, config, client);
    if (!principal) {
      return;
    }

    const input = parseApiKeyBody(request.body);
    if (!input.name) {
      return reply.code(400).send({ error: "API key name is required" });
    }

    const secret = createApiKeySecret();
    const parsedSecret = parseApiKeySecret(secret);
    if (!parsedSecret) {
      throw new Error("Generated API key secret was invalid");
    }
    const keyHash = await hashApiKey(secret);
    const result = await client.query<ApiKeyRow>(
      `
        INSERT INTO api_keys (
          name,
          lookup_id,
          key_hash,
          can_upload,
          can_download,
          can_list,
          can_delete,
          can_mark_durable,
          can_share
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING ${apiKeyColumns}
      `,
      [
        input.name,
        parsedSecret.lookupId,
        keyHash,
        input.can_upload ?? true,
        input.can_download ?? true,
        input.can_list ?? true,
        input.can_delete ?? false,
        input.can_mark_durable ?? false,
        input.can_share ?? false,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("API key insert did not return a row");
    }

    return reply.code(201).send({
      apiKey: publicApiKeyRecord(row),
      secret,
    });
  });

  server.patch("/api/admin/api-keys/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, config, client);
    if (!principal) {
      return;
    }

    const { id } = request.params as { id?: string };
    const input = parseApiKeyBody(request.body);
    const updates: string[] = [];
    const params: unknown[] = [];

    for (const field of [
      "name",
      "can_upload",
      "can_download",
      "can_list",
      "can_delete",
      "can_mark_durable",
      "can_share",
    ] as const) {
      if (input[field] !== undefined) {
        params.push(input[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }

    if (!id) {
      return reply.code(400).send({ error: "API key id is required" });
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: "No API key updates provided" });
    }

    params.push(id);
    const result = await client.query<ApiKeyRow>(
      `
        UPDATE api_keys
        SET ${updates.join(", ")}
        WHERE id = $${params.length} AND revoked_at IS NULL
        RETURNING ${apiKeyColumns}
      `,
      params,
    );

    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "API key not found" });
    }

    return { apiKey: publicApiKeyRecord(row) };
  });

  server.delete("/api/admin/api-keys/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, config, client);
    if (!principal) {
      return;
    }

    const { id } = request.params as { id?: string };
    if (!id) {
      return reply.code(400).send({ error: "API key id is required" });
    }

    const result = await client.query<ApiKeyRow>(
      `
        UPDATE api_keys
        SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING ${apiKeyColumns}
      `,
      [id],
    );

    if (!result.rows[0]) {
      return reply.code(404).send({ error: "API key not found" });
    }

    return { revoked: true };
  });
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  client: Queryable,
): Promise<AdminPrincipal | null> {
  const principal = await resolvePrincipal(request, { config, db: client });
  if (principal?.type !== "admin") {
    reply.code(403).send({ error: "Admin authentication is required" });
    return null;
  }
  return principal;
}

function parseApiKeyBody(body: unknown): ApiKeyBody & { name?: string } {
  const record = asRecord(body) ?? {};
  const parsed: ApiKeyBody & { name?: string } = {};
  if (typeof record.name === "string" && record.name.trim()) {
    parsed.name = record.name.trim();
  }

  for (const field of [
    "can_upload",
    "can_download",
    "can_list",
    "can_delete",
    "can_mark_durable",
    "can_share",
  ] as const) {
    if (typeof record[field] === "boolean") {
      parsed[field] = record[field];
    }
  }

  return parsed;
}

function publicAdminPrincipal(config: AppConfig) {
  return { type: "admin", name: config.adminUsername };
}

function publicApiKeyPrincipal(principal: ApiKeyPrincipal) {
  return {
    type: "api_key",
    id: principal.id,
    name: principal.name,
    canUpload: principal.can_upload,
    canDownload: principal.can_download,
    canList: principal.can_list,
    canDelete: principal.can_delete,
    canMarkDurable: principal.can_mark_durable,
    canShare: principal.can_share,
  };
}

function publicApiKeyRecord(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    canUpload: row.can_upload,
    canDownload: row.can_download,
    canList: row.can_list,
    canDelete: row.can_delete,
    canMarkDurable: row.can_mark_durable,
    canShare: row.can_share,
    createdAt: toIsoString(row.created_at),
    lastUsedAt: toNullableIsoString(row.last_used_at),
    revokedAt: toNullableIsoString(row.revoked_at),
  };
}

function getSessionTokenFromRequest(request: FastifyRequest): string | null {
  const cookieRequest = request as FastifyRequest & {
    cookies?: Record<string, string>;
    unsignCookie?: (value: string) => { valid: boolean; value: string | null };
  };
  const rawCookie = cookieRequest.cookies?.[ADMIN_SESSION_COOKIE_NAME];
  if (!rawCookie) {
    return null;
  }

  if (!cookieRequest.unsignCookie) {
    return rawCookie;
  }

  const unsigned = cookieRequest.unsignCookie(rawCookie);
  return unsigned.valid ? unsigned.value : null;
}

function clearSessionCookie(reply: FastifyReply, config: AppConfig) {
  reply.clearCookie(ADMIN_SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: cookieIsSecure(config),
    signed: true,
  });
}

function isBodylessJsonLogoutRequest(request: FastifyRequest): boolean {
  const contentType = request.headers["content-type"];
  return (
    request.method === "POST" &&
    request.url.split("?", 1)[0] === "/api/auth/logout" &&
    typeof contentType === "string" &&
    contentType.toLowerCase().includes("application/json") &&
    (request.headers["content-length"] === undefined || request.headers["content-length"] === "0") &&
    request.headers["transfer-encoding"] === undefined
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIsoString(value: Date | string | null): string | null {
  return value === null ? null : toIsoString(value);
}
