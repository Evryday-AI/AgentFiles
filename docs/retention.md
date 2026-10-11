# Retention and recovery

AgentFiles supports one app process and an exclusively app-owned storage volume. Phase C evidence covers real PostgreSQL, real synthetic files and deterministic fault injection. Actual process-kill, power-loss and release backup/restore acceptance remain E2.

## Separate retention boundaries

| Data | Retention and removal |
| --- | --- |
| Temporary file bytes | Default expiry is seven days. New metadata/download/share access stops at expiry, independently of cleanup. Physical removal follows a confirmed deletion claim. |
| Persistent file bytes | Only explicit authorized intent and `ALLOW_PERSISTENT_FILES=true` can remove expiry. Disabling persistence starts a new full default interval. An explicit manual DELETE can remove persistent files. |
| Uncommitted byte leftovers | Old regular files in the owned `.tmp` and `files` directories become eligible after `ORPHAN_GRACE_SECONDS` (24 hours by default). Recent files, active-path leases and metadata-owned paths survive. No recursive arbitrary-directory walk occurs. |
| Deleted file details and shares | Default `METADATA_RETENTION_DAYS=30` (validated range 1–3650 days). A deleted file is purged only after its owned paths are confirmed absent; shares/events referring to that file are removed transactionally. Old revoked or expired shares are separately eligible after that window. Active and pending-deletion file details are never generically age-purged. |
| Issued file codes | Permanent canonical code-only reservations. No filename, file ID, checksum, size, owner or timestamps remain in this registry. There is no purge/reuse knob. Database storage grows with lifetime issuance; monitor database capacity. The finite namespace can exhaust, returning `507 CODE_SPACE_EXHAUSTED`, and codes are never recycled. |
| Lifecycle events | Default `EVENT_RETENTION_DAYS=30` (validated range 1–3650 days). Safe fixed event types cover create, delete, expire, persistence, share and revoke, with bounded Boolean/UUID details; no content, password, raw token or actor name is recorded. Failed event writes do not undo confirmed operations; `event_failures` requires operator review and is process-local. There is no claim that every downloaded byte is audited. Share download counts represent admitted requests. |
| Administrator sessions | Expired sessions are purged at expiry, including revoked sessions once expired. A revoked but unexpired session can remain until its original expiry. |
| API key metadata | Retained; this release introduces no separate automatic key-metadata purge policy. Revocation still immediately prevents authentication. |
| App/proxy/container logs | Operator-managed bounded rotation; a maximum of 30 days is recommended. The app does not automatically purge external logs. Omit credentials, cookies, request bodies and raw public-link tokens from proxy logs. |
| Backups and recipient copies | Operator snapshot schedules and recipient control apply independently. Snapshots may retain expired bytes. File expiry does not erase backups or copies, retract admitted transfers, or promise forensic erasure. |

## Claim, remove, finalize

Cleanup and authorized retention changes arbitrate using the same PostgreSQL row lock. A successful keep commits while active and prevents a stale expiry candidate from deleting it. A committed deletion claim freezes byte identity and returns `409 FILE_DELETION_IN_PROGRESS` to a competing keep. Disabling persistence participates in the same arbitration. An expired unclaimed file cannot be resurrected.

Deletion commits the claim before unlink, releases the SQL lock before disk I/O, and marks `deleted` only after removal or confirmed absence. Manual DELETE and maintenance share the same coordinator. Unlink or database uncertainty retains an inaccessible durable claim. A failed/ambiguous claim commit permits no unlink without a fresh exact-claim ownership check; an ambiguous finalization needs fresh confirmation before success. A failed/ambiguous retention commit returns `503 FILE_RETENTION_PENDING` unless its exact mutation is verified.

`503 FILE_DELETION_PENDING` means retry/recovery is required. Authenticated DELETE retries the same claim. Once finalized, another DELETE returns 200 while metadata is retained; after purge it returns 404. Missing active bytes produce a controlled 500 on download: inspect the paired volume and restore verified original bytes, or explicitly DELETE that file to finalize confirmed absence. Never fabricate replacement content under an existing code. Do not clear claims or change storage keys to make a pending file active.

After database/schema and volume checks, startup immediately resumes pending work. Scheduled ticks serialize cleanup, reconciliation and purge; overlapping runs coalesce, and shutdown awaits the current job within the shared ten-second shutdown deadline. A tick attempts at most 1000 deletion candidates. Pending claims receive up to 500 attempts, leaving at least 500 for newly expired candidates; separate keyset cursors retain exact PostgreSQL timestamp text across ticks and advance past failures. A restart begins fresh sweeps. `last_success_at` advances only after a successful complete cleanup sweep.

Deleted-detail purge separately attempts at most 500 rows per tick in exact `(deleted_at,id)` order. Its process-local cursor advances past retained bytes and individual path failures so later absent-byte rows can be purged. Progress is published only after the page transaction commits; a failed or uncertain transaction retries that page. Administrator purge health exposes `complete`, cumulative `retained` and `failures` for the current sweep. Purge `last_success_at` advances only when the full sweep completes with no retained rows or failures. A completed sweep restarts on the next tick, and a process restart begins a fresh sweep. Permanent code reservations survive every purge.

Confirmed normal uploads and uploads recovered from uncertain allocation attempt the same safe `file.created` event. Repeated inserts are idempotent while that event is retained. Immediate recovery can return 201; deferred recovery follows the original 503 unknown-outcome response and releases byte protection only after ownership is resolved. Event insertion failure increments review health without undoing the confirmed file; there is no guaranteed event replay queue.

Under healthy database/disk conditions, eligible orphan reclamation requires the grace period plus a completed sweep/cadence. Failures can extend this indefinitely; the application does not promise a deletion deadline during outages. Temp/final hardlinks are measured once per inode; removing a temp alias never grants authority over another path.

## Volume identity and restore controls

An initial installation with no issued codes binds one UUID in `storage_volume_identity` to the root `.agentfiles-volume` marker. Startup refuses a missing or mismatched marker for an existing binding, including a fresh process pointed at an empty replacement volume. Destructive maintenance checks this association and also checks the process-local root device/inode identity. Restore the matching marker, storage bytes and database identity together. Do not copy a marker into an unverified empty mount to bypass the guard.

A nonempty database without an association is not automatically adopted. Keep the app stopped while an operator verifies the complete original storage volume and issuance history, then recovers the matching association from trusted installation evidence. A pre-004 experimental installation has no such evidence: its adoption requires an explicit offline operator review and pairing of the verified original volume, outside the automatic fresh-install workflow. No release upgrade/restore tool is promised by this phase.

Before restoring any snapshot, set `FILE_ISSUANCE_ENABLED=false`. Restore the complete `issued_file_codes` registry, including all codes issued after the snapshot, before setting it true and restarting. The setting is a validated Boolean and returns `503 FILE_ISSUANCE_DISABLED` before accepting upload bytes. The app cannot infer issuance history absent from an old snapshot. If later history cannot be recovered, keep issuance disabled; do not silently reuse earlier identities. The C3 test exports and restores a synthetic complete registry into a fresh migrated database; it is fixture evidence, not the Phase E backup workflow.

## Capacity and operator status

Storage admission reserves the configured maximum file size for each upload. Existing bytes, uncertain uploads and failed removals remain charged. Recounts replace totals after reservations settle, so retries cannot subtract the same deletion twice. Database/mount uncertainty does not authorize reclamation. At critical storage pressure, uploads return 507; resolve unhealthy pending work, expand the owned storage or explicitly remove authorized files. Temporary files never become permanent automatically.

The administrator storage endpoint retains `bytes` and adds measured managed bytes, reserved bytes, free disk, ceilings, active uploads, pending expired bytes, oldest pending time, per-job attempt/success timestamps, failed-file counts and event-write failures. Public health/readiness expose no storage state. Runtime health counters reset at restart; SQL deletion claims and issued codes persist. Monitor failures and stale successful-sweep timestamps, plus database capacity for permanent code history. See [configuration](configuration.md) and [API contract](api-contract.md).
