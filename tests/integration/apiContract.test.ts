import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationFixture, syntheticMultipart } from "../helpers/integration";
const observedRoutes = vi.hoisted(() => [] as Array<{
  method: string | string[];
  url: string;
}>);
// Capture onRoute on the real Fastify server before any synchronous route
// registration. Every handler, plugin, request and DB call remains real.
vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  return { ...actual, default: (...args: Parameters<typeof actual.default>) => {
      const server = actual.default(...args);
      server.addHook("onRoute", route => { observedRoutes.push({ method: route.method, url: route.url }); });
      return server;
    } };
});
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse())
  await close(); });
async function fixture(now?: () => Date) {
  const f = await createIntegrationFixture({}, { now });
  closes.push(f.close);
  return f;
}
async function specification() {
  return await SwaggerParser.validate("openapi.yaml", { resolve: { external: false } }) as any;
}
function validator(schema: any) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // JSON Schema maxLength counts characters. This documented extension mirrors
  // the server's separate UTF-8 byte limit for request strings.
  ajv.addKeyword({
    keyword: "x-max-utf8-bytes",
    type: "string",
    schemaType: "number",
    validate: (limit: number, value: string) => Buffer.byteLength(value, "utf8") <= limit,
  });
  return ajv.compile(schema);
}
function schemaCheck(api: any, path: string, method: string, expectedStatus: number, response: {
  statusCode: number;
  json(): unknown;
}) {
  expect(response.statusCode, `${method.toUpperCase()} ${path} status`).toBe(expectedStatus);
  const schema = api.paths[path][method].responses[String(expectedStatus)].content["application/json"].schema;
  const validate = validator(schema);
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
  return validate;
}
describe("observed HTTP OpenAPI contract", () => {
  it("requires the intended status before validating a response body", async () => {
    const api = await specification();
    const json = vi.fn(() => ({ error: "synthetic documented failure" }));
    expect(() => schemaCheck(api, "/api/files", "get", 200, {
      statusCode: 403,
      json,
    })).toThrow("GET /api/files status");
    expect(json).not.toHaveBeenCalled();
  });
  it("documents anonymous same-origin logout and explicit Bearer rejection", async () => {
    const api = await specification();
    expect(api.paths["/api/auth/logout"].post.security).toContainEqual({});
    const f = await fixture();
    const logout = await f.server.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { origin: f.config.publicBaseUrl },
    });
    schemaCheck(api, "/api/auth/logout", "post", 200, logout);
    expect(logout.json()).toEqual({ authenticated: false });
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    schemaCheck(api, "/api/auth/logout", "post", 403, await f.server.inject({
      method: "POST", url: "/api/auth/logout",
    }));
    const key = await f.createSyntheticKey(["can_download"]);
    schemaCheck(api, "/api/auth/logout", "post", 403, await f.server.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { ...key.headers, origin: f.config.publicBaseUrl },
    }));
    schemaCheck(api, "/api/auth/logout", "post", 401, await f.server.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { authorization: "Bearer synthetic-invalid", origin: f.config.publicBaseUrl },
    }));
  });
  it("matches UTF-8 byte, nonblank and NUL request boundaries against actual handlers", async () => {
    const api = await specification();
    const validLogin = validator(api.components.schemas.Login);
    // Separate fixtures keep the real five-attempt login rate limit intact.
    for (const [field, limit] of [["username", 128], ["password", 4096]] as const) {
      const f = await fixture();
      for (const [value, status] of [
        ["a".repeat(limit), 401], ["a".repeat(limit + 1), 400],
        ["é".repeat(limit / 2), 401], ["é".repeat(limit / 2 + 1), 400],
      ] as const) {
        const body = { username: "synthetic-wrong-user", password: "synthetic-wrong-password", [field]: value };
        expect(validLogin(body)).toBe(status === 401);
        schemaCheck(api, "/api/auth/login", "post", status, await f.server.inject({
          method: "POST", url: "/api/auth/login", payload: body,
        }));
      }
    }
    const f = await fixture();
    const login = await f.server.inject({ method: "POST", url: "/api/auth/login",
      payload: { username: f.config.adminUsername, password: "synthetic-unused-fixture-password" } });
    schemaCheck(api, "/api/auth/login", "post", 200, login);
    const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0], origin: f.config.publicBaseUrl };
    const validCreate = validator(api.components.schemas.KeyCreateInput);
    const validPatch = validator(api.components.schemas.KeyInput);
    for (const name of ["a".repeat(128), "é".repeat(64)]) {
      expect(validCreate({ name })).toBe(true);
      expect(validPatch({ name })).toBe(true);
      const created = await f.server.inject({ method: "POST", url: "/api/admin/api-keys", headers, payload: { name } });
      schemaCheck(api, "/api/admin/api-keys", "post", 201, created);
      const url = `/api/admin/api-keys/${created.json().apiKey.id}`;
      schemaCheck(api, "/api/admin/api-keys/{id}", "patch", 200, await f.server.inject({ method: "PATCH", url, headers, payload: { name } }));
      for (const invalid of ["a".repeat(129), "é".repeat(65), " \t\n", "synthetic\0name", " " + "a".repeat(128)]) {
        expect(validCreate({ name: invalid })).toBe(false);
        expect(validPatch({ name: invalid })).toBe(false);
        schemaCheck(api, "/api/admin/api-keys", "post", 400, await f.server.inject({ method: "POST", url: "/api/admin/api-keys", headers, payload: { name: invalid } }));
        schemaCheck(api, "/api/admin/api-keys/{id}", "patch", 400, await f.server.inject({ method: "PATCH", url, headers, payload: { name: invalid } }));
      }
    }
  });
  it("has a validated specification with operation IDs", async () => {
    const api = await specification();
    expect(api.openapi).toBe("3.1.0");
    const operations = Object.values(api.paths).flatMap((path: any) => Object.entries(path).filter(([method]) => /^(get|post|patch|delete)$/.test(method)).map(([, operation]: any) => operation.operationId));
    expect(operations.every((id: unknown) => typeof id === "string")).toBe(true);
    expect(new Set(operations).size).toBe(operations.length);
  });
  it("matches actual Fastify route templates and methods, excluding only browser shell/assets and automatic HEAD", async () => {
    const api = await specification();
    observedRoutes.length = 0;
    await fixture();
    const observed = observedRoutes.flatMap(route => (Array.isArray(route.method) ? route.method : [route.method])
      .filter(method => method !== "HEAD" && !["/", "/files/:code", "/assets/*"].includes(route.url))
      .map(method => `${method.toLowerCase()} ${route.url.replace(/:([A-Za-z]+)/g, "{$1}")}`));
    const documented = Object.entries(api.paths).flatMap(([path, operations]: any) => Object.keys(operations).filter(method => /^(get|post|patch|delete)$/.test(method)).map(method => `${method} ${path}`));
    expect(observed.sort()).toEqual(documented.sort());
  });
  it("validates real JSON success, File aliases, admin bytes, and controlled errors; rejects broken DTOs", async () => {
    const api = await specification();
    const f = await fixture();
    const key = await f.createSyntheticKey(["can_upload", "can_download", "can_list", "can_delete", "can_share", "can_mark_durable"]);
    schemaCheck(api, "/api/instance", "get", 200, await f.server.inject("/api/instance"));
    schemaCheck(api, "/api/health", "get", 200, await f.server.inject("/api/health"));
    schemaCheck(api, "/api/ready", "get", 200, await f.server.inject("/api/ready"));
    schemaCheck(api, "/api/auth/session", "get", 200, await f.server.inject("/api/auth/session"));
    schemaCheck(api, "/api/auth/session", "get", 200, await f.server.inject({ url: "/api/auth/session", headers: key.headers }));
    schemaCheck(api, "/api/files/{code}", "get", 401, await f.server.inject("/api/files/F-AAAAA"));
    schemaCheck(api, "/api/admin/api-keys", "get", 403, await f.server.inject("/api/admin/api-keys"));
    const upload = await f.server.inject({ method: "POST", url: "/api/files", headers: { ...key.headers, ...syntheticMultipart("schema bytes").headers }, payload: syntheticMultipart("schema bytes").payload });
    const valid = schemaCheck(api, "/api/files", "post", 201, upload);
    const file = upload.json();
    for (const name of Object.keys(file)) {
      const missing = { ...file };
      delete missing[name];
      expect(valid(missing)).toBe(false);
    }
    expect(valid({ ...file, size_bytes: "wrong" })).toBe(false);
    expect(file.size).toBe(file.size_bytes);
    expect(file.expiry).toBe(file.expires_at);
    expect(file.durable).toBe(file.is_durable);
    schemaCheck(api, "/api/files/{code}", "get", 200, await f.server.inject({ url: `/api/files/${file.code}`, headers: key.headers }));
    schemaCheck(api, "/api/files", "get", 200, await f.server.inject({ url: "/api/files?limit=1&offset=0&durable=false", headers: key.headers }));
    schemaCheck(api, "/api/files", "get", 400, await f.server.inject({ url: "/api/files?limit=bad", headers: key.headers }));
    const share = await f.server.inject({ method: "POST", url: `/api/files/${file.code}/share`, headers: key.headers, payload: { expires_at: new Date(Date.now() + 60000).toISOString(), max_downloads: 2 } });
    schemaCheck(api, "/api/files/{code}/share", "post", 201, share);
    const bytes = await f.server.inject({ url: `/api/files/${file.code}/download`, headers: key.headers });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe("schema bytes");
    expect(bytes.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(bytes.headers["cache-control"]).toBe("no-store");
    expect(bytes.headers.location).toBeUndefined();
    const byteContent = api.paths["/api/files/{code}/download"].get.responses["200"].content;
    expect(byteContent[String(bytes.headers["content-type"]).split(";")[0]] ?? byteContent["*/*"]).toBeDefined();
    schemaCheck(api, "/api/share-links/{id}", "delete", 200, await f.server.inject({ method: "DELETE", url: `/api/share-links/${share.json().id}`, headers: key.headers }));
    schemaCheck(api, "/s/{token}", "get", 410, await f.server.inject(new URL(share.json().public_url).pathname));
    const login = await f.server.inject({ method: "POST", url: "/api/auth/login", payload: { username: f.config.adminUsername, password: "synthetic-unused-fixture-password" } });
    schemaCheck(api, "/api/auth/login", "post", 200, login);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const adminHeaders = { cookie, origin: f.config.publicBaseUrl };
    const createdKey = await f.server.inject({ method: "POST", url: "/api/admin/api-keys", headers: adminHeaders, payload: { name: "contract scoped key", can_upload: false, can_download: true, can_list: false } });
    schemaCheck(api, "/api/admin/api-keys", "post", 201, createdKey);
    schemaCheck(api, "/api/admin/api-keys", "get", 200, await f.server.inject({ url: "/api/admin/api-keys", headers: adminHeaders }));
    const keyId = createdKey.json().apiKey.id;
    schemaCheck(api, "/api/admin/api-keys/{id}", "patch", 200, await f.server.inject({ method: "PATCH", url: `/api/admin/api-keys/${keyId}`, headers: adminHeaders, payload: { can_download: false } }));
    schemaCheck(api, "/api/admin/api-keys/{id}", "delete", 200, await f.server.inject({ method: "DELETE", url: `/api/admin/api-keys/${keyId}`, headers: adminHeaders }));
    schemaCheck(api, "/api/files/{code}", "patch", 200, await f.server.inject({ method: "PATCH", url: `/api/files/${file.code}`, headers: key.headers, payload: { durable: false } }));
    const status = await f.server.inject({ url: "/api/admin/storage-usage", headers: { cookie } });
    schemaCheck(api, "/api/admin/storage-usage", "get", 200, status);
    expect(status.json().bytes).toBeGreaterThan(0);
    schemaCheck(api, "/api/files/{code}", "delete", 200, await f.server.inject({ method: "DELETE", url: `/api/files/${file.code}`, headers: key.headers }));
    schemaCheck(api, "/api/auth/logout", "post", 200, await f.server.inject({ method: "POST", url: "/api/auth/logout", headers: adminHeaders }));
  });
  it("documents and validates exact expiry against an injected fixture clock", async () => {
    let clock = new Date("2026-10-11T10:00:00Z");
    const api = await specification();
    const f = await fixture(() => clock);
    const file = await f.uploadSynthetic({ text: "expiry", permissions: "upload" });
    const key = await f.createSyntheticKey(["can_download"]);
    clock = new Date(file.expires_at!);
    const response = await f.server.inject({ url: `/api/files/${file.code}`, headers: key.headers });
    expect(response.statusCode).toBe(410);
    schemaCheck(api, "/api/files/{code}", "get", 410, response);
  });
});
