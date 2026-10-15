import { describe, expect, it } from "vitest";
import { parsePublicOrigin } from "../../src/server/originPolicy";

describe("parsePublicOrigin", () => {
  it.each(["http://localhost:3000/", "http://127.0.0.2:3000/", "http://[::1]:3000/", "http://[::ffff:127.0.0.1]:3000/"])("allows loopback HTTP: %s", (origin) => {
    expect(parsePublicOrigin(origin, "local")).toBe(new URL(origin).origin);
  });
  it("normalizes hostname, default port and trailing slash", () => {
    expect(parsePublicOrigin("https://FILES.example:443/", "public")).toBe("https://files.example");
  });
  it("does not confuse a private LAN address with loopback", () => {
    expect(parsePublicOrigin("https://192.168.1.2", "public")).toBe("https://192.168.1.2");
    expect(() => parsePublicOrigin("http://192.168.1.2", "local")).toThrow(/PUBLIC_BASE_URL/);
  });
  it.each(["https://localhost.", "https://127.1", "https://2130706433", "https://[::ffff:7f00:1]", "https://files.example?", "https://files.example#", "https://@files.example", "https://files.example/../", "https://files.example\\", " https://files.example", "https://files.example\n", "https://files.example//"])("rejects ambiguous or loopback public origins: %s", (origin) => {
    expect(() => parsePublicOrigin(origin, "public")).toThrow(/PUBLIC_BASE_URL/);
  });
  it("redacts rejected origins", () => {
    expect(() => parsePublicOrigin("https://synthetic-user:synthetic-secret@files.example", "public")).toThrow("PUBLIC_BASE_URL must be an origin allowed by DEPLOYMENT_MODE");
  });
});
