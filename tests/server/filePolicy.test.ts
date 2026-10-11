import { describe, expect, it } from "vitest";
import { fileIsAvailable } from "../../src/server/filePolicy";
const at = new Date("2026-10-10T00:00:00Z");
const file = {
  isDurable: false,
  expiresAt: new Date(at.getTime() + 1),
  deletedAt: null,
  lifecycleState: "active" as const,
};
describe("shared file availability", () => {
  it.each([-1, 0, 1])("expiry offset %s milliseconds", (delta) =>
    expect(
      fileIsAvailable(
        { ...file, expiresAt: new Date(at.getTime() + delta) },
        at,
      ),
    ).toBe(delta > 0),
  );
  it.each([
    { expiresAt: null },
    { deletedAt: at },
    { lifecycleState: "deleting" as const },
    { lifecycleState: "deleted" as const },
  ])("fails closed %#", (overrides) =>
    expect(fileIsAvailable({ ...file, ...overrides }, at)).toBe(false),
  );
  it("durability never bypasses deletion state", () => {
    expect(
      fileIsAvailable({ ...file, isDurable: true, expiresAt: null }, at),
    ).toBe(true);
    expect(
      fileIsAvailable(
        { ...file, isDurable: true, lifecycleState: "deleting" },
        at,
      ),
    ).toBe(false);
  });
});
