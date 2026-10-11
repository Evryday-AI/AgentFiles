# Source-derived HTTP contract

**Drafted from source; runtime verification pending D1.** This inventory describes `src/server/adminRoutes.ts`, `filesRoutes.ts`, `shareRoutes.ts`, and their DTO/auth helpers. It preserves the unversioned routes and aliases. It is not OpenAPI or evidence of a passing application HTTP run, deployment, or clean installation.

## Authentication and permissions

Send `Authorization: Bearer <AGENTFILES_API_KEY>` only to the configured origin. A new standalone key has format `af_<24 lowercase hex lookup characters>_<64 lowercase hex secret characters>`. The signed administrator cookie is named `agentfiles_admin`. Browser administration uses that cookie; generic agent examples use only the header and never send cookies. The baseline resolves an administrator cookie before a Bearer key, which is another reason a key connection check must omit cookies; C1 plans stronger explicit-Bearer precedence.

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

Upload uses multipart/form-data with one `file` part. Omit the optional `durable` field for ordinary temporary storage. Baseline form booleans accept `true`/`1`/`on` or `false`/`0`/`off`. Upload limits are currently hardcoded: 1 GiB per file, one file, 20 fields, 4 KiB per field, and 25 total parts. No capacity or concurrent-upload admission guarantee is implemented in this baseline.

`GET /api/files` accepts `limit`, `offset`, and `durable` query parameters; default limit is 100, clamped to 1–500, and default offset is zero. Lists exclude deleted and expired rows according to baseline availability checks. For reconciliation, pagination is necessary and a mutable list is not a snapshot.

`PATCH /api/files/:code` accepts JSON `{"durable": true}` or `{"durable": false}`. True removes expiry; false starts a new default retention interval. The baseline checks `can_mark_durable` for PATCH, but silently downgrades unauthorized upload `durable=true` to temporary storage. Clients must precheck permission and inspect the returned flag. Explicit forbidden-persistence 403, operator policy, and fail-closed temporary-null-expiry behavior are planned C1 work.

The File DTO is flat and contains all of these fields:

| Field | Type and meaning |
|---|---|
| `code` | String, baseline generated `F-` plus five alphabet characters |
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

For handoffs, record instance origin, code, creation time, and checksum in addition to the concise summary. The permanent issued-code registry and no-reassignment guarantee are planned C1–C3 work, not established by the baseline allocator.

## Shares and explicit mutation intent

Create a share only with explicit requester intent. JSON requires `expires_at` as a future ISO date; it must not exceed a temporary file's expiry. Optional `max_downloads` is a positive integer or null. The baseline also accepts `expiresAt` and `maxDownloads` request aliases. Use the documented snake_case names in new clients.

The Share DTO is `{id, file_code, public_url, expires_at, max_downloads, download_count, revoked_at, created_at}`. `max_downloads` and `revoked_at` can be null. `public_url` is `/s/:token` on the configured origin and contains the high-entropy bearer token. Store the `id` for explicit revocation; protect the URL like a credential and disclose it only to the requested audience.

Share tokens use 32 random bytes and are stored hashed. Admission increments `download_count` atomically. The count tracks admitted requests, not completed delivery. An unavailable/expired/revoked/exhausted token or unavailable file returns 410. Admission-time checks cannot retract copies or terminate transfers already admitted. Share creation, revocation, persistence changes, and deletion each require explicit requester intent; none is an automatic upload side effect.

Delete removes bytes before marking metadata deleted in the baseline. Failure removing bytes returns controlled 500 and preserves metadata. Later lifecycle claims/recovery are planned C1–C3 work; do not claim an atomic database/filesystem delete. Confirm the success body before reporting deletion, and do not equate it with removal of external backups or recipient copies.

## Errors and other routes

Application errors generally use `{error: string}`; framework error responses may have additional fields. Optional structured error `code` values are planned and must not be assumed by clients.

| Status | Baseline meaning / client action |
|---|---|
| 400 | Malformed/missing file, invalid persistence boolean, or invalid share expiry/count; correct input. |
| 401/403 | Missing authentication / denied permission; stop. |
| 404 | Missing or deleted file; missing share revocation ID. |
| 410 | Expired file before cleanup; unavailable public share. |
| 413 | Multipart/file upload limit; reduce input or review settings. |
| 429 | Rate limiter rejection; honor `Retry-After` if supplied. Baseline login is limited to five requests/minute; later per-key/concurrency controls are planned. |
| 500 | Operation failure; reconcile uncertain mutations before repeating. |
| 507 | Planned storage-capacity/code-space rejection; not baseline admission behavior. |
| 503 | Planned readiness/code-allocation behavior; no baseline readiness route. |

A temporary file with an expiry is unavailable at its expiry even before cleanup; after metadata is hidden/removed, lookup becomes 404. The baseline treats a non-durable null expiry as available; C1 plans to reject that invalid state. No example should infer persistence from a null expiry without checking the durable flag.

`GET /api/health` is unauthenticated process liveness `{ok, service}`, not database/schema readiness. `POST /api/auth/login` accepts administrator credentials and sets the signed HttpOnly SameSite=Lax cookie; `POST /api/auth/logout` revokes and clears it. `/api/admin/api-keys` and its `/:id` mutations are administrator-only; created key secrets are returned once. `GET /api/admin/storage-usage` is administrator-only and returns `{bytes}`. These browser/admin operations are outside the portable examples.

`GET /api/instance`, readiness, static skill download, and a validated OpenAPI specification are later work. The source-derived examples in [agents.md](agents.md) use `/api/auth/session` now. A timeout or unverifiable response after upload is an unknown outcome, with no idempotency guarantee: never blindly repeat POST; reconcile through authorized metadata/list access or ask the requester when safe reconciliation is impossible.
