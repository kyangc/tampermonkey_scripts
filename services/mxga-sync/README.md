# MXGA Sync Worker

Cloudflare Worker + D1 backend for the optional multi-device block preferences in `make-x-great-again.user.js`.

The service is intentionally simple:

- `GET /v1/snapshot` is public and returns the current keyword/account document and optional encrypted cobalt envelope.
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

## Encrypted cobalt configuration (service 0.2.0 / userscript 0.7.1)

The existing snapshot may additionally contain `document.cobalt`: a v1 envelope
with `updatedAt`, `source`, random 16-byte `salt`, random 12-byte `iv`, and base64
`data`. Client-side AES-256-GCM uses PBKDF2-SHA-256 (210,000 iterations) and a
separate user-selected passphrase; authenticated additional data binds the source,
timestamp, and format. The passphrase never goes to this service. Neither the
endpoint nor the API key appears in plaintext in the envelope. Public snapshots
still expose keywords, accounts, and envelope metadata; weak passphrases can be
subject to offline guessing, so use a strong unique passphrase.

The server rejects malformed envelopes and extra plaintext fields. Legacy clients
omit `cobalt`; their revision-guarded writes retain the stored envelope. Newer
configuration events win by timestamp and source. Resetting to website mode is an
encrypted empty configuration, not a missing field. No database migration is needed.

Clients retain an encrypted pending event across failed requests, preserve local
configuration on decryption/read failure, and detect local edits during an in-flight
sync. The endpoint and API key always travel together to prevent pairing an old key
with a different endpoint. Changing the encryption passphrase is not a key-rotation
workflow: existing ciphertext must decrypt before it can be replaced.
