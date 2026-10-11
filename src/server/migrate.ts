import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, query, type Queryable } from "./db.js";

const modulePath = fileURLToPath(import.meta.url);
const schemaPath = join(dirname(modulePath), "schema.sql");

const inferredMimeBackfillSql = `
  UPDATE files
  SET
    mime_type = CASE
      WHEN lower(original_name) LIKE '%.mp4' OR lower(original_name) LIKE '%.m4v'
        THEN 'video/mp4'
      WHEN lower(original_name) LIKE '%.mov'
        THEN 'video/quicktime'
      WHEN lower(original_name) LIKE '%.webm'
        THEN 'video/webm'
      WHEN lower(original_name) LIKE '%.ogg' OR lower(original_name) LIKE '%.ogv'
        THEN 'video/ogg'
      ELSE mime_type
    END,
    updated_at = now()
  WHERE mime_type = 'application/octet-stream'
    AND (
      lower(original_name) LIKE '%.mp4'
      OR lower(original_name) LIKE '%.m4v'
      OR lower(original_name) LIKE '%.mov'
      OR lower(original_name) LIKE '%.webm'
      OR lower(original_name) LIKE '%.ogg'
      OR lower(original_name) LIKE '%.ogv'
    )
`;

const defaultClient: Queryable = { query };

export async function migrate(client: Queryable = defaultClient) {
  const schema = await readFile(schemaPath, "utf8");
  await client.query(schema);
  await backfillInferredMimeTypes(client);
}

export async function backfillInferredMimeTypes(client: Queryable = defaultClient) {
  await client.query(inferredMimeBackfillSql);
}

if (process.argv[1] === modulePath) {
  migrate()
    .then(() => {
      console.info("Database schema migration complete.");
    })
    .catch((error: unknown) => {
      console.error("Database schema migration failed.");
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
