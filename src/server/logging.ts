import type { FastifyRequest } from "fastify";

// Allowlist serializers omit bodies, headers, query strings, filesystem paths,
// credentials and arbitrary error properties (including database diagnostics).
export const safeLogSerializers = {
  req(request: FastifyRequest) {
    return {
      method: request.method,
      url: request.routeOptions?.url ?? "[unmatched]",
    };
  },
  res(reply: { statusCode: number }) {
    return { statusCode: reply.statusCode };
  },
  err() {
    return { type: "Error", message: "Request failed", stack: "" };
  },
  error() {
    return { type: "Error", message: "Operation failed" };
  },
};
export const safeLoggerOptions = {
  serializers: safeLogSerializers,
  redact: {
    paths: [
      "authorization",
      "cookie",
      "set-cookie",
      "password",
      "session",
      "session_hash",
      "key_hash",
      "key",
      "secret",
      "req.headers",
      "res.headers",
      "body",
      "hash",
      "keyHash",
      "sessionHash",
      "passwordHash",
      "*.password",
      "*.session",
      "*.session_hash",
      "*.hash",
      "*.key_hash",
      "*.key",
      "*.secret",
    ],
    censor: "[REDACTED]",
  },
};
