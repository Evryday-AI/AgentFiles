import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { unconfiguredDatabase, type Queryable } from "./db.js";

export const ADMIN_SESSION_COOKIE_NAME = "agentfiles_admin";

export type Permission =
  | "can_upload"
  | "can_download"
  | "can_list"
  | "can_delete"
  | "can_mark_durable"
  | "can_share";

export interface AdminPrincipal {
  type: "admin";
  name: string;
  isAdmin: true;
}

export interface ApiKeyPrincipal {
  type: "api_key";
  id: string;
  name: string;
  can_upload: boolean;
  can_download: boolean;
  can_list: boolean;
  can_delete: boolean;
  can_mark_durable: boolean;
  can_share: boolean;
}

export type Principal = AdminPrincipal | ApiKeyPrincipal;

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
}

interface AdminSessionRow {
  id: string;
}

const db = unconfiguredDatabase;

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
  can_share
`;

export async function hashApiKey(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id });
}

export async function verifyApiKeySecret(
  hash: string,
  secret: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

export function hasPermission(
  principal: Partial<Record<Permission, unknown>> & {
    type?: unknown;
    isAdmin?: unknown;
  },
  permission: Permission,
): boolean {
  if (principal.isAdmin === true) {
    return true;
  }

  return principal[permission] === true;
}

export function createApiKeySecret(): string {
  return `af_${randomBytes(12).toString("hex")}_${randomBytes(32).toString("hex")}`;
}

export function parseApiKeySecret(secret: string): { lookupId: string } | null {
  if (secret.length !== 92) {
    return null;
  }
  const match = /^af_([a-f0-9]{24})_([a-f0-9]{64})$/.exec(secret);
  if (!match) {
    return null;
  }

  return { lookupId: match[1] };
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function resolvePrincipal(
  request: FastifyRequest,
  options: { config: AppConfig; db?: Queryable },
): Promise<Principal | null> {
  const client = options.db ?? db;
  if (request.headers.authorization !== undefined)
    return resolveApiKeyPrincipal(request, client);
  const admin = await resolveAdminPrincipal(request, options.config, client);
  if (admin) {
    return admin;
  }

  return resolveApiKeyPrincipal(request, client);
}

export async function resolveAdminPrincipal(
  request: FastifyRequest,
  config: AppConfig,
  client: Queryable = db,
): Promise<AdminPrincipal | null> {
  const token = getAdminSessionCookie(request);
  if (!token) {
    return null;
  }

  const sessionHash = hashSessionToken(token);
  // Resolution may run after a transaction's file-lock wait; now() would
  // reuse the transaction start and accept a session that has since expired.
  const result = await client.query<AdminSessionRow>(
    `
      UPDATE admin_sessions
      SET last_seen_at = now()
      WHERE session_hash = $1
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING id
    `,
    [sessionHash],
  );

  if (!result.rows[0]) {
    return null;
  }

  return { type: "admin", name: config.adminUsername, isAdmin: true };
}

export async function resolveApiKeyPrincipal(
  request: FastifyRequest,
  client: Queryable = db,
): Promise<ApiKeyPrincipal | null> {
  const secret = getBearerToken(request);
  if (!secret) {
    return null;
  }

  const parsed = parseApiKeySecret(secret);
  if (!parsed) {
    return null;
  }

  const result = await client.query<ApiKeyRow>(
    `
      SELECT ${apiKeyColumns}
      FROM api_keys
      WHERE lookup_id = $1
        AND revoked_at IS NULL
      LIMIT 1
    `,
    [parsed.lookupId],
  );

  const row = result.rows[0];
  if (!row || !(await verifyApiKeySecret(row.key_hash, secret))) {
    return null;
  }

  const touchResult = await client.query<ApiKeyRow>(
    `
      UPDATE api_keys
      SET last_used_at = now()
      WHERE id = $1
        AND revoked_at IS NULL
      RETURNING ${apiKeyColumns}
    `,
    [row.id],
  );
  const touchedRow = touchResult.rows[0];
  if (!touchedRow) {
    return null;
  }

  return {
    type: "api_key",
    id: touchedRow.id,
    name: touchedRow.name,
    can_upload: touchedRow.can_upload,
    can_download: touchedRow.can_download,
    can_list: touchedRow.can_list,
    can_delete: touchedRow.can_delete,
    can_mark_durable: touchedRow.can_mark_durable,
    can_share: touchedRow.can_share,
  };
}

export function principalHasPermission(
  principal: Principal,
  permission: Permission,
): boolean {
  return hasPermission(principal, permission);
}

function getBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function getAdminSessionCookie(request: FastifyRequest): string | null {
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
  if (!unsigned.valid || !unsigned.value) {
    return null;
  }
  return unsigned.value;
}
