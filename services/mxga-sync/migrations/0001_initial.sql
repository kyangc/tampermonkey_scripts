CREATE TABLE snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
