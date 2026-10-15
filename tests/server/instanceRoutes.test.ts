import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/index";
import { testConfig } from "../helpers/config";
describe("public instance metadata and bundled skill", () => {
  const servers: ReturnType<typeof buildServer>[] = [];
  afterEach(async () => { await Promise.all(servers.map(server => server.close())); });
  function server() {
    const app = buildServer(testConfig({ publicBaseUrl: "https://files.example.com", retentionDays: 7, maxUploadBytes: 1000, allowPersistentFiles: false }), { db: { query: async () => { throw new Error("Public metadata must not query database"); }, close: async () => { } } });
    servers.push(app);
    return app;
  }
  it("exposes only the fixed non-secret metadata fields without authentication", async () => {
    const response = await server().inject("/api/instance");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: "AgentFiles", base_url: "https://files.example.com", retention_days: 7, max_upload_bytes: 1000, allow_persistent_files: false, skill_url: "https://files.example.com/skills/agentfiles/SKILL.md" });
    const hidden = testConfig();
    for (const value of [hidden.databaseUrl, hidden.storageRoot, hidden.sessionSecret, hidden.adminUsername, hidden.adminPasswordHash]) {
      expect(response.body.includes(value)).toBe(false);
    }
  });
  it("serves identical literal UTF-8 skill bytes regardless of credentials", async () => {
    const app = server();
    const expected = await readFile("skills/agentfiles/SKILL.md", "utf8");
    for (const headers of [{}, { authorization: "Bearer synthetic-key-sentinel", cookie: "agentfiles_admin=synthetic-cookie-sentinel" }]) {
      const response = await app.inject({ url: "/skills/agentfiles/SKILL.md", headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/^text\/plain; charset=utf-8/);
      expect(response.body).toBe(expected);
      expect(response.body).not.toMatch(/synthetic-(?:key|cookie)-sentinel/);
    }
  });
  it.each(["/skills/agentfiles/../SKILL.md", "/skills/agentfiles/%2e%2e%2f.env", "/skills/agentfiles/OTHER.md"])("rejects arbitrary skill paths: %s", async (url) => {
    expect((await server().inject(url)).statusCode).toBe(404);
  });
});
