# Updates and rollback

AgentFiles remains in preparation. E2 exercises an experimental revision upgrade and coordinated synthetic restore locally; no earlier released-version upgrade, production deployment or release acceptance is implied.

Keep the checkout, private `.env`, project name and both named volumes. Review the intended revision's configuration, image pins and immutable ledger. Never edit applied SQL migrations. Take a verified [coordinated backup](backups.md), preserve its matched app revision/image and secure configuration, and block external writers/public traffic during update.

```sh
docker compose stop app
git checkout <reviewed-revision>
docker compose config --quiet
docker compose build
docker compose run --rm migrate
docker compose up -d --no-deps --force-recreate app
docker compose ps
```

Run the fresh migration job explicitly and stop if it fails. An earlier successful `migrate` container can remain after ordinary Compose updates; `up` alone does not prove new migrations ran. Verify health/readiness, authentication and a known metadata/checksum download before traffic. Use the same selected `--project-name` consistently when different from checkout default. `down` preserves named volumes; normal operations never use `down -v`, `down --volumes`, `volume prune`, a new project identity or blanket host ownership changes.

For `compose.external-db.yaml`, use that file on every command and coordinate the dedicated database operator's separately reviewed backup/restore procedure. The default backup helper refuses external databases.

## Experimental schema-2 to schema-4 check

The local runner reads only this repository's reviewed public-source ancestor `b4c99bba7e625678ff55cb71ff2ed04d6e9902ac` (Phase B, a **pre-release experimental revision**). It builds that source, starts fresh synthetic volumes, uploads a known file, takes an offline schema-2 DB/byte snapshot, applies current immutable migrations 001–004 and verifies ledger/original bytes. CI fetches this repository's history for the baseline object.

A nonempty database predating volume pairing fails closed under current startup. This fixture alone knows the original exclusively owned synthetic volume and complete issuance history; it supplies an explicit offline pairing/full-history attestation and matching UUID row/marker. This does not authorize automatic adoption of arbitrary old installations or recover historically purged codes. Production startup guards remain intact. Keep issuance disabled if complete historical reservations cannot be established.

## Rollback means matched restore

An old migration binary rejects a newer ledger; old apps on newer schemas are unsupported. Stop the app, restore matched app + database + archived bytes into new verified owned volumes, recover **all later-issued reservations**, rotate/revoke sessions and follow [recovery gates](backups.md). An old current-schema snapshot alone is insufficient after later issuance.

Smoke mechanically restores the experimental schema-2 snapshot into new volumes after deliberately changing upgraded fixture bytes; its original download proves archive restoration. The old binary boots briefly for authenticated read verification, then stops. That baseline lacks permanent reservations and the issuance-disable switch: this is experimental rollback mechanics, **not safe continued operation or permission to resume schema-2 uploads**. No later codes were admitted during that upgrade fixture because current-runtime issuance was disabled. Supported recovered operation uses the current runtime and complete registry union, independently proven by the schema-4 stale-snapshot restore.
