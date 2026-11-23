CREATE TABLE note_revisions (
  bot TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  request_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  PRIMARY KEY (bot, id, revision),
  UNIQUE (bot, request_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX note_gallery_order ON note_revisions (bot, updated_at DESC, id);

CREATE TABLE note_gallery_pins (
  bot TEXT NOT NULL,
  card_key TEXT NOT NULL,
  PRIMARY KEY (bot, card_key)
) STRICT, WITHOUT ROWID;
