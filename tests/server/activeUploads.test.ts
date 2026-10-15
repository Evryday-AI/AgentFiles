import { describe, expect, it } from "vitest";
import { createActiveUploads } from "../../src/server/activeUploads";
describe("active upload paths", () => {
  it("holds references until all metadata or compensation work finishes", async () => {
    const active = createActiveUploads();
    const a = active.hold(".tmp/one"), b = active.hold(".tmp/one");
    let drained = false;
    const wait = active.drain().then(() => { drained = true; });
    a(); a();
    expect(active.has(".tmp/one")).toBe(true);
    expect(drained).toBe(false);
    b(); await wait;
    expect(active.has(".tmp/one")).toBe(false);
  });
});
