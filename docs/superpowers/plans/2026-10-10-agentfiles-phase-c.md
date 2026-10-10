# AgentFiles phase C implementation plan: authorization and bounded file lifecycle

> **For agentic workers:** Use `executing-plans` after B review. Add meaningful failing regressions before changes; do not use source runtime data.

**Goal:** Prove authentication, expiry, concurrent capacity and crash cleanup on a real isolated database/filesystem.

**Architecture:** Keep existing HTTP handlers and injectable repositories. One app process owns upload admission/active-path leases and serialized maintenance. Opaque storage keys decouple file-code collisions from byte placement; staged streams finalize only after complete request validation. SQL and disk cannot share a transaction, so failure recovery is explicit.

**Tech Stack:** Fastify, Zod, Postgres transactions, Node streaming/crypto/fs statfs, Vitest real integration fixtures.

## Global constraints

All [master constraints/interfaces](2026-10-10-agentfiles-open-source.md) apply. Temporary files are never silently persistent. One process/mount only; external writers/replicas unsupported. Uploaded names, MIME and contents are untrusted; no server-side scraping/execution/transcoding or forensic-erasure promises.

## C1: fail-closed auth/lifecycle policy, input validation and logging

**Files:** Modify `src/server/auth.ts`, `adminRoutes.ts`, `filesRoutes.ts`, `filesRepo.ts`, `shareRoutes.ts`, `index.ts`; create `src/server/requestPolicy.ts`, `src/server/logging.ts`, `src/server/filePolicy.ts`, `tests/server/requestPolicy.test.ts`, `tests/server/logging.test.ts`, `tests/integration/authorization.test.ts`; extend existing auth/admin/files/share tests. Modify `docs/api-contract.md`, `docs/configuration.md` and draft skill for final persistence errors.

**Interfaces:** `fileIsAvailable({isDurable,expiresAt,deletedAt}, now): boolean` is shared by private/share checks. Mutating cookie requests require same-origin policy; bearer-only requests work without Origin if no cookie-authorized fallback. Existing `{error}` adds stable optional codes (`INVALID_INPUT`, `PERSISTENCE_DISABLED`, `PERMISSION_DENIED`). API key requests cannot use browser cookie authority accidentally when an explicit invalid Bearer token was supplied. Define and test precedence before changing `resolvePrincipal`.

- [ ] Add failing tests at exactly expiry==now, one millisecond before/after, deleted row and non-durable null expiry; assert metadata/private download/share unavailable and never stream bytes. Null-expiry policy helper is complete:

```ts
export function fileIsAvailable(
  file: { isDurable: boolean; expiresAt: Date | null; deletedAt: Date | null }, now: Date,
): boolean {
  return file.deletedAt === null &&
    (file.isDurable || (file.expiresAt !== null && file.expiresAt.getTime() > now.getTime()));
}
```

Apply the same predicate in SQL (`deleted_at IS NULL AND (is_durable OR expires_at > $time)`), not the old nullable-expiry OR. B3's lifecycle migration enforces non-durable expiry; no silent data promotion.
- [ ] Write real authorization matrix tests for anonymous, upload-only, download-only, list-only, delete/share/persistence keys, revoked/malformed key, expired/revoked session, and admin. Assert DB/disk remain unchanged on denial. Include invalid Bearer + valid admin cookie precedence; choose explicit Bearer as the sole authority when present to avoid permission confusion. All independent install keys are global within that instance; no file-owner tenancy checks are implied.
- [ ] Upload/patch `durable=true` returns 403 if either installation policy or principal permission forbids it; malformed values return 400. Keep “false restores default expiry” behavior. Multipart durable can arrive after the file, so defer policy decision until all parts validated in C2.
- [ ] Validate route params, UUID key/share IDs, code pattern, key name ≤128 bytes, filename ≤1024 bytes/no NUL, ISO share expiry, integer max_downloads (1–2147483647) and strict boolean flags. Reject unknown/invalid mutation fields instead of silently ignoring them. No secret key/hash fields may be patched. Query limit/offset valid ranges are explicit; preserve documented defaults and old aliases, with controlled 400 for malformed input.
- [ ] Add cookie mutation defenses to login, logout, upload, patch, delete, key and share routes: reject mismatched Origin and `Sec-Fetch-Site: cross-site`; browser multipart writes require matching configured origin. Same-origin JSON may also check Origin when present. Requests without browser Origin/Fetch metadata need explicit same-origin policy for cookie authority; generic bearer API clients need no browser headers. Login without Origin supports non-browser clients but must reject cross-site Fetch metadata/form content-types. Document any deliberate exceptions and test them.
- [ ] Limit pre-auth body/header sizes and authentication work. Keep login five/minute/IP, add upload 30/minute/principal after auth, auth resolution 120/minute/IP before Argon2, share downloads 120/minute/IP. Use `@fastify/rate-limit` integration; configure after trusted proxy policy so spoofed forwarded headers cannot bypass. Return 429 plus Retry-After. Use connection/request timeout and bounded multipart idle time; limit tests must prove slow/aborted request releases work in C2.
- [ ] Add explicit request/error serializers: redact authorization/cookie/set-cookie, passwords/session/hash/key/secret fields; serialize route templates instead of raw `/s/:token` URLs/query; suppress raw error paths/DB connection strings. Tests capture actual Pino JSON for successful share and failed auth/storage requests with synthetic sentinel values and assert no sentinel escapes. Never log request/response bodies by default.
- [ ] Add `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` to authenticated metadata/download/key/session/share responses; `Referrer-Policy: no-referrer` for app and bearer downloads. Downloads stay attachment; do not render HTML/SVG as executable same-origin documents. Harden app CSP to own assets/media with the existing inline React style usage consciously handled; verify preview/dialog before tightening.

**Representative integration regression:**

```ts
it("a short code does not authorize private bytes", async () => {
  const f = await createIntegrationFixture();
  try {
    const file = await f.uploadSynthetic({ text: "hello", permissions: "upload" });
    const r = await f.server.inject({ url: `/api/files/${file.code}/download` });
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain("hello");
  } finally { await f.close(); }
});
```

Extend B3's fixture with `uploadSynthetic({text,permissions}): Promise<FileItem>` that creates named synthetic keys via the independent DB, authenticates through actual Bearer handling, builds multipart bytes, and returns real DTO. It must not bypass route authorization to produce verification evidence.

**Commands:** `npm test -- tests/server`; `npm run test:integration -- tests/integration/authorization.test.ts`; `npm run typecheck`; `npm run build`. Expected focused new regressions fail first; after changes all matrix cases match statuses and no forbidden write/stream or log sentinel occurs.

**Acceptance/commit:** Authentication/expiry/input/log behavior demonstrated at exact boundaries using real keys/SQL; explicit persistence intent respected. `fix: enforce standalone authorization and temporary-file invariants`.

## C2: stage uploads, enforce byte/capacity/concurrency and compensate failure

**Files:** Modify `src/server/storage.ts`, `filesRoutes.ts`, `filesRepo.ts`, `index.ts`; create `src/server/uploadAdmission.ts`, `src/server/activeUploads.ts`, `tests/server/uploadAdmission.test.ts`, `tests/server/activeUploads.test.ts`, `tests/integration/uploads.test.ts`; extend storage/files-route tests; update `docs/api-contract.md`, `docs/configuration.md`.

**Interfaces:**

```ts
export interface StagedUpload {
  tempKey: string; sizeBytes: number; sha256: string; extension: string;
}
export interface UploadLease {
  commit(actualBytes: number): Promise<void>;
  abort(retainedBytes: number): Promise<void>;
}
// uploadAdmission.ts: createUploadAdmission(config, initialManagedBytes, freeDiskBytes)
// -> { acquire(): Promise<UploadLease>, snapshot(): { managedBytes: number; reservedBytes: number; active: number } }
// storage.ts: stageUpload(input: SaveUploadInput & { maxBytes: number }): Promise<StagedUpload>
// storage.ts: finalizeUpload(root: string, staged: StagedUpload): Promise<SavedUpload>
// storage.ts: discardUpload(root: string, key: string): Promise<void>
// activeUploads.ts: createActiveUploads() -> { hold(key): () => void, has(key): boolean, drain(): Promise<void> }
```

Finalize generates an opaque random UUID under `files/<uuid><safeExtension>`, independent of F-code. Link with exclusive atomic no-overwrite behavior on the app-owned local volume, then remove temp name. No final key/filename controls filesystem traversal. Leases/active paths remain held through metadata commit or compensation, not just byte streaming.

- [ ] Write size tests limit-1/exact/+1 with multiple streamed chunks, chunked transfer with no Content-Length, lying header, extra parts/fields, hostile filename/MIME, parser-truncated last chunk, abort/slow timeout, oversized field and second file. Assert no metadata/final/temp leftovers except deliberately injected deletion failure (then charged and observable). Explicitly inspect `part.file.truncated` after complete parsing; do not return 201 for a truncated file.
- [ ] Add collision/crash-window tests: stage succeeds + parser fails; durable denied after file; hardlink fails; metadata insert fails; code collision retries; temp unlink fails after final link; compensation deletion fails; process stops between final link and metadata. Previously stored bytes must survive collision and unrelated file errors.
- [ ] Implement stream meter without whole-file buffering. This complete Transform belongs in `stageUpload`; create temp with `wx`, private permissions, sanitize only extension, SHA-256 as streamed:

```ts
const meter = new Transform({
  transform(chunk: Buffer | string, _encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (sizeBytes + bytes.length > input.maxBytes) {
      const error = Object.assign(new Error("Upload exceeds configured limit"), { statusCode: 413, code: "UPLOAD_TOO_LARGE" });
      callback(error); return;
    }
    sizeBytes += bytes.length; hash.update(bytes); callback(null, bytes);
  },
});
```

`sizeBytes=0`, `hash=createHash('sha256')`, input validation and pipeline/temp cleanup are defined in the enclosing stageUpload; validate maxBytes at config startup. Return StagedUpload only; finalization waits for exactly one complete validated multipart request. Config replaces both hardcoded parser limit uses, retaining 20 fields/4KiB/25 parts unless changed deliberately.
- [ ] Admission runs in one serialized critical section. Reserve **maxUploadBytes**, not attacker Content-Length, before accepting stream; reject active>=configured slots as 429 `UPLOAD_CONCURRENCY_LIMIT` Retry-After 1; reject managed+reserved+maxUploadBytes>ceiling or availableFree-reserved-maxUploadBytes<reserve as 507 `STORAGE_CAPACITY_EXCEEDED`. Conservative admission may reject a small upload without worst-case headroom; document this. Periodically recheck statfs in stream checkpoints to fail cleanly on external disk use/ENOSPC; no physical guarantee against privileged external writers.
- [ ] Commit converts reservation to actual stored byte count; abort releases reservation but charges any bytes cleanup failed to remove. A restart remeasures actual managed storage including `.tmp` and orphans before readiness/admission. All counter mutations use one lock; startup/maintenance rescans must not subtract active reserved bytes twice. Maintenance byte removal informs the same admission object. A failed disk measurement rejects admission safely.
- [ ] Admission test injects deterministic async free-disk provider and pauses two requests at a barrier: ceiling150, file cap100, two100 reservations => exactly one admitted; after successful10-byte commit another can be admitted; stalled4 slots reject fifth, abort releases; failure retaining10 bytes stays charged; unexpected filesystem changes cannot turn a failed scan into unlimited space.
- [ ] Fix storage key handling: reject empty/root-equal/dot/absolute/outside-root key; validate each existing ancestor with lstat/realpath and reject symlinks/reparse points; app exclusively owns mount. Opening files uses no-follow where available, validates regular files; never recursively delete a supplied path. Test malicious symlink fixtures on supported platforms, record unavailable OS capabilities. Lexical containment is still checked before any operation.
- [ ] Generate code after final key allocation and use repository collision retries without rewinding an uploaded stream. Return 201 only after metadata success. On each earlier failure remove owned temp/final bytes; do not delete a conflicting pre-existing path. Preserve original error if compensation also fails, expose cleanup failure privately to admin, never raw paths. No silent persistence or automatic POST retry.

**Commands:** `npm test -- tests/server/storage.test.ts tests/server/filesRoutes.test.ts tests/server/uploadAdmission.test.ts tests/server/activeUploads.test.ts`; `npm run test:integration -- tests/integration/uploads.test.ts`; full unit/typecheck/build once. Expected actual concurrent DB/disk cases, no buffered-file shortcut, exact-byte boundary enforcement and stable errors.

**Acceptance/commit:** Size and worst-case admission hold across concurrency/abort/metadata failure; final bytes are never published from incomplete/denied requests; no overwrite, orphan failures remain charged/visible. `fix: bound streamed uploads and finalize after request validation`.

## C3: fair cleanup, crash reconciliation, maintenance status and retention

**Files:** Modify `src/server/cleanup.ts`, `filesRepo.ts`, `adminRoutes.ts`, `events.ts`, `index.ts`, `storage.ts`; create `src/server/reconciliation.ts`, `maintenanceState.ts`, `src/server/migrations/003_maintenance.sql`, `tests/server/reconciliation.test.ts`, `tests/integration/fileLifecycle.test.ts`, `tests/integration/maintenance.test.ts`, `docs/retention.md`, `docs/verification/phase-c.md`; extend cleanup/files/share tests and build migration expected version to 3.

**Interfaces:** `findExpiredBatch({now,after?,limit},db): Promise<FileRecord[]>` uses ascending `(expires_at,id)` keyset and no offset through mutating data. `cleanupExpiredFiles({storageRoot,db,batchSize,activeUploads,maintenanceState,...})` returns existing deleted/failed/failures plus attempted/pendingBytes. `reconcileStorage({root,db,activeUploads,graceMs,now}): Promise<{removedBytes:number,failures:number}>`. Same single-process lock prevents overlapping cleanup/reconciliation. Admin status keeps source `bytes` alias.

```ts
export interface MaintenanceSnapshot {
  bytes: number; managed_bytes: number; reserved_bytes: number; free_disk_bytes: number;
  max_storage_bytes: number; min_free_disk_bytes: number; active_uploads: number;
  cleanup: { last_attempt_at: string | null; last_success_at: string | null;
    pending_expired_bytes: number; failed_files: number; oldest_pending_at: string | null };
}
```

- [ ] Add real file lifecycle tests: expired private metadata/download/share denied before cleanup; delete actual bytes then metadata; EACCES/injected failure leaves metadata unmarked and retry succeeds; already-missing bytes retry succeeds; DB mark failure after byte removal retries and remains visible. Durable files survive; removing persistence sets expiry explicitly. Test 501 expired files with permanent first-page failures: later files still removed within a complete keyset sweep.
- [ ] Implement startup maintenance immediately after DB/mount checks and periodic scheduler from validated config. Process bounded batches, persist sweep cursor in memory across ticks if per-tick maximum (1000 attempts) is reached, advance past failures, reset only after full sweep completes. No default listFiles limit100 as cleanup query. Single-process lock/coalescing plus stop awaits in-flight job; next restart safely begins a new sweep.
- [ ] Delete bytes first with exact contained path, mark deleted_at/reason (`expired`/`manual`) only after successful/no-longer-present byte removal. DB update failure cannot restore bytes: publish pending failure, retry. Manual delete remains repeat-safe; missing active bytes yield controlled500 and admin repair visibility, not made-up file content. Never release managed-capacity accounting before physical removal succeeds.
- [ ] Reconcile only owned root: old `.tmp` entries and opaque final files with no matching metadata, after grace, absent active-path lease. A fresh/recent final file and any in-flight upload survive. Verify root/mount identity before scan; skip symlink/nonregular entries and report failure rather than traverse. No arbitrary filesystem walk. DB lookup failure blocks orphan removal, never assumes every file orphaned. Temp hardlink duplicates must not be counted as independent permanent files for deletion authority.
- [ ] Test simulated crash stages with synthetic temp/final files and fake clock: just before/at grace boundary, active old upload, recent post-link/pre-metadata orphan, DB outage, missing root/mount, symlink bait, success second run. Actual subprocess kill is tested in E2; fixture simulation alone is not crash-process evidence. Safe reclamation bound is grace plus completed sweep/cadence under healthy disk/DB, not guaranteed while failures persist.
- [ ] 003 adds maintenance event indexes if needed and records safe minimal lifecycle events (create/delete/expire/durable/share/revoke; never raw tokens/passwords/contents). Define `recordEvent(input,db)` in events.ts, fixed event types/actor/file IDs plus bounded safe details. Event-write failure must not corrupt confirmed byte/metadata operations; record health failure for retry/review. Do not advertise every downloaded byte audited; share count counts admitted requests.
- [ ] Purge events older than configured event retention, expired/revoked sessions after expiry, revoked/expired shares after metadata window, deleted files after metadata window **only when owned bytes absence is confirmed**, then inactive/revoked API key metadata if a separately documented retention choice is introduced. No active files/keys are purged by a generic age query. Purge references transactionally; preserve constraints and adjust readiness version.
- [ ] Admin status derives actual managed bytes (including leftovers), reservations, disk reserve, pending expired bytes, last attempt/success and failures. Store timestamps per maintenance job; last_success advances only after a successful full sweep. Public health/instance endpoints disclose no storage state. UI consumes the new fields in D2, respecting source `bytes`.
- [ ] Document retention for bytes, metadata, events, sessions, logs and backups separately. Logs are operator-managed bounded rotation (recommended 30-day maximum), not auto-purged by app. External backup snapshots and recipient copies may outlive expiry; no forensic erasure/backup deletion promise. Define missing-byte repair/manual retry and critical full-storage behavior.

**Commands:** `npm test -- tests/server/cleanup.test.ts tests/server/reconciliation.test.ts`; `npm run test:integration -- tests/integration/fileLifecycle.test.ts tests/integration/maintenance.test.ts`; `npm run typecheck`; `npm run build`; `node scripts/smoke-compose.mjs`. Expected actual bytes absent, metadata marking/purge ordering correct, no active/recent upload loss, failing prefix cannot starve later batches.

**Acceptance/commit:** Expiry denies new access immediately; fair serialized cleanup/reconciliation and bounded retention demonstrated; failures and actual capacity visible, restart recount correct. `feat: reconcile abandoned files and expose retention maintenance health`.

## Phase checkpoint

Present exact boundary/race/crash-simulation tests, real PG/filesystem results, capacity model/single-process limitation, retention guarantees and untested crash/OS cases. Review before agent/browser verification; do not reduce acceptance to mocked SQL assertions.
