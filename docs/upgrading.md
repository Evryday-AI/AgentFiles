# Initial update instructions

AgentFiles remains in preparation. These are volume-preserving update instructions for current Compose packaging; an actual version-to-version upgrade and isolated restore remain pending Phase E. Container recreation is separate from upgrade/restore evidence.

Keep the independent checkout, existing private `.env`, Compose project name and both volumes. Do not rerun setup to generate new credentials during an update. Review the chosen revision's release notes, image pins, configuration changes and immutable migrations. Never modify a previously applied SQL migration to make a ledger check pass.

Before updating, stop writes and take a consistent operator-controlled backup of the entire dedicated database, stored bytes and private configuration. Keep backups private. Future lifecycle schemas require complete permanent code reservations and pending deletion claims; their tested restore protocol is pending. No downgrade or partial database/byte restore guarantee is provided here.

After a separately reviewed backup procedure, select an explicitly reviewed revision:

```sh
docker compose down
git checkout <reviewed-revision>
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
```

Check `/api/health` and `/api/ready`, sign in, and verify metadata plus a checksum-matching download of a synthetic known file. Compose reruns migrations and prevents app startup on failure. An old app against a newer schema fails readiness. Investigate errors without printing expanded configuration or credentials; keep the app stopped if consistency is uncertain.

Use `-f compose.external-db.yaml` on every Compose command for the advanced alternative. Its database operator coordinates database backup/update separately; `down` affects only migration/app and their network. Normal updates must not use `down -v`, `down --volumes`, `volume prune`, a different project name, or a blanket storage ownership change.
