# Coordinated backup and isolated recovery

AgentFiles remains in preparation. E2 has local synthetic backup/restore evidence; this is not a production deployment or release acceptance claim. The recovery target is the current schema-4 runtime, one app process and one exclusively owned disk volume. Never restore just the database or just the bytes into an existing installation.

## Take a private snapshot

From the installation checkout, explicitly select its existing Compose project and an ignored private output directory:

```sh
node scripts/backup.mjs --project agentfiles --output ./backups
```

Requires host Node 24, installed dependencies and Docker access. The helper supports the default dedicated `db`/`app` Compose stack and plain local named volumes. It rejects unknown projects, extra services/writers, replicas, external/bind volumes, shared attachments, a running migration job, mismatched app database/storage configuration and a failed shutdown drain. The external-database alternative needs a separately reviewed database-operator procedure.

Exclude external writers, schedulers and direct SQL maintenance, and prevent Compose/watch/supervisor commands from restarting the app during backup. Docker labels identify selected resources; they cannot prove that no other process has database credentials. The helper stops the app with the 15-second grace, requires exit zero, and rechecks stopped state around the dump/archive. App shutdown drains requests and in-process maintenance. An external maintenance service in this topology is refused.

While stopped, it runs a complete custom-format `pg_dump` of the selected dedicated database, including permanent `issued_file_codes`, pending claims, shares, keys, sessions and the immutable migration ledger. It archives exactly the selected storage named volume read-only as UID 1000, including `.agentfiles-volume`. No host mount traversal or generic pruning occurs. It records exact local app image identity, migration checksums, volume identity, safe counts, SHA-256 checksums, a code-only export and configuration recovery guidance. Large dump/archive hashes stream from disk; Docker streams have a 30-minute bound. Registry/SQL inspection is bounded at 16 MiB and fails rather than truncating; exceptionally large registries need a separately reviewed streaming procedure.

Previously running apps resume in `finally`, including a failed archive; already stopped apps stay stopped. A backup is usable only with a complete `manifest.json` and verified checksums. An interrupted run without that manifest is incomplete. If the host/helper is killed, `finally` cannot execute: inspect the selected app, preserve incomplete output privately, establish DB/volume consistency and explicitly start the same app when safe. Never print expanded configuration or dump contents to diagnose it.

## Protect snapshots and configuration

Output is runtime data, excluded from source exports and releases. Restrict access, use authenticated encryption and preserve encryption keys separately. POSIX files use mode 0600/directories 0700; Windows operators must enforce equivalent private NTFS ACLs. SHA-256 detects corruption; it does not authenticate a maliciously replaced manifest.

Private `.env` is not copied automatically. Securely preserve the matching administrator hash, installation policy, DB/storage configuration and encryption recovery material separately. Record the snapshot's reviewed app revision/image. Never put values into public reports. Snapshots contain key/session/share metadata and potentially expired content; maintain an explicit encrypted snapshot schedule/expiry policy. App cleanup cannot erase backups or recipient copies.

## Restore offline to new owned volumes

1. Block public traffic and every writer. Select a new project and fresh named DB/storage volumes. Generate new DB credentials and `SESSION_SECRET` through setup, then privately recover the intended administrator hash and policy. Set `FILE_ISSUANCE_ENABLED='false'` before app startup.
2. Verify checksums and expected app/schema version; use the matched app image/revision. Restore `database.dump` with `pg_restore --exit-on-error --no-owner --no-acl` into the fresh dedicated database. Extract `storage.tar.gz` only into the fresh owned storage volume as UID 1000. Authenticate the snapshot and inspect inventory before extraction; never use an arbitrary untrusted archive.
3. Verify metadata against byte size/SHA-256, `.agentfiles-volume` against `storage_volume_identity`, ownership/mode, canonical reservations, pending claims and immutable ledger. Run a fresh `docker compose run --rm migrate`. Corrupt ledgers/mismatched markers stop recovery; never alter migrations, fabricate bytes or reset claims.
4. Revoke restored sessions (`DELETE FROM admin_sessions` offline) and preserve the new session secret. An older snapshot can revive API keys/public links revoked after its boundary, even without backup compromise. Recover proven later revocations, or conservatively revoke all restored API keys and shares offline (`UPDATE api_keys SET revoked_at=now(); UPDATE share_links SET revoked_at=now();`) and reissue intended access after recovery. Rotate administrator/database credentials and encryption keys after possible exposure. Changing only `SESSION_SECRET` does not revoke API keys/public links.
5. Start privately with issuance disabled. Startup attempts pending-claim recovery and an initial maintenance tick; readiness proves database/schema availability, not completion/success of every cleanup sweep. Expired files deny access while bytes remain. Check authenticated cleanup/reconciliation counters, pending claims/expired bytes and last successful sweep, and resolve outstanding work before public traffic. Large backlogs can require multiple ticks. Confirm authentication, known hashes and capacity. Recovery never promotes expired/claimed files to permanent storage.

These are operator procedure requirements. `node scripts/restore-smoke.mjs` is a synthetic acceptance runner, **not** an operator snapshot restoration tool. It accepts no live target/path, creates random fixture projects, verifies coordinated snapshots, restores DB/bytes, checks auth/expiry/claims and cleans only registered disposable volumes. Its current-schema restore and experimental rollback checks use public source, Docker, Node 24 and installed dependencies.

## Recover every later-issued code before uploads

An old snapshot reserves codes only through its boundary. File metadata is insufficient: later codes may already have all details purged. Reserve **every** code committed after that snapshot as well.

For the **final cutover registry**, explicitly stop the surviving current app first, then take the coordinated snapshot from its checkout:

```sh
docker compose --project-name agentfiles stop app
node scripts/backup.mjs --project agentfiles --output ./backups
```

Because the app was already stopped, the helper leaves it stopped. Keep this source app, external SQL writers, maintenance/schedulers and restart supervisors stopped throughout registry export, union and cutover. An ordinary backup of a running app resumes it in `finally` and can create a later-issuance coverage gap; it is not a final cutover boundary. Alternatively obtain independently preserved complete code-only evidence covering the last committed issuance with the same no-later-writes guarantee.

Preserve the boundary record (installation UUID, stopped app identity, app image, database snapshot, export time) and a private operator decision establishing this is surviving complete history and no later writes occurred. Time, row count, file list or PostgreSQL transaction snapshot alone cannot prove completeness. The boundary labels the export; the operator establishes its coverage with surviving evidence and control of writers.

With recovered app stopped/issuance disabled, validate canonical `F-` codes and matching installation UUID. Transactionally lock `issued_file_codes` and insert the union with `ON CONFLICT DO NOTHING`; never delete restored reservations. `mergeRecoveryRegistry` in `scripts/backup.mjs` merges with an explicit coverage attestation and matching UUID. It never edits configuration/enables uploads. Preserve evidence/attestation privately. After complete coverage is established, permanently retire the old writer while still stopped, then explicitly enable recovered current-runtime issuance and open traffic. Never restart the old writer without a new complete registry reconciliation and coordinated cutover.

If the surviving registry or independent complete later evidence is lost, recovery is **incomplete**. Leave `FILE_ISSUANCE_ENABLED='false'`; verified authorized reads may proceed, uploads remain disabled. Never infer safety from snapshot age, plausible counts, active files or an allocation that happened not to collide. Lost reservation history cannot be reconstructed from file metadata.

Smoke observes `503 FILE_ISSUANCE_DISABLED` on an old restore without evidence, then merges the controlled current registry including a later issued-and-purged code before explicit enablement. Integration forces allocator collision with that reservation and proves the old lookup remains unavailable. Pre-registry experimental revisions cannot enforce this gate and must not resume issuance; see [upgrading](upgrading.md).
