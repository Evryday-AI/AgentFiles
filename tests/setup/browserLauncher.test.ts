import { expect, it } from "vitest";
import { sanitizeBrowserOutput } from "../../scripts/browser-output.mjs";
it("redacts raw key secrets, DB credentials, cookies and share paths before browser output", () => {
  const key = `af_${"a".repeat(24)}_${"b".repeat(64)}`;
  const raw = `DOM ${key}\nBearer ${key}\nCookie: session=synthetic\npostgres://synthetic:fixture@localhost:1234/test\nhttp://localhost/s/synthetic-public-token`;
  const output = sanitizeBrowserOutput(raw, []);
  expect(output).not.toContain(key);
  expect(output).not.toContain("session=synthetic");
  expect(output).not.toContain("synthetic:fixture");
  expect(output).not.toContain("synthetic-public-token");
});
