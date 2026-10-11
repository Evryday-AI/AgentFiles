import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("reviewed static assets plugin", () => {
  let root: string;
  let server: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentfiles-static-"));
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "public asset");
    await writeFile(join(root, "secret.txt"), "outside-root-sentinel");
    server = Fastify({ logger: false });
    await server.register(fastifyStatic, { root: assets, prefix: "/assets/" });
  });

  afterEach(async () => {
    await server?.close();
    if (root) {
      expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
      expect(root.split(/[\\/]/).at(-1)).toMatch(/^agentfiles-static-/);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves a public asset with Fastify 5", async () => {
    const response = await server.inject("/assets/app.js");
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("public asset");
  });

  it.each([
    "/assets/../secret.txt",
    "/assets/%2e%2e/secret.txt",
    "/assets/%2e%2e%2fsecret.txt",
    "/assets/%2e%2e%5csecret.txt",
    "/assets/%252e%252e%252fsecret.txt",
  ])("does not disclose bytes outside the static root: %s", async (url) => {
    const response = await server.inject(url);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain("outside-root-sentinel");
  });

  it("rejects a differently cased alias on case-insensitive filesystems", async () => {
    const response = await server.inject("/assets/APP.JS");
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain("public asset");
  });
});
