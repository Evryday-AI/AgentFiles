# AgentFiles phase D implementation plan: verified agent and browser handoff

> **For agentic workers:** Use `executing-plans` after C review. Verify A's early skill against the final HTTP behavior; preserve existing browser layout.

**Goal:** A generic agent completes a checksum-verified handoff and a human finds, previews and downloads it on a phone.

**Architecture:** OpenAPI describes observed handlers, not an invented framework. Clients use configurable origin/key with safe redirect/unknown-outcome handling. Browser agent setup uses existing key APIs, a read-only check and static secret-free skill download.

**Tech Stack:** OpenAPI 3.1, shell curl/jq, Python stdlib, React, Vitest DOM tests, Playwright browser integration.

## Global constraints

All [master constraints/interfaces](2026-10-10-agentfiles-open-source.md) apply. Codes are identifiers, not passwords. Public sharing, persistence and deletion require explicit intent. No live key in skills/URLs/browser persistence/telemetry. Synthetic media only; no downloaded-file execution.

## D1: complete OpenAPI, safe examples and actual skill verification

**Files:** Create `openapi.yaml`, `src/server/instanceRoutes.ts`, `tests/server/instanceRoutes.test.ts`, `tests/integration/apiContract.test.ts`, `tests/integration/agentRoundtrip.test.ts`, `scripts/validate-openapi.mjs`; modify `src/server/index.ts`, `package.json`, `skills/agentfiles/SKILL.md`, `docs/agents.md`, `docs/api-contract.md`, `examples/upload.sh`, `examples/roundtrip.py`; create `docs/verification/phase-d.md`.

**Interfaces:** Include every route in source findings plus `/api/ready` and `/api/instance`. JSON shape for unauthenticated instance metadata is:

```ts
export interface InstanceInfo {
  name: "AgentFiles"; base_url: string; retention_days: number;
  max_upload_bytes: number; allow_persistent_files: boolean; skill_url: string;
}
```

`GET /skills/agentfiles/SKILL.md` serves a bundled static distribution file as UTF-8 text, no user/key interpolation, no arbitrary path access. `GET /api/instance` returns only InstanceInfo. Runtime Docker copies reviewed skill asset explicitly. Metadata admin/status endpoints retain `bytes`; File DTO/schema retains all verified aliases. Binary download response has attachment/MIME/cache headers, no redirect.

- [ ] Add failing unit tests for non-secret instance fields and identical static skill body regardless of cookie/key; assert credentials/storage/database/network details absent. Register routes and bundle static skill safely; no dynamic env substitution into distributed Markdown.
- [ ] Enumerate all auth/health/files/share/admin/instance/static skill routes in OpenAPI with operation IDs, multipart file/durable, query params, request/success schemas, relevant errors, Bearer/signed-cookie schemes. `/s/{token}` explicitly has no other authentication and unavailable 410. `/api/auth/session` explicitly returns 200 authenticated false. Admin endpoints preserve source403 for missing/nonadmin authority unless C1 intentionally changes and records compatibility.
- [ ] Validate OpenAPI with a reviewed compatible parser/validator in dev dependencies, not unpinned npx. Add `validate:openapi` script invoking `scripts/validate-openapi.mjs`. Compare observed route templates/methods from Fastify introspection with spec, ignore only browser assets/shell endpoints intentionally documented outside API. Validate real DTOs/errors against JSON schemas, not test code that only reads a hand-written object.
- [ ] Implement Python stdlib client with streaming file upload/download, explicit request-size bounds and multipart Content-Length, safe local exclusive output and no automatic redirects. Parse configured origin and require response download URL scheme/host/port equality before adding key. Use a custom urllib redirect handler or http.client that rejects 3xx. No file buffer sized to full upload; checksum incrementally. Test hostile filename/local traversal, cross-origin JSON URL, redirect to mock server (second server must receive no credential), existing destination, SHA mismatch and ambiguous upload timeout.
- [ ] Implement shell example with strict error exit, curl/jq prerequisites, private temp config (no key argv), shell tracing disabled, config escaping/newline key rejection, max-redirs0, origin validation and exclusive output. Separate POSIX behavior from PowerShell (`curl.exe`, never PowerShell alias). Do not silently depend on Windows Bash; Python is the cross-platform documented alternative.
- [ ] Run both clients as subprocesses against a unique Compose fixture (B4 smoke harness expanded). Authenticate via fresh named scoped keys, upload hello/portrait fixtures, lookup, download/check SHA, return code/private URL/expiry, create explicit share, anonymous share download, revoke, and authorized deletion. Revoke a key and show next request denied. Upload-only cannot inspect; download-only cannot mutate.
- [ ] Verify expiry using test fixture clock/injected time for deterministic unit/integration cases and a real disposable row expiry changed **only inside the fixture DB** for end-to-end smoke. Do not add public clock-control/expiry-shortening endpoint. Record this method honestly; normal user retention remains seven days.
- [ ] Update skill from draft to runtime-verified only for the clients/platforms actually exercised. Include storage capacity/concurrency policy, exact denied persistence behavior, lack of idempotency, admitted-download count and transfer-expiry semantics. Redact all logs/results and repeat artifact/skill scans before commit.

**Representative client-origin test (Python):**

```python
from urllib.parse import urlsplit
def same_origin(base, target):
    a, b = urlsplit(base), urlsplit(target)
    def origin(u):
        return (u.scheme, u.hostname, u.port or (443 if u.scheme == "https" else 80))
    return not b.username and not b.password and origin(a) == origin(b)
assert same_origin("https://files.example.com", "https://files.example.com/api/files/F-ABCDE/download")
assert not same_origin("https://files.example.com", "https://other.example.com/download")
```

Base URL validation separately rejects path/query/fragment and nonlocal HTTP; same_origin does not replace it. The shipped client accepts only an API download URL from the authenticated response, not arbitrary link content.

**Commands:** `npm run validate:openapi`; `npm test -- tests/server/instanceRoutes.test.ts`; `npm run test:integration -- tests/integration/apiContract.test.ts tests/integration/agentRoundtrip.test.ts`; `bash -n examples/upload.sh`; `python -m py_compile examples/roundtrip.py`; `node scripts/smoke-compose.mjs --agents`. Add `--agents` explicitly to runner parser; do not accept unknown flags silently. Expected both actual clients roundtrip/checksum and negative-origin tests pass, not mere syntax checks.

**Acceptance/commit:** OpenAPI matches actual contract, HTTP clients work from distributed skill with no hidden framework/paid service, keys never cross origin or persist in skills/logs. `docs: verify OpenAPI and agent skill with independent HTTP clients`.

## D2: focused agent setup, code lookup and phone workflow

**Files:** Modify `src/client/App.tsx`, `api.ts`, `styles.css`, `components/Settings.tsx`, `UploadPanel.tsx`, `FileDetail.tsx`, `GalleryView.tsx`, `ListView.tsx`, `MediaPreview.tsx`; create `src/client/components/AgentSetup.tsx`, `CodeLookup.tsx`, `UploadResult.tsx`, `tests/client/AgentSetup.test.tsx`, `CodeLookup.test.tsx`, `UploadResult.test.tsx`, `tests/browser/handoff.spec.ts`, `playwright.config.ts`; modify `vitest.config.ts`, `package.json`, `docs/agents.md`, verification report.

**Interfaces:** Add client `getInstance(): Promise<InstanceInfo>`, `checkAgentConnection(key:string): Promise<SessionResponse>`. Check sends only Bearer to same-origin `/api/auth/session` with `credentials:'omit'` so an admin cookie cannot make a bad key appear valid. Use in-memory key state cleared on dismiss/revoke/logout/component unmount. `AgentSetup` consumes existing create/list/revoke key APIs and instance policy; all distributed downloads remain static.

- [ ] Write DOM regression showing bad key + current admin session still displays failed connection; assert request credentials omitted. Write one-time key lifecycle tests: displayed/copied after creation, absent after dismiss/logout, not present in localStorage/sessionStorage/history/skill download. Connection success shows actual camelCase permission flags, not just HTTP200.
- [ ] Add instance base URL, upload+download minimum preset (`canUpload/canDownload` true, list/delete/share/durable false), separate optional list preset, explicit destructive/share/persistence permission choices. Show one-time secret and warning copied snippets may contain credentials. Skill download contains only generic env names and static instructions.
- [ ] Add exact code lookup: form validates `F-` format and calls getFile regardless of list pagination/search, selects result, shows distinct401/403/404/410. Existing library filter continues filtering listed files; it does not pretend to be server-wide search. `/files/:code` initial deep link uses lookup and preserves error instead of swallowing it.
- [ ] Upload result stores full FileItem, presents name/code/private browser link/expiry or explicit persistent state/checksum, supports copy-code and copy-private-link. Disable persistence control when installation forbids it; human descriptions use “Keep indefinitely” only on explicit permission/policy. Never create a public share during upload/copy-private-link.
- [ ] Keep source gallery/list layout, original image/video proportions (`object-fit: contain`), inline detail below selected mobile card, native dialog and stale-selection guards. Handle updated actions still selected/deselected correctly; close preview on file change. No unrelated redesign or imported font/media assets.
- [ ] Add authenticated storage/cleanup panel from C3 with used/reserved/capacity/pending bytes and last success. Plain errors for full storage, cleanup delayed, expired/missing file and unknown upload outcome; no “retry upload” button after unknown outcome without reconciliation. Expired/new-session metadata may become stale in UI: refresh/recheck detail at access and show server410.
- [ ] Browser tests use only independent synthetic DB/key/file fixtures: desktop1280px, phone390px and minimum320px, keyboard tab/focus/Enter, portrait/landscape PNG and short synthetic video/audio, download event/exact checksum, expired/share revocation errors, bad key check, file-selection race and no horizontal overflow. Files generated within fixture directories; source/private screenshots/assets never used.
- [ ] Run actual phone/reachable HTTPS handoff using owned disposable deployment when available. A Playwright narrow viewport is recorded as viewport evidence, not physical phone or public HTTPS evidence. Localhost on the phone refers to the phone; public guide explains reachable configured HTTPS origin. No private infrastructure used to fill this check.

**Connection-check implementation target:**

```ts
export async function checkAgentConnection(key: string): Promise<SessionResponse> {
  const response = await fetch("/api/auth/session", {
    credentials: "omit", redirect: "error",
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new ApiError("Connection check failed", response.status);
  return response.json() as Promise<SessionResponse>;
}
```

AgentSetup interprets `authenticated=false` as failure even with 200 and offers a new minimal key. Never log response secrets/request header values.

**Commands:** `npm test -- tests/client`; `npm run typecheck`; `npm run build`; `npm run test:browser -- tests/browser/handoff.spec.ts`. Define `test:browser` as pinned installed Playwright runner with explicit independent fixture webServer; downloaded browser binaries are dependencies, not tracked artifacts. Install browser dependencies only in the test environment. Expected rendered behavior/downloads and negative cases verified, existing media/race behavior preserved.

**Acceptance/commit:** Agent setup usable without server internals, one-time secrets stay in memory, exact lookup works beyond200 listed items, phone viewport finds/previews/downloads agent output and clearly separates private/public links. `feat: add focused agent onboarding and phone handoff results`.
