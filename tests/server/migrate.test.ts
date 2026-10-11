import { describe, expect, it } from "vitest";
import { backfillInferredMimeTypes } from "../../src/server/migrate";
import type { Queryable } from "../../src/server/db";

class FakeQueryable implements Queryable {
  calls: Array<{ text: string; params: readonly unknown[] }> = [];

  async query<T>(text: string, params: readonly unknown[] = []) {
    this.calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
    return { rows: [] as T[], rowCount: 0 };
  }
}

describe("database migrations", () => {
  it("backfills octet-stream video rows from their filenames", async () => {
    const client = new FakeQueryable();

    await backfillInferredMimeTypes(client);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toContain("UPDATE files");
    expect(client.calls[0]?.text).toContain("mime_type = 'application/octet-stream'");
    expect(client.calls[0]?.text).toContain("'%.mp4'");
    expect(client.calls[0]?.text).toContain("'video/mp4'");
    expect(client.calls[0]?.text).toContain("'%.webm'");
    expect(client.calls[0]?.text).toContain("'video/webm'");
    expect(client.calls[0]?.text).toContain("'%.mov'");
    expect(client.calls[0]?.text).toContain("'video/quicktime'");
    expect(client.calls[0]?.text).toContain("updated_at = now()");
  });
});
