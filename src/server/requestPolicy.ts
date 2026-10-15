import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { FilePolicyError } from "./filePolicy.js";

export const FILE_CODE_PATTERN = /^F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
export const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function invalidInput(message = "Invalid input"): never {
  throw new FilePolicyError(400, message, "INVALID_INPUT");
}
export function strictObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalidInput();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key)))
    return invalidInput("Unknown field");
  return record;
}
export function strictBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalidInput("Flag must be a boolean");
  return value;
}
export function formBoolean(value: unknown): boolean {
  if (value === "true" || value === "1" || value === "on") return true;
  if (value === "false" || value === "0" || value === "off") return false;
  return invalidInput("durable must be a boolean");
}
export function boundedInteger(
  value: unknown,
  min: number,
  max: number,
): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    return invalidInput("Invalid pagination");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    return invalidInput("Invalid pagination");
  return parsed;
}
export function validateFilename(value: string): void {
  if (!value || value.includes("\0") || Buffer.byteLength(value) > 1024)
    invalidInput("Invalid filename");
}

export function checkMutationPolicy(
  request: FastifyRequest,
  config: AppConfig,
  cookieAuthority: boolean,
  login = false,
): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    fetchSite === "cross-site" ||
    (origin !== undefined && origin !== config.publicBaseUrl)
  ) {
    throw new FilePolicyError(
      403,
      "Same-origin request required",
      "PERMISSION_DENIED",
    );
  }
  if (login) {
    const contentType = request.headers["content-type"] ?? "";
    if (!/^application\/json(?:;|$)/i.test(contentType))
      invalidInput("Login requires JSON");
    return;
  }
  if (!cookieAuthority) return;
  // Cookie mutations always require the exact configured Origin. Fetch metadata
  // alone cannot identify which origin a request came from.
  if (origin !== config.publicBaseUrl)
    throw new FilePolicyError(
      403,
      "Same-origin request required",
      "PERMISSION_DENIED",
    );
}

export function registerResponsePolicy(server: FastifyInstance): void {
  server.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
    return payload;
  });
  server.addHook("preValidation", async (request) => {
    const params = request.params as Record<string, string>;
    if (params.code !== undefined && !FILE_CODE_PATTERN.test(params.code))
      invalidInput("Invalid file code");
    if (params.id !== undefined && !UUID_PATTERN.test(params.id))
      invalidInput("Invalid id");
  });
}

export function sendControlledError(
  error: unknown,
  _request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof FilePolicyError) {
    if (error.statusCode === 408) reply.header("connection", "close");
    if (["UPLOAD_CONCURRENCY_LIMIT", "CODE_ALLOCATION_RETRY_EXHAUSTED"].includes(error.code ?? "")) reply.header("retry-after", "1");
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
  const status = (error as { statusCode?: number })?.statusCode;
  const statusCode =
    typeof status === "number" && status >= 400 && status < 500 ? status : 500;
  if (statusCode === 500)
    _request.log.error({ err: error }, "Request operation failed");
  return reply.code(statusCode).send({
    error: statusCode === 500 ? "Operation failed" : "Invalid request",
    ...(statusCode === 400 ? { code: "INVALID_INPUT" } : {}),
  });
}
