# MXGA Sync Worker

Cloudflare Worker + D1 backend for the optional multi-device block preferences in `make-x-great-again.user.js`.

The service is intentionally simple:

- `GET /v1/snapshot` is public and returns the current keyword/account document.
- `POST /v1/snapshot` requires the `SYNC_TOKEN` bearer secret.
- Writes use an optimistic `baseRevision`; stale writers receive `409` with the latest document and merge before retrying.
- The userscript keeps per-item update records and deletion tombstones so offline additions and removals can converge.
- The service does not receive visited pages, the current X identity, tweet text, or match events.

The personal production deployment is:

```text
https://mxga-sync.1109.workers.dev
```

## Deploy

Create a D1 database, replace its ID in `wrangler.jsonc`, apply the migration, set a random write token, and deploy:

```bash
cd services/mxga-sync
npx wrangler d1 create mxga-sync --location apac
npx wrangler d1 migrations apply mxga-sync --remote
npx wrangler secret put SYNC_TOKEN
npx wrangler deploy
```

Keep the write token outside the repository. Each trusted browser stores the same token in its own userscript storage. The synchronized document itself is public and is not encrypted.
