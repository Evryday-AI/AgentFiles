import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hash } from "argon2";
import { createIntegrationFixture } from "../helpers/integration";
const directory = process.env.AGENTFILES_BROWSER_FIXTURE_DIR;
const port = Number(process.env.AGENTFILES_BROWSER_PORT);
if (!directory || !/^\d+$/.test(process.env.AGENTFILES_BROWSER_PORT ?? ""))
  throw new Error("Explicit browser fixture directory/port required");
await mkdir(directory, { recursive: true });
const password = randomBytes(24).toString("hex");
const fixture = await createIntegrationFixture({
  port,
  publicBaseUrl: `http://127.0.0.1:${port}`,
  adminPasswordHash: await hash(password),
  allowPersistentFiles: false,
});
await writeFile(
  join(directory, "state.json"),
  JSON.stringify({
    databaseUrl: fixture.config.databaseUrl,
    storageRoot: fixture.storageRoot,
    password,
    directory,
  }),
  { mode: 0o600 },
);
const key = await fixture.createSyntheticKey([
  "can_upload",
  "can_download",
  "can_list",
  "can_share",
  "can_delete",
]);
const media: Array<{ name: string; type: string; args: string[] }> = [
  {
    name: "portrait.png",
    type: "image/png",
    args: ["-f", "lavfi", "-i", "color=c=blue:s=120x240", "-frames:v", "1"],
  },
  {
    name: "landscape.png",
    type: "image/png",
    args: ["-f", "lavfi", "-i", "color=c=orange:s=240x120", "-frames:v", "1"],
  },
  {
    name: "short.webm",
    type: "video/webm",
    args: [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=240x120:rate=12",
      "-t",
      "1",
      "-c:v",
      "libvpx",
      "-pix_fmt",
      "yuv420p",
    ],
  },
  {
    name: "tone.wav",
    type: "audio/wav",
    args: [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=22050",
      "-t",
      "1",
    ],
  },
];
const files: Array<Record<string, unknown>> = [];
try {
  await fixture.server.listen({ port, host: "127.0.0.1" });
  for (const item of media) {
    const path = join(directory, item.name);
    const generated = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", ...item.args, path],
      { windowsHide: true, encoding: "utf8" },
    );
    if (generated.status !== 0)
      throw new Error("Synthetic media generation failed");
    const bytes = await readFile(path);
    const body = new FormData();
    body.append("file", new Blob([bytes], { type: item.type }), item.name);
    const response = await fetch(fixture.config.publicBaseUrl + "/api/files", {
      method: "POST",
      headers: key.headers,
      body,
    });
    if (response.status !== 201)
      throw new Error("Synthetic HTTP upload failed");
    const file = (await response.json()) as Record<string, unknown>;
    files.push({
      ...file,
      fixture_path: path,
      expected_sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const target = files[0];
  // Independently generated newer rows make the HTTP-uploaded target fall beyond
  // the first 200. This avoids changing the production request throttle.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seededCodes = new Set(files.map((file) => file.code));
  await fixture.db.withClient(async (client) => {
    await client.query("BEGIN");
    for (let index = 0; index < 205; index++) {
      let code: string;
      do {
        code =
          "F-" +
          Array.from(
            randomBytes(5),
            (byte) => alphabet[byte % alphabet.length],
          ).join("");
      } while (seededCodes.has(code));
      seededCodes.add(code);
      const bytes = Buffer.from(`Synthetic pagination fixture ${index}\n`);
      const storageKey = "files/" + randomUUID() + ".txt";
      await writeFile(join(fixture.storageRoot, storageKey), bytes);
      await client.query("INSERT INTO issued_file_codes(code) VALUES($1)", [
        code,
      ]);
      await client.query(
        `INSERT INTO files(code,original_name,storage_key,mime_type,size_bytes,uploaded_by_type,uploaded_by_name,expires_at,sha256,created_at)
        VALUES($1,$2,$3,'text/plain',$4,'admin','synthetic browser fixture',now()+interval '7 days',$5,now()+interval '1 second')`,
        [
          code,
          `page-${index}.txt`,
          storageKey,
          bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
        ],
      );
    }
    await client.query("COMMIT");
  });
  await fixture.server.uploadRuntime.rescan();
  await writeFile(
    join(directory, "files.json"),
    JSON.stringify({ files, target }),
    { mode: 0o600 },
  );
  await writeFile(join(directory, "ready"), "ready");
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await fixture.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
} catch {
  await fixture.close();
  throw new Error("Independent browser fixture failed");
}
