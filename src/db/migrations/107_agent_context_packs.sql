-- Account-owned progressive cognition context packs.
-- Rows are deliberately tenant-keyed. The attachment tables only permit a
-- pack/revision and target owned by the same user, so a portable import can
-- never smuggle a live foreign attachment into a preset, chat, or world book.

-- SQLite composite foreign keys require a matching unique index on the
-- existing nullable owner columns. A NULL owner does not satisfy these keys.
CREATE UNIQUE INDEX IF NOT EXISTS idx_presets_user_id_id
  ON presets(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_user_id_id
  ON chats(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_world_books_user_id_id
  ON world_books(user_id, id);

CREATE TABLE IF NOT EXISTS agent_context_account_state (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  context_acl_revision INTEGER NOT NULL DEFAULT 0 CHECK (context_acl_revision >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS agent_context_packs (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 8192),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'account', 'restricted')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'review_required', 'repair_required')),
  latest_revision INTEGER NOT NULL DEFAULT 0 CHECK (latest_revision >= 0),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (length(provenance_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS agent_context_pack_revisions (
  user_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_json TEXT NOT NULL CHECK (length(content_json) <= 4194304),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64 AND content_digest GLOB '[0-9a-f]*'),
  token_count INTEGER NOT NULL CHECK (token_count >= 0 AND token_count <= 1048576),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0 AND byte_count <= 4194304),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'review_required', 'repair_required')),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (length(provenance_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL,
  PRIMARY KEY (user_id, pack_id, revision),
  FOREIGN KEY (user_id, pack_id) REFERENCES agent_context_packs(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

-- A reviewed copy intentionally retains the same validated digest; revision
-- number is the only row identity beyond the owner and pack.
-- Revision content and provenance form an append-only history. The state is
-- also immutable: quarantine/repair creates a replacement revision instead of
-- mutating bytes that a portable snapshot may already reference.
CREATE TRIGGER IF NOT EXISTS agent_context_pack_revisions_immutable_update
BEFORE UPDATE ON agent_context_pack_revisions
BEGIN
  SELECT RAISE(ABORT, 'agent context pack revisions are immutable');
END;

CREATE TABLE IF NOT EXISTS agent_context_pack_acls (
  user_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  principal_user_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'use', 'edit')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, pack_id, principal_user_id),
  FOREIGN KEY (user_id, pack_id) REFERENCES agent_context_packs(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (principal_user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_preset_context_pack_attachments (
  user_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0 AND position <= 1024),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'review_required', 'repair_required')),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (length(provenance_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, attachment_id),
  UNIQUE (user_id, preset_id, pack_id, revision),
  FOREIGN KEY (user_id, preset_id) REFERENCES presets(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, pack_id, revision) REFERENCES agent_context_pack_revisions(user_id, pack_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, pack_id) REFERENCES agent_context_packs(user_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS agent_chat_context_pack_attachments (
  user_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0 AND position <= 1024),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'review_required', 'repair_required')),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (length(provenance_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, attachment_id),
  UNIQUE (user_id, chat_id, pack_id, revision),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, pack_id, revision) REFERENCES agent_context_pack_revisions(user_id, pack_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, pack_id) REFERENCES agent_context_packs(user_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS agent_world_book_context_pack_attachments (
  user_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  world_book_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0 AND position <= 1024),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'review_required', 'repair_required')),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (length(provenance_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, attachment_id),
  UNIQUE (user_id, world_book_id, pack_id, revision),
  FOREIGN KEY (user_id, world_book_id) REFERENCES world_books(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, pack_id, revision) REFERENCES agent_context_pack_revisions(user_id, pack_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, pack_id) REFERENCES agent_context_packs(user_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_context_packs_user_state
  ON agent_context_packs(user_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_context_pack_revisions_pack
  ON agent_context_pack_revisions(user_id, pack_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_agent_context_pack_acls_principal
  ON agent_context_pack_acls(principal_user_id, user_id, pack_id);
CREATE INDEX IF NOT EXISTS idx_agent_preset_context_pack_attachments_target
  ON agent_preset_context_pack_attachments(user_id, preset_id, position, attachment_id);
CREATE INDEX IF NOT EXISTS idx_agent_chat_context_pack_attachments_target
  ON agent_chat_context_pack_attachments(user_id, chat_id, position, attachment_id);
CREATE INDEX IF NOT EXISTS idx_agent_world_book_context_pack_attachments_target
  ON agent_world_book_context_pack_attachments(user_id, world_book_id, position, attachment_id);

-- The account revision is a cheap, monotonic invalidation key for frozen
-- candidate sets and decision tokens. Triggers also cover direct maintenance
-- SQL, not only the service methods.
CREATE TRIGGER IF NOT EXISTS agent_context_pack_revision_bumps_account_revision
AFTER INSERT ON agent_context_pack_revisions
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;

CREATE TRIGGER IF NOT EXISTS agent_context_pack_acl_insert_bumps_account_revision
AFTER INSERT ON agent_context_pack_acls
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_context_pack_acl_update_bumps_account_revision
AFTER UPDATE ON agent_context_pack_acls
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_context_pack_acl_delete_bumps_account_revision
AFTER DELETE ON agent_context_pack_acls
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (OLD.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_context_pack_availability_update_bumps_account_revision
AFTER UPDATE OF visibility, state ON agent_context_packs
WHEN OLD.visibility <> NEW.visibility OR OLD.state <> NEW.state
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;

CREATE TRIGGER IF NOT EXISTS agent_context_pack_delete_bumps_account_revision
AFTER DELETE ON agent_context_packs
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (OLD.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;

CREATE TRIGGER IF NOT EXISTS agent_preset_context_pack_attachment_insert_bumps_account_revision
AFTER INSERT ON agent_preset_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_preset_context_pack_attachment_update_bumps_account_revision
AFTER UPDATE ON agent_preset_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_preset_context_pack_attachment_delete_bumps_account_revision
AFTER DELETE ON agent_preset_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (OLD.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;

CREATE TRIGGER IF NOT EXISTS agent_chat_context_pack_attachment_insert_bumps_account_revision
AFTER INSERT ON agent_chat_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_chat_context_pack_attachment_update_bumps_account_revision
AFTER UPDATE ON agent_chat_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_chat_context_pack_attachment_delete_bumps_account_revision
AFTER DELETE ON agent_chat_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (OLD.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;

CREATE TRIGGER IF NOT EXISTS agent_world_book_context_pack_attachment_insert_bumps_account_revision
AFTER INSERT ON agent_world_book_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_world_book_context_pack_attachment_update_bumps_account_revision
AFTER UPDATE ON agent_world_book_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (NEW.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
CREATE TRIGGER IF NOT EXISTS agent_world_book_context_pack_attachment_delete_bumps_account_revision
AFTER DELETE ON agent_world_book_context_pack_attachments
BEGIN
  INSERT INTO agent_context_account_state(user_id, context_acl_revision, updated_at)
    VALUES (OLD.user_id, 1, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET context_acl_revision = context_acl_revision + 1, updated_at = unixepoch();
END;
