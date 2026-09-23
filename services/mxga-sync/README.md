# MXGA Sync Worker

Cloudflare Worker + D1 backend for MXGA preferences and cobalt download settings.

- `GET /v2/snapshot` and `POST /v2/snapshot` require the same `SYNC_TOKEN` bearer secret.
- One document contains keywords, blocked accounts, and optional cobalt endpoint/API Key settings. There is no separate encryption passphrase or switch.
- HTTPS protects transport; D1 stores the configuration as JSON. The service owner and holders of the sync token can read it.
- Writes use an optimistic `baseRevision`; stale writers receive `409` with the latest document and merge before retrying.
- Per-item update records and deletion tombstones preserve offline preference changes. Cobalt endpoint and API Key form one timestamped event, so they cannot be merged into a mismatched pair.
- The service does not receive visited pages, the current X identity, tweet text, or match events.

## Deploy

Create a D1 database, replace its ID in `wrangler.jsonc`, apply the migration, set a random write token, and deploy:

```bash
cd services/mxga-sync
npx wrangler d1 create mxga-sync --location apac
npx wrangler d1 migrations apply mxga-sync --remote
npx wrangler secret put SYNC_TOKEN
npx wrangler deploy
```

Keep the sync token outside the repository. Each trusted browser stores the same token in its own userscript storage. The default service is `https://mxga-sync.1109.workers.dev`; to use another deployment, change `FILTER_SYNC_ENDPOINT` in `src/userscripts/make-x-great-again.entry.js`, add its host to `@connect`, and rebuild.

## Release order and verification

Service 0.3.0 must be deployed before userscript 0.7.4. The client uses `/v2/snapshot` exclusively so that a server without the new authenticated contract rejects the request before any cobalt configuration is uploaded. `/v1/snapshot` reads also require authentication; its writes are disabled. No database migration is needed.

Verify that unauthenticated and incorrect-token reads return `401` on both snapshot paths, authenticated v2 reads succeed, and revision-guarded writes round-trip the complete document. Do not log the token or snapshot contents. A local Worker-handler/SQLite integration test covers the client/server contract; live and Tampermonkey acceptance must be recorded separately.

## Configuration events

`document.cobalt` uses `{ v: 2, updatedAt, source, config: { endpoint, apiKey } }`. Empty strings explicitly reset to website mode. Rule-only writes preserve the stored cobalt value. Failed requests retain a local pending event; local edits during an in-flight sync are deferred to the next attempt rather than overwritten.

Existing encrypted data is retained until a device uploads its local configuration in the new format. The client does not need the previous encryption passphrase. A newly connected device prefers an existing v2 remote configuration unless it has a pending local edit.
