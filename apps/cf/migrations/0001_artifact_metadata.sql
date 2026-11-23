CREATE TABLE artifact_bots (
  bot TEXT PRIMARY KEY NOT NULL,
  import_token TEXT NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
) STRICT;

CREATE TABLE artifact_heads (
  bot TEXT NOT NULL REFERENCES artifact_bots(bot),
  name TEXT NOT NULL,
  next_version INTEGER NOT NULL,
  latest_version INTEGER NOT NULL,
  minimum_version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  PRIMARY KEY (bot, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE artifact_versions (
  bot TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot, name, version),
  FOREIGN KEY (bot, name) REFERENCES artifact_heads(bot, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE artifact_uploads (
  bot TEXT NOT NULL REFERENCES artifact_bots(bot),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  staged_key TEXT,
  base_version INTEGER,
  request_id TEXT,
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
  PRIMARY KEY (bot, id),
  UNIQUE (bot, request_id),
  UNIQUE (bot, name, version)
) STRICT, WITHOUT ROWID;

CREATE INDEX artifact_pending_uploads ON artifact_uploads (bot, name) WHERE committed = 0;

CREATE TABLE artifact_garbage (
  bot TEXT NOT NULL REFERENCES artifact_bots(bot),
  object_key TEXT NOT NULL,
  token TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  PRIMARY KEY (bot, object_key)
) STRICT, WITHOUT ROWID;

CREATE VIEW artifact_pending AS
SELECT u.bot, u.id, u.size, b.used_bytes,
  (u.version >= h.minimum_version AND u.version > h.latest_version - 10
    AND (u.base_version IS NULL OR u.base_version = h.latest_version)) AS eligible
FROM artifact_uploads u
JOIN artifact_heads h ON h.bot = u.bot AND h.name = u.name
JOIN artifact_bots b ON b.bot = u.bot
WHERE u.committed = 0;

CREATE TRIGGER artifact_version_added AFTER INSERT ON artifact_versions
BEGIN
  UPDATE artifact_bots SET used_bytes = used_bytes + NEW.size WHERE bot = NEW.bot;
END;

CREATE TRIGGER artifact_version_removed AFTER DELETE ON artifact_versions
BEGIN
  UPDATE artifact_bots SET used_bytes = used_bytes - OLD.size WHERE bot = OLD.bot;
  INSERT OR REPLACE INTO artifact_garbage (bot, object_key) VALUES (OLD.bot, OLD.object_key);
END;

CREATE TRIGGER artifact_upload_reserved AFTER INSERT ON artifact_uploads
BEGIN
  INSERT INTO artifact_heads (bot, name, next_version, latest_version)
  VALUES (NEW.bot, NEW.name, NEW.version + 1, 0)
  ON CONFLICT (bot, name) DO UPDATE SET next_version = max(next_version, excluded.next_version);

  UPDATE artifact_bots SET used_bytes = used_bytes + NEW.size
  WHERE bot = NEW.bot AND NEW.committed = 0;
END;

CREATE TRIGGER artifact_pending_upload_removed AFTER DELETE ON artifact_uploads WHEN OLD.committed = 0
BEGIN
  UPDATE artifact_bots SET used_bytes = used_bytes - OLD.size WHERE bot = OLD.bot;
  INSERT OR REPLACE INTO artifact_garbage (bot, object_key) VALUES (OLD.bot, OLD.object_key);
  INSERT OR REPLACE INTO artifact_garbage (bot, object_key)
  SELECT OLD.bot, OLD.staged_key WHERE OLD.staged_key IS NOT NULL;
END;

CREATE TRIGGER artifact_upload_committed AFTER UPDATE OF committed ON artifact_uploads
WHEN OLD.committed = 0 AND NEW.committed = 1
BEGIN
  UPDATE artifact_bots SET used_bytes = used_bytes - OLD.size WHERE bot = OLD.bot;
  INSERT INTO artifact_versions (bot, name, version, object_key, size, content_type, created_at)
  VALUES (NEW.bot, NEW.name, NEW.version, NEW.object_key, NEW.size, NEW.content_type, CAST(unixepoch('subsec') * 1000 AS INTEGER));
  UPDATE artifact_heads SET latest_version = max(latest_version, NEW.version), deleted_at = NULL
  WHERE bot = NEW.bot AND name = NEW.name;
  INSERT OR REPLACE INTO artifact_garbage (bot, object_key)
  SELECT NEW.bot, NEW.staged_key WHERE NEW.staged_key IS NOT NULL;
  DELETE FROM artifact_versions
  WHERE bot = NEW.bot AND name = NEW.name AND version <= (
    SELECT latest_version - 10 FROM artifact_heads WHERE bot = NEW.bot AND name = NEW.name
  );
END;
