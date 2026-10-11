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
function schemaCheck(api: any, path: string, method: string, response: {
  statusCode: number;
  json(): unknown;
}) {
  const schema = api.paths[path][method].responses[String(response.statusCode)].content["application/json"].schema;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
  return validate;
}
describe("observed HTTP OpenAPI contract", () => {
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
    schemaCheck(api, "/api/instance", "get", await f.server.inject("/api/instance"));
    schemaCheck(api, "/api/health", "get", await f.server.inject("/api/health"));
    schemaCheck(api, "/api/ready", "get", await f.server.inject("/api/ready"));
    schemaCheck(api, "/api/auth/session", "get", await f.server.inject("/api/auth/session"));
    schemaCheck(api, "/api/auth/session", "get", await f.server.inject({ url: "/api/auth/session", headers: key.headers }));
    schemaCheck(api, "/api/files/{code}", "get", await f.server.inject("/api/files/F-AAAAA"));
    schemaCheck(api, "/api/admin/api-keys", "get", await f.server.inject("/api/admin/api-keys"));
    const upload = await f.server.inject({ method: "POST", url: "/api/files", headers: { ...key.headers, ...syntheticMultipart("schema bytes").headers }, payload: syntheticMultipart("schema bytes").payload });
    const valid = schemaCheck(api, "/api/files", "post", upload);
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
    schemaCheck(api, "/api/files/{code}", "get", await f.server.inject({ url: `/api/files/${file.code}`, headers: key.headers }));
    schemaCheck(api, "/api/files", "get", await f.server.inject({ url: "/api/files?limit=1&offset=0&durable=false", headers: key.headers }));
    schemaCheck(api, "/api/files", "get", await f.server.inject({ url: "/api/files?limit=bad", headers: key.headers }));
    const share = await f.server.inject({ method: "POST", url: `/api/files/${file.code}/share`, headers: key.headers, payload: { expires_at: new Date(Date.now() + 60000).toISOString(), max_downloads: 2 } });
    schemaCheck(api, "/api/files/{code}/share", "post", share);
    const bytes = await f.server.inject({ url: `/api/files/${file.code}/download`, headers: key.headers });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe("schema bytes");
    expect(bytes.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(bytes.headers["cache-control"]).toBe("no-store");
    expect(bytes.headers.location).toBeUndefined();
    const byteContent = api.paths["/api/files/{code}/download"].get.responses["200"].content;
    expect(byteContent[String(bytes.headers["content-type"]).split(";")[0]] ?? byteContent["*/*"]).toBeDefined();
    schemaCheck(api, "/api/share-links/{id}", "delete", await f.server.inject({ method: "DELETE", url: `/api/share-links/${share.json().id}`, headers: key.headers }));
    schemaCheck(api, "/s/{token}", "get", await f.server.inject(new URL(share.json().public_url).pathname));
    const login = await f.server.inject({ method: "POST", url: "/api/auth/login", payload: { username: f.config.adminUsername, password: "synthetic-unused-fixture-password" } });
    schemaCheck(api, "/api/auth/login", "post", login);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const adminHeaders = { cookie, origin: f.config.publicBaseUrl };
    const createdKey = await f.server.inject({ method: "POST", url: "/api/admin/api-keys", headers: adminHeaders, payload: { name: "contract scoped key", can_upload: false, can_download: true, can_list: false } });
    schemaCheck(api, "/api/admin/api-keys", "post", createdKey);
    schemaCheck(api, "/api/admin/api-keys", "get", await f.server.inject({ url: "/api/admin/api-keys", headers: adminHeaders }));
    const keyId = createdKey.json().apiKey.id;
    schemaCheck(api, "/api/admin/api-keys/{id}", "patch", await f.server.inject({ method: "PATCH", url: `/api/admin/api-keys/${keyId}`, headers: adminHeaders, payload: { can_download: false } }));
    schemaCheck(api, "/api/admin/api-keys/{id}", "delete", await f.server.inject({ method: "DELETE", url: `/api/admin/api-keys/${keyId}`, headers: adminHeaders }));
    schemaCheck(api, "/api/files/{code}", "patch", await f.server.inject({ method: "PATCH", url: `/api/files/${file.code}`, headers: key.headers, payload: { durable: false } }));
    const status = await f.server.inject({ url: "/api/admin/storage-usage", headers: { cookie } });
    schemaCheck(api, "/api/admin/storage-usage", "get", status);
    expect(status.json().bytes).toBeGreaterThan(0);
    schemaCheck(api, "/api/files/{code}", "delete", await f.server.inject({ method: "DELETE", url: `/api/files/${file.code}`, headers: key.headers }));
    schemaCheck(api, "/api/auth/logout", "post", await f.server.inject({ method: "POST", url: "/api/auth/logout", headers: adminHeaders }));
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
    schemaCheck(api, "/api/files/{code}", "get", response);
  });
});
