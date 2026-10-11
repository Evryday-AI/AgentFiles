import { describe, expect, it } from "vitest";
import { createFileCode } from "../../src/server/fileCodes";

describe("createFileCode", () => {
  it("creates short human-readable codes", () => {
    const code = createFileCode();
    expect(code).toMatch(/^F-[A-Z0-9]{5}$/);
  });

  it("does not use ambiguous lowercase letters", () => {
    const code = createFileCode();
    expect(code).not.toMatch(/[ilo]/);
  });
});
