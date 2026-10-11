# Source-derived HTTP contract

**Source contract; full generic-client verification remains D1.** This inventory describes `src/server/adminRoutes.ts`, `filesRoutes.ts`, `shareRoutes.ts`, and their DTO/auth helpers. It preserves unversioned routes and aliases. C1 exercises real local SQL, authenticated HTTP routes and browser compatibility; this contract alone is not verification evidence or an installable-release claim. It is not OpenAPI; clean-install and deployed behavior need their own evidence.

## Authentication and permissions

Send `Authorization: Bearer <AGENTFILES_API_KEY>` only to the configured origin. A new standalone key has format `af_<24 lowercase hex lookup characters>_<64 lowercase hex secret characters>`. The signed administrator cookie is named `agentfiles_admin`. Browser administration uses that cookie; generic agent examples use only the header and never send cookies. An explicit Authorization header selects API-key authority exclusively: malformed, revoked or invalid Bearer credentials cannot fall back to an administrator cookie. Keep agent connection checks cookie-free. Independent keys are global within their installation; there are no file-owner tenancy checks.

`GET /api/auth/session` returns 200 with either `{"authenticated": false, "principal": null}` or `{"authenticated": true, "principal": ...}`. An administrator principal is `{type: "admin", name}`. An API-key principal is `{type: "api_key", id, name, canUpload, canDownload, canList, canDelete, canMarkDurable, canShare}`. Check authentication, type, and the actual booleans. Key creation/update fields and internal permission names are snake_case; session/public key flags are camelCase.

| Method and path | Permission | Success |
|---|---|---|
| `POST /api/files` | `can_upload` | 201, flat File DTO |
| `GET /api/files` | `can_list` | 200, `{files: File[]}` |
| `GET /api/files/:code` | `can_download` | 200, flat File DTO |
| `GET /api/files/:code/download` | `can_download` | 200, attachment byte stream |
| `PATCH /api/files/:code` | `can_mark_durable` | 200, flat File DTO |
| `DELETE /api/files/:code` | `can_delete` | 200, `{deleted: true, code}` |
| `POST /api/files/:code/share` | `can_share` | 201, Share DTO |
| `DELETE /api/share-links/:id` | `can_share` | 200, `{revoked: true, id}` |
| `GET /s/:token` | Bearer public link | 200, attachment byte stream |

File/share operations return 401 when no principal is resolved and 403 for an insufficient principal permission. Administrator principals have all permissions. Codes are instance-local identifiers requiring authentication; they are not bearer secrets. The browser routes `/` and `/files/:code` deliver a public HTML shell; metadata and bytes still require login.

## File requests and response

Upload uses multipart/form-data with one `file` part. Omit the optional `durable` field for ordinary temporary storage. Form booleans accept `true`/`1`/`on` or `false`/`0`/`off`. MAX_UPLOAD_BYTES controls the per-file size (1 GiB default), with one file, 20 fields, 4 KiB per field and 25 total parts. Only file and the optional durable field are accepted; unknown or duplicate fields and malformed booleans return 400. Filenames must be nonempty, at most 1024 UTF-8 bytes and contain no NUL. A stream meter accepts the exact byte limit and rejects excess bytes, independently of Content-Length. Bytes stay temporary until the complete multipart request and persistence intent pass validation; parser truncation cannot return 201.

Admission reserves MAX_UPLOAD_BYTES before streaming and holds the slot through confirmed metadata commit or compensation. A small file can be rejected when its worst-case reservation cannot fit the managed ceiling or free-disk reserve. Slots return 429 UPLOAD_CONCURRENCY_LIMIT with Retry-After: 1; unavailable capacity returns 507 STORAGE_CAPACITY_EXCEEDED. Failed compensation bytes remain charged. A 30-second idle upload returns 408 UPLOAD_IDLE_TIMEOUT and closes the connection. An unresolved database commit returns 503 UPLOAD_OUTCOME_UNKNOWN, protecting bytes and its reservation until ownership reconciliation; never automatically retry POST.

`GET /api/files` accepts `limit`, `offset`, and `durable` query parameters. Default limit is 100 (accepted range 1-500), and default offset is zero (accepted range 0-2147483647). Decimal integer query values are strict; malformed/out-of-range values and unknown parameters return 400. `durable` preserves the form boolean aliases above. Lists include only active, non-deleted, unexpired rows. For reconciliation, pagination is necessary and a mutable list is not a snapshot.

`PATCH /api/files/:code` accepts JSON `{"durable": true}` or `{"durable": false}`. True removes expiry; false starts a new default retention interval. Persistence intent requires can_mark_durable and installation ALLOW_PERSISTENT_FILES=true on upload and PATCH; a denial returns 403 with PERMISSION_DENIED or PERSISTENCE_DISABLED. Values in JSON must be booleans; unknown fields return 400 INVALID_INPUT. PATCH locks the file row, rechecks authority, policy and availability, then commits the change. Claimed deletion returns 409 FILE_DELETION_IN_PROGRESS; missing/deleted returns 404 and expired unclaimed files return 410. A failed or ambiguous commit returns controlled failure; reconcile before repeating.

The File DTO is flat and contains all of these fields:

| Field | Type and meaning |
|---|---|
| `code` | String, `F-` plus five characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` |
| `name` | Original upload filename; untrusted |
| `mime_type` | String, untrusted media type |
| `size`, `size_bytes` | Equal numeric byte counts |
| `created_at`, `updated_at` | ISO timestamp strings |
| `expiry`, `expires_at` | Equal ISO timestamps, or null |
| `durable`, `is_durable` | Equal booleans |
| `sha256` | SHA-256 hex digest, or null |
| `private_url` | Configured-origin `/files/:code`; administrator browser login required |
| `api_download_url` | Configured-origin `/api/files/:code/download`; header/cookie auth required |
| `uploaded_by` | `{type: "admin" | "api_key", name: string | null}` |
| `metadata` | Object; untrusted |

The configured `publicBaseUrl` constructs returned URLs. Clients must normalize/validate their configured origin and independently validate returned URLs before transmitting a key; the response cannot authorize a new credential destination. Reject redirects and URL credentials, query/fragment components, and origin lookalikes. Treat Content-Disposition and remote filenames as data, create new local files exclusively, hash streams, and never execute downloads.

For handoffs, record instance origin, code, creation time, and checksum in addition to the concise summary. Codes are allocated atomically with permanent code-only reservations and never reassigned after metadata purge. Random collisions retry up to 32 candidates without replaying file bytes. Retry exhaustion returns 503 `CODE_ALLOCATION_RETRY_EXHAUSTED`; proven complete namespace exhaustion returns 507 `CODE_SPACE_EXHAUSTED`. Byte paths use independent opaque random keys. Migration cannot recover unknown historical purged codes; complete issuance history must be preserved on restore.

## Shares and explicit mutation intent

Create a share only with explicit requester intent. JSON requires `expires_at` as a future ISO date; it must not exceed a temporary file's expiry. Optional `max_downloads` is a JSON integer from 1 through 2147483647, or null. The server also accepts `expiresAt` and `maxDownloads` request aliases. Use the documented snake_case names in new clients. Invalid ISO dates, conflicting aliases and unknown fields return 400 INVALID_INPUT; key/share IDs are validated UUIDs.

The Share DTO is `{id, file_code, public_url, expires_at, max_downloads, download_count, revoked_at, created_at}`. `max_downloads` and `revoked_at` can be null. `public_url` is `/s/:token` on the configured origin and contains the high-entropy bearer token. Store the `id` for explicit revocation; protect the URL like a credential and disclose it only to the requested audience.

Share tokens use 32 random bytes and are stored hashed. Admission increments `download_count` atomically. The count tracks admitted requests, not completed delivery. An unavailable/expired/revoked/exhausted token or unavailable file returns 410. Admission-time checks cannot retract copies or terminate transfers already admitted. Share creation, revocation, persistence changes, and deletion each require explicit requester intent; none is an automatic upload side effect.

Delete locks the row and commits a `deleting` claim before removing bytes. Claimed files cannot admit new metadata/private/share/retention access. Successful unlink and matching-claim finalization mark metadata deleted; unlink/DB uncertainty returns controlled 503 `FILE_DELETION_PENDING` and retains an unavailable recoverable claim. Scheduled cleanup uses the same claim protocol and retries pending claims, including manual deletion of durable files. SQL and disk do not share an atomic transaction. A finalized repeated DELETE returns 200 while its metadata remains; after purge it returns 404. Keep returns 409 once a claim exists. Confirm the success body before reporting deletion, and do not equate it with removal of external backups or recipient copies.

## Errors and other routes

Application errors generally use `{error: string}`; framework error responses may have additional fields. Stable optional code values include INVALID_INPUT, PERSISTENCE_DISABLED, PERMISSION_DENIED, FILE_DELETION_IN_PROGRESS and the allocation codes above.

| Status | Meaning / client action |
|---|---|
| 400 | Malformed/missing file, invalid persistence boolean, or invalid share expiry/count; correct input. |
| 401/403 | Missing authentication / denied permission; stop. |
| 404 | Missing or deleted file; missing share revocation ID. |
| 409 | File deletion is in progress; retention cannot restore it. |
| 410 | Expired/claimed file before finalization; unavailable public share. |
| 413 | Multipart/file upload limit; reduce input or review settings. |
| 408 | Incomplete idle upload; inspect the outcome before any new attempt. |
| 429 | Rate or upload concurrency rejection; honor `Retry-After`. Login is limited to five/minute/IP, authentication resolution and public share downloads to separate 120/minute/IP buckets, and uploads to 30/minute/principal. |
| 500 | Operation failure; reconcile uncertain mutations before repeating. |
| 507 | STORAGE_CAPACITY_EXCEEDED: unavailable byte headroom; CODE_SPACE_EXHAUSTED: permanent code namespace full, requiring operator intervention. |
| 503 | Readiness failure, bounded code-allocation retry exhaustion (Retry-After: 1), or UPLOAD_OUTCOME_UNKNOWN; stop and reconcile uncertain uploads. `FILE_DELETION_PENDING` permits an authenticated DELETE retry of the same claim; `FILE_RETENTION_PENDING` requires state verification; `FILE_ISSUANCE_DISABLED` requires operator registry recovery. |

A temporary file with an expiry is unavailable at its expiry even before cleanup; after metadata is hidden/removed, lookup becomes 404. Non-durable null expiry fails closed and violates the schema constraint. No example should infer persistence from a null expiry without checking the durable flag.

`GET /api/health` is unauthenticated process liveness `{ok, service}`, not database/schema readiness. `POST /api/auth/login` accepts administrator credentials and sets the signed HttpOnly SameSite=Lax cookie; `POST /api/auth/logout` revokes and clears it. `/api/admin/api-keys` and its `/:id` mutations are administrator-only; created key secrets are returned once. `GET /api/admin/storage-usage` is administrator-only and returns `bytes` plus `managedBytes`, `reservedBytes`, `active`, `unresolvedUploads` and `maxStorageBytes`. The disk measurement includes temporary/orphan bytes; reservations include protected uncertain uploads. The endpoint also exposes `managed_bytes`, `reserved_bytes`, `free_disk_bytes`, `max_storage_bytes`, `min_free_disk_bytes`, `active_uploads`, and `cleanup` (`last_attempt_at`, `last_success_at`, `pending_expired_bytes`, `failed_files`, `oldest_pending_at`). Reconciliation/purge timestamps and event-write failure counts support operator review. `bytes` remains the measured-byte compatibility alias. These browser/admin operations are outside the portable examples.

GET /api/ready checks schema version 4 and migration checksums with a bounded deadline. GET /api/instance, static skill download and a validated OpenAPI specification remain later work. The source-derived examples in [agents.md](agents.md) use `/api/auth/session` now. A timeout or unverifiable response after upload is an unknown outcome, with no idempotency guarantee: never blindly repeat POST; reconcile through authorized metadata/list access or ask the requester when safe reconciliation is impossible.

## Browser request policy and response headers

Cookie-authorized mutations require Origin exactly matching the configured instance origin; missing Origin, mismatched Origin and cross-site Sec-Fetch-Site are rejected. Bearer-only generic clients need no browser headers. Login allows JSON clients without Origin, but rejects mismatched Origin/cross-site Fetch metadata/form content types. Logout requires matching Origin and never borrows cookie authority from an explicit Bearer request. Administrator key names are nonblank and at most 128 UTF-8 bytes; flags are JSON booleans and secret/hash fields cannot be patched.

Ordinary JSON bodies and HTTP headers are bounded at 16 KiB. Authentication throttling occurs before expensive key/password verification; forwarding headers only influence client IP from explicitly trusted proxies. Request/connection and multipart idle deadlines are described in [configuration](configuration.md). Responses involving authentication/files/keys/shares and public downloads use no-store, nosniff and no-referrer. Byte responses use Content-Disposition: attachment. Request logs use route templates and generic error diagnostics, excluding headers, bodies, raw share-token URLs and queries.
