import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config";

describe("loadConfig", () => {
  const requiredEnv = {
    DATABASE_URL: "postgres://user:pass@localhost:5432/agentfiles_test",
    STORAGE_ROOT: join(tmpdir(), "agentfiles-test", "storage"),
    SESSION_SECRET: "session-secret-with-at-least-32-characters",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
  };

  it("parses required environment variables", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "4321",
      ...requiredEnv,
    });

    expect(config.port).toBe(4321);
    expect(config.databaseUrl).toContain("postgres://");
    expect(config.storageRoot).toBe(join(tmpdir(), "agentfiles-test", "storage"));
    expect(config.retentionDays).toBe(7);
  });

  it("requires an external HTTPS public base URL in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ...requiredEnv,
      }),
    ).toThrow();

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "http://localhost:3000",
        ...requiredEnv,
      }),
    ).toThrow();

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "http://127.0.0.1:3000",
        ...requiredEnv,
      }),
    ).toThrow();

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "http://files.example.com",
        ...requiredEnv,
      }),
    ).toThrow();
  });

  it("accepts an explicit public base URL in production", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://files.example.com",
      ...requiredEnv,
    });

    expect(config.publicBaseUrl).toBe("https://files.example.com");
  });

  it("rejects unknown node environments", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "staging",
        ...requiredEnv,
      }),
    ).toThrow();
  });
});
