CREATE TABLE bot_metadata (
  bot TEXT PRIMARY KEY NOT NULL,
  publish_token TEXT NOT NULL
) STRICT;

CREATE TABLE bot_documents (
  bot TEXT NOT NULL REFERENCES bot_metadata(bot),
  document_key TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  space_due_at INTEGER,
  PRIMARY KEY (bot, document_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX bot_spaces_due ON bot_documents (bot, space_due_at) WHERE space_due_at IS NOT NULL;

CREATE TABLE bot_schedules (
  bot TEXT NOT NULL REFERENCES bot_metadata(bot),
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL,
  next_run_at INTEGER,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (bot, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX bot_schedules_due ON bot_schedules (bot, next_run_at) WHERE state = 'active';
