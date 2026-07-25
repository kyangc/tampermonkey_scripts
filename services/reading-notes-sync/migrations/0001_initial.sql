PRAGMA foreign_keys = ON;

CREATE TABLE libraries (
  library_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (library_id) REFERENCES libraries(library_id) ON DELETE CASCADE
);

CREATE INDEX devices_library_idx
  ON devices(library_id, revoked_at);

CREATE TABLE pairings (
  pair_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  pair_secret_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('invited', 'claimed', 'approved', 'expired')),
  device_id TEXT,
  device_name TEXT,
  token_hash TEXT,
  public_key TEXT,
  key_envelope TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  FOREIGN KEY (library_id) REFERENCES libraries(library_id) ON DELETE CASCADE
);

CREATE INDEX pairings_library_idx
  ON pairings(library_id, created_at DESC);

CREATE TABLE records (
  library_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  nonce TEXT,
  ciphertext TEXT,
  last_mutation_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (library_id, record_id),
  FOREIGN KEY (library_id) REFERENCES libraries(library_id) ON DELETE CASCADE
);

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  nonce TEXT,
  ciphertext TEXT,
  device_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (library_id, mutation_id),
  FOREIGN KEY (library_id) REFERENCES libraries(library_id) ON DELETE CASCADE
);

CREATE INDEX changes_library_seq_idx
  ON changes(library_id, seq);
