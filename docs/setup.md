# Administrator setup

AgentFiles remains in preparation. This setup command is implemented, and [Phase B evidence](verification/phase-b.md) records a fresh local Compose exercise. Complete lifecycle and release acceptance remain pending in the [release checklist](release-checklist.md). Continue with [self-hosting](self-hosting.md) after setup.

Setup creates a private `.env` with a new Argon2id administrator password hash, independent 32-byte database and session secrets, and the configuration defaults. It starts no database or application. The deployment database URL addresses the owned Compose service `db`, and storage uses `/data/storage`. Native operation requires an independently authored host configuration as described in [configuration](configuration.md).

## Docker tool

Install Docker Engine with the Compose plugin, or Docker Desktop with Linux containers. Host Node is unnecessary for this path. Run from the independent AgentFiles checkout before `.env` exists:

```sh
# Linux: preserve the invoking user's ownership of the private file.
export SETUP_UID=$(id -u) SETUP_GID=$(id -g)
docker compose -f compose.setup.yaml run --rm --build setup
test -r .env
```

On Docker Desktop with PowerShell, use the default container identity mapping:

```powershell
docker compose -f compose.setup.yaml run --rm --build setup
# Verify read access without displaying the file's credentials.
$configuration = [System.IO.File]::OpenRead((Join-Path (Get-Location) '.env'))
$configuration.Dispose()
```

Allow Docker Desktop access to the checkout's bind mount. The tool runs as the selected UID/GID and writes mode `0600` on Linux. A Linux host must export its own mapping; the default `1000:1000` is only suitable when it matches the host owner. Docker Desktop translates bind permissions through the host filesystem, so Unix mode bits alone do not establish privacy on Windows. Check host access controls and keep the checkout private to its owner. A mount permission failure leaves setup unsuccessful; correct access before retrying. Do not run setup as root to work around permissions.

The build context excludes private provenance, Git metadata, environment files, stored files, dumps, logs, screenshots and local caches. The tool image contains the reviewed Argon2 dependency closure, setup scripts and shared origin validator. After building, setup uses no network. It has no dependency on application or database services.

## Prompts and safe replacement

Choose `local` for loopback HTTP; its default origin is `http://localhost:3000`. Choose `public` and enter an external HTTPS origin for a reverse-proxy deployment. Setup uses the same origin validator as the application and rejects credentials, paths, query strings and fragments. Configure reviewed proxy addresses separately in `TRUST_PROXY` before starting public operation.

All entered values are hidden, including the administrator name and origin. Enter a password of at least 12 characters and at most 1024 UTF-8 bytes, then confirm it. Passwords are accepted only through the terminal prompt, never command-line flags or environment variables. Raw terminal input has no readline history. Backspace edits hidden input; Ctrl+C or Ctrl+D cancels, restores the terminal and creates no file while prompting.

Administrator names support 1–128 characters and must contain a non-whitespace character. Dollars, hashes, spaces, double quotes, Unicode and interior backslashes are preserved literally. Apostrophes, control characters and an odd number of trailing backslashes are rejected because Node and Compose disagree about their escaping. Generated values use single quotes to preserve the Argon2 hash's dollar signs without interpolation; generated passwords and secrets are hexadecimal. Do not shell-source `.env` or replace this encoding with shell escapes.

Setup exclusively creates `.env` and refuses to replace an existing file, including when two setup commands run concurrently. A second invocation reports that configuration exists. Keep an existing file for updates. Any intentional credential reset requires an operator-managed backup and a separately reviewed replacement; setup provides no overwrite option. Success output reports only that `.env` was created in the selected directory. Never print expanded Compose configuration, which contains credentials; use `config --quiet` when runtime Compose is available.

## Host fallback

Only the host fallback needs Node 24 and npm:

```sh
npm ci
npm run setup
```

The same prompts, encoding and exclusive-write protections apply. Advanced tooling can choose an independent existing output directory with `npm run setup -- --directory <directory>`; no other flags are accepted. Setup requires an actual interactive terminal and fails closed for piped stdin. Protect `.env`, do not commit it, and do not expose its values through browser build variables.
