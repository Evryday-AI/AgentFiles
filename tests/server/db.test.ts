import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { createDatabase, unconfiguredDatabase } from "../../src/server/db";
import { validatedDatabaseUrl } from "../../src/server/config";
import { integrationDatabaseUrl } from "../helpers/integration";
const captured = vi.hoisted(() => ({ options: undefined as pg.PoolConfig | undefined }));
vi.mock("pg", async importOriginal => {
  const actual = await importOriginal<typeof import("pg")>();
  class CapturingPool extends actual.default.Pool {
    constructor(options: pg.PoolConfig) { super(options); captured.options = options; }
  }
  return { ...actual, default: { ...actual.default, Pool: CapturingPool } };
});
afterEach(() => vi.unstubAllEnvs());
function ambient() {
  for (const [key, value] of Object.entries({ PGHOST: "ambient.example", PGPORT: "9999", PGDATABASE: "ambient", PGUSER: "ambient", PGPASSWORD: "ambient-secret", PGSSLMODE: "no-verify", PGSSLNEGOTIATION: "direct", PGOPTIONS: "-c statement_timeout=0" })) vi.stubEnv(key, value);
}
function parameters() {
  return (new pg.Client(captured.options) as unknown as { connectionParameters: { host: string; port: number; user: string; password: string | (() => string); database: string; ssl: unknown; sslnegotiation: string; statement_timeout: number; query_timeout: number; options: string } }).connectionParameters;
}
describe("explicit database connection", () => {
  it("does not inherit ambient credentials, port or TLS when URL omits them", async () => {
    ambient(); const db = createDatabase("postgresql://configured.example/independent");
    try {
      const actual = parameters();
      expect(actual.host).toBe("configured.example"); expect(actual.database).toBe("independent");
      expect(actual.port).toBe(5432); expect(actual.user).toBe("postgres");
      expect(typeof actual.password).toBe("function"); expect((actual.password as () => string)()).toBe("");
      expect(actual.ssl).toBe(false); expect(actual.sslnegotiation).toBe("postgres");
      expect(actual.options).not.toContain("statement_timeout=0");
      expect(actual.statement_timeout).toBeLessThanOrEqual(3000); expect(actual.query_timeout).toBeLessThanOrEqual(3000);
      expect(captured.options?.connectionTimeoutMillis).toBeLessThanOrEqual(3000);
    } finally { await db.close(); }
  });
  it("preserves explicit URL credentials and TLS while capping URL-provided timeouts", async () => {
    ambient(); const db = createDatabase("postgresql://explicit:explicit-secret@configured.example:5544/independent?sslmode=verify-full&sslnegotiation=direct&statement_timeout=90000&query_timeout=90000&connectionTimeoutMillis=90000");
    try {
      const actual = parameters(); expect(actual.user).toBe("explicit"); expect(actual.password).toBe("explicit-secret"); expect(actual.port).toBe(5544);
      expect(actual.ssl).toEqual({}); expect(actual.sslnegotiation).toBe("direct");
      expect(actual.statement_timeout).toBe(2500); expect(actual.query_timeout).toBe(2500);
      expect(captured.options?.connectionTimeoutMillis).toBe(2500);
    } finally { await db.close(); }
  });
  it("preserves the explicitly requested no-verify URL TLS mode", async () => {
    const db = createDatabase("postgresql://configured.example/independent?ssl=no-verify");
    try { expect(parameters().ssl).toEqual({ rejectUnauthorized: false }); }
    finally { await db.close(); }
  });
  it.each([
    ["connectionString", "postgresql://nested.example/independent?statement_timeout=90000&query_timeout=90000"],
    ["%63onnectionString", "postgresql://nested-user:nested-secret@nested.example/independent?statement_timeout=90000&query_timeout=90000"],
  ])("rejects reserved query option %s before pool construction without exposing its value", async (option, nestedUrl) => {
    ambient();
    const outerUrl = "postgresql://explicit:explicit-secret@configured.example:5544/independent";
    const db = createDatabase(outerUrl);
    try {
      // Exercise real pg.Client parsing with synthetic PG* settings and no network.
      const actual = parameters();
      expect(actual.user).toBe("explicit"); expect(actual.password).toBe("explicit-secret"); expect(actual.port).toBe(5544);
      expect(actual.statement_timeout).toBe(2500); expect(actual.query_timeout).toBe(2500);
    } finally { await db.close(); }
    captured.options = undefined;
    expect(() => createDatabase(`${outerUrl}?${option}=${encodeURIComponent(nestedUrl)}`)).toThrowError(new Error("DATABASE_URL is invalid"));
    expect(captured.options).toBeUndefined();
  });
  it("rejects missing root wiring without consulting DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://ambient:secret@ambient.example/unowned");
    await expect(unconfiguredDatabase.query("SELECT 1")).rejects.toThrow("Database dependency is required");
  });
  it("migration configuration validates only DATABASE_URL", () => {
    expect(validatedDatabaseUrl({ DATABASE_URL: "postgresql://configured.example/independent", ADMIN_PASSWORD_HASH: "invalid", SESSION_SECRET: "invalid" })).toBe("postgresql://configured.example/independent");
    expect(() => validatedDatabaseUrl({ DATABASE_URL: "synthetic-secret" })).toThrow("DATABASE_URL is invalid");
  });
});
describe("independent integration gate", () => {
  it("refuses generic, missing, unnamed or redirected database settings", () => {
    const url = "postgresql://fixture:fixture@localhost:5432/agentfiles_test_123456789abc";
    expect(integrationDatabaseUrl({ AGENTFILES_TEST_DATABASE_URL: url })).toBe(url);
    for (const source of [{}, { DATABASE_URL: url, AGENTFILES_TEST_DATABASE_URL: url }, { AGENTFILES_TEST_DATABASE_URL: url.replace("agentfiles_test_123456789abc", "production") }, { AGENTFILES_TEST_DATABASE_URL: url + "?host=ambient.example" }, { AGENTFILES_TEST_DATABASE_URL: url.replace("fixture:fixture@", "") }]) expect(() => integrationDatabaseUrl(source)).toThrow();
  });
});
