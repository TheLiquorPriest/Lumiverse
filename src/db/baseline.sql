-- Lumiverse Database Baseline Schema
-- Squashed migrations are listed in BASELINE_MIGRATIONS in src/db/migrate.ts
-- (001-065 plus later folds); the runner records them as already applied on
-- fresh databases instead of replaying the full migration stack.

CREATE TABLE "account" (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE agent_activity_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_id INTEGER,
  snapshot_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 32768),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, chat_id, generation_id)
);

CREATE TABLE character_gallery (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  image_id      TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  caption       TEXT DEFAULT '',
  sort_order    INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_path TEXT,
  description TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  first_mes TEXT NOT NULL DEFAULT '',
  mes_example TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT '',
  creator_notes TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  post_history_instructions TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  alternate_greetings TEXT NOT NULL DEFAULT '[]',
  extensions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, image_id TEXT REFERENCES images(id) ON DELETE SET NULL, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, folder TEXT NOT NULL DEFAULT '', library_scope TEXT NOT NULL DEFAULT 'mine' CHECK(library_scope IN ('mine', 'shared')));

CREATE VIRTUAL TABLE characters_fts USING fts5(
  name, creator, tags,
  content='characters',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TABLE chat_chunks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  vectorized_at INTEGER,
  vector_model TEXT,
  retrieval_count INTEGER DEFAULT 0,
  last_retrieved_at INTEGER,
  avg_similarity_score REAL,
  has_dialogue INTEGER DEFAULT 1,
  has_action INTEGER DEFAULT 0,
  message_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, salience_score REAL DEFAULT NULL, emotional_tags TEXT DEFAULT NULL, entity_ids TEXT DEFAULT NULL, consolidation_id TEXT DEFAULT NULL, message_range_start INTEGER DEFAULT NULL, message_range_end INTEGER DEFAULT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE chat_memory_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  settings_key TEXT NOT NULL,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  query_preview TEXT NOT NULL DEFAULT '',
  chunks_json TEXT NOT NULL DEFAULT '[]',
  formatted TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings_source TEXT NOT NULL DEFAULT 'global',
  chunks_available INTEGER NOT NULL DEFAULT 0,
  chunks_pending INTEGER NOT NULL DEFAULT 0,
  retrieval_mode TEXT NOT NULL DEFAULT 'empty',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id, settings_key)
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE TABLE connection_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, has_api_key INTEGER NOT NULL DEFAULT 0, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE TABLE cortex_chat_links (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  link_type       TEXT NOT NULL CHECK(link_type IN ('vault', 'interlink')),
  vault_id        TEXT,
  target_chat_id  TEXT,
  label           TEXT DEFAULT '',
  enabled         INTEGER DEFAULT 1,
  priority        INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE,
  FOREIGN KEY (target_chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE cortex_vault_chunks (
  id                  TEXT PRIMARY KEY,
  vault_id            TEXT NOT NULL,
  source_chunk_id     TEXT NOT NULL,
  content             TEXT NOT NULL,
  salience_score      REAL,
  emotional_tags      TEXT DEFAULT '[]',
  entity_names        TEXT DEFAULT '[]',
  source_created_at   INTEGER NOT NULL,
  copied_at           INTEGER NOT NULL,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);

CREATE TABLE cortex_vault_entities (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  name              TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  aliases           TEXT DEFAULT '[]',
  description       TEXT DEFAULT '',
  status            TEXT DEFAULT 'active',
  facts             TEXT DEFAULT '[]',
  emotional_valence TEXT DEFAULT '{}',
  salience_avg      REAL DEFAULT 0.0,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);

CREATE TABLE cortex_vault_relations (
  id                  TEXT PRIMARY KEY,
  vault_id            TEXT NOT NULL,
  source_entity_name  TEXT NOT NULL,
  target_entity_name  TEXT NOT NULL,
  relation_type       TEXT NOT NULL,
  relation_label      TEXT,
  strength            REAL DEFAULT 0.5,
  sentiment           REAL DEFAULT 0.0,
  status              TEXT DEFAULT 'active',
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);

CREATE TABLE cortex_vaults (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  source_chat_id  TEXT,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  entity_count    INTEGER DEFAULT 0,
  relation_count  INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL, chunk_count INTEGER DEFAULT 0,
  FOREIGN KEY (source_chat_id) REFERENCES chats(id) ON DELETE SET NULL
);

CREATE TABLE databank_chunks (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,
  databank_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  token_count   INTEGER NOT NULL DEFAULT 0,
  vectorized_at INTEGER,
  vector_model  TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES databank_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (databank_id) REFERENCES databanks(id) ON DELETE CASCADE
);

CREATE TABLE databank_documents (
  id            TEXT PRIMARY KEY,
  databank_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT '',
  file_size     INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL DEFAULT '',
  total_chunks  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'ready', 'error')),
  error_message TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (databank_id) REFERENCES databanks(id) ON DELETE CASCADE
);

CREATE TABLE databanks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL CHECK(scope IN ('global', 'character', 'chat')),
  scope_id    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE dream_weaver_saved_prompts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE dream_weaver_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  dream_text TEXT NOT NULL,
  tone TEXT,
  constraints TEXT,
  dislikes TEXT,
  persona_id TEXT,
  connection_id TEXT,
  model TEXT,

  draft TEXT,

  status TEXT DEFAULT 'draft',

  character_id TEXT,

  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
);

CREATE TABLE extension_grants (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(extension_id, permission)
);

CREATE TABLE extensions (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT DEFAULT '',
  github TEXT NOT NULL,
  homepage TEXT DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata TEXT DEFAULT '{}'
, install_scope TEXT NOT NULL DEFAULT 'operator', installed_by_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, branch TEXT DEFAULT NULL);

CREATE TABLE global_addons (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE image_gen_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  has_api_key INTEGER NOT NULL DEFAULT 0,
  default_parameters TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE TABLE loom_items (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'narrative_style',
  author_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE loom_tools (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  input_schema TEXT NOT NULL DEFAULT '{}',
  result_variable TEXT NOT NULL DEFAULT '',
  store_in_deliberation INTEGER NOT NULL DEFAULT 0,
  author_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE lumia_items (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  behavior TEXT NOT NULL DEFAULT '',
  gender_identity INTEGER NOT NULL DEFAULT 3,
  version TEXT NOT NULL DEFAULT '1.0.0',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE lumihub_link (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  lumihub_url TEXT NOT NULL,
  ws_url TEXT NOT NULL,
  instance_name TEXT NOT NULL DEFAULT 'My Lumiverse',
  link_token_encrypted TEXT NOT NULL,
  link_token_iv TEXT NOT NULL,
  link_token_tag TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_connected_at TEXT
);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  transport_type TEXT NOT NULL DEFAULT 'streamable_http',
  url TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  has_headers INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  auto_connect INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  last_connected_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE memory_consolidations (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    tier INTEGER NOT NULL DEFAULT 1,
    title TEXT,
    summary TEXT NOT NULL,
    source_chunk_ids TEXT DEFAULT '[]',
    source_consolidation_ids TEXT DEFAULT '[]',
    entity_ids TEXT DEFAULT '[]',
    message_range_start INTEGER,
    message_range_end INTEGER,
    time_range_start INTEGER,
    time_range_end INTEGER,
    salience_avg REAL DEFAULT 0.0,
    emotional_tags TEXT DEFAULT '[]',
    token_count INTEGER DEFAULT 0,
    vectorized_at INTEGER,
    vector_model TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE memory_entities (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'character',
    aliases TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    first_seen_chunk_id TEXT,
    last_seen_chunk_id TEXT,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    mention_count INTEGER DEFAULT 0,
    salience_avg REAL DEFAULT 0.0,
    status TEXT DEFAULT 'active',
    status_changed_at INTEGER,
    facts TEXT DEFAULT '[]',
    emotional_valence TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, fact_extraction_status TEXT DEFAULT 'never', fact_extraction_last_attempt INTEGER, salience_breakdown TEXT DEFAULT '{"mentionComponent":0,"arcComponent":0,"graphComponent":0,"frequencyFloor":0,"total":0}', last_mention_timestamp INTEGER, recent_mention_count INTEGER DEFAULT 0, confidence TEXT DEFAULT 'confirmed', salience_peak REAL DEFAULT 0.0,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE memory_font_colors (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    entity_id TEXT,
    hex_color TEXT NOT NULL,
    usage_type TEXT DEFAULT 'unknown',
    confidence REAL DEFAULT 0.0,
    sample_count INTEGER DEFAULT 0,
    sample_excerpt TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id) REFERENCES memory_entities(id) ON DELETE SET NULL
);

CREATE TABLE memory_mentions (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    role TEXT DEFAULT 'present',
    excerpt TEXT,
    sentiment REAL DEFAULT 0.0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (chunk_id) REFERENCES chat_chunks(id) ON DELETE CASCADE
);

CREATE TABLE memory_relations (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    relation_label TEXT,
    strength REAL DEFAULT 0.5,
    sentiment REAL DEFAULT 0.0,
    evidence_chunk_ids TEXT DEFAULT '[]',
    first_established_at INTEGER,
    last_reinforced_at INTEGER,
    status TEXT DEFAULT 'active',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, contradiction_flag TEXT DEFAULT 'none', contradiction_peer_id TEXT, sentiment_range TEXT, superseded_by TEXT, arc_ids TEXT DEFAULT '[]', first_seen_arc_id TEXT, last_seen_arc_id TEXT, last_evidence_timestamp INTEGER, decay_rate REAL DEFAULT 0.05, edge_salience REAL DEFAULT 0.0, label_aliases TEXT DEFAULT '[]', canonical_edge_id TEXT, merged_into TEXT,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (source_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (target_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE
);

CREATE TABLE memory_salience (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0.0,
    score_source TEXT DEFAULT 'heuristic',
    emotional_tags TEXT DEFAULT '[]',
    status_changes TEXT DEFAULT '[]',
    narrative_flags TEXT DEFAULT '[]',
    has_dialogue INTEGER DEFAULT 0,
    has_action INTEGER DEFAULT 0,
    has_internal_thought INTEGER DEFAULT 0,
    word_count INTEGER DEFAULT 0,
    scored_at INTEGER NOT NULL,
    scored_by TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (chunk_id) REFERENCES chat_chunks(id) ON DELETE CASCADE
);

CREATE TABLE message_breakdowns (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  index_in_chat INTEGER NOT NULL,
  is_user INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  send_date INTEGER NOT NULL DEFAULT (unixepoch()),
  swipe_id INTEGER NOT NULL DEFAULT 0,
  swipes TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  branch_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
, swipe_dates TEXT NOT NULL DEFAULT '[]');

CREATE TABLE packs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  is_custom INTEGER NOT NULL DEFAULT 1,
  source_url TEXT,
  extras TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar_path TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, attached_world_book_id TEXT REFERENCES world_books(id) ON DELETE SET NULL, image_id TEXT REFERENCES images(id) ON DELETE SET NULL, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', subjective_pronoun TEXT NOT NULL DEFAULT '', objective_pronoun TEXT NOT NULL DEFAULT '', possessive_pronoun TEXT NOT NULL DEFAULT '', reflexive_pronoun TEXT NOT NULL DEFAULT '', possessive_pronoun_standalone TEXT NOT NULL DEFAULT '', is_narrator INTEGER NOT NULL DEFAULT 0);

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  prompt_order TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, prompts TEXT NOT NULL DEFAULT '{}', user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, engine TEXT NOT NULL DEFAULT 'classic');

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE query_vector_cache (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  query_text TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE regex_scripts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  find_regex TEXT NOT NULL,
  replace_string TEXT NOT NULL DEFAULT '',
  actions TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT 'gi',
  placement TEXT NOT NULL DEFAULT '["ai_output"]',
  scope TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  target TEXT NOT NULL DEFAULT '["response"]',
  min_depth INTEGER,
  max_depth INTEGER,
  trim_strings TEXT NOT NULL DEFAULT '[]',
  run_on_edit INTEGER NOT NULL DEFAULT 0,
  substitute_macros TEXT NOT NULL DEFAULT 'none',
  disabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, folder TEXT NOT NULL DEFAULT '', script_id TEXT NOT NULL DEFAULT '', pack_id TEXT, preset_id TEXT, character_id TEXT);

CREATE TABLE "secrets" (
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (key, user_id)
);

CREATE TABLE "session" (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE "settings" (
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (key, user_id)
);

CREATE TABLE theme_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bundle_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  storage_type TEXT NOT NULL,
  image_id TEXT REFERENCES images(id) ON DELETE CASCADE,
  file_name TEXT,
  original_filename TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE tokenizer_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  is_built_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE tokenizer_model_patterns (
  id TEXT PRIMARY KEY,
  tokenizer_id TEXT NOT NULL REFERENCES tokenizer_configs(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  is_built_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE tts_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  has_api_key INTEGER NOT NULL DEFAULT 0,
  default_parameters TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE "user" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  username TEXT UNIQUE,
  displayUsername TEXT,
  role TEXT DEFAULT 'user',
  banned INTEGER DEFAULT 0,
  banReason TEXT,
  banExpires INTEGER
);

CREATE TABLE "verification" (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER DEFAULT (unixepoch()),
  updatedAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE world_book_entries (
  id TEXT PRIMARY KEY,
  world_book_id TEXT NOT NULL REFERENCES world_books(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '[]',
  keysecondary TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 4,
  role TEXT,
  order_value INTEGER NOT NULL DEFAULT 100,
  selective INTEGER NOT NULL DEFAULT 0,
  constant INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  group_name TEXT NOT NULL DEFAULT '',
  group_override INTEGER NOT NULL DEFAULT 0,
  group_weight INTEGER NOT NULL DEFAULT 100,
  probability INTEGER NOT NULL DEFAULT 100,
  scan_depth INTEGER,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  match_whole_words INTEGER NOT NULL DEFAULT 0,
  automation_id TEXT,
  extensions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, use_regex INTEGER NOT NULL DEFAULT 0, prevent_recursion INTEGER NOT NULL DEFAULT 0, exclude_recursion INTEGER NOT NULL DEFAULT 0, delay_until_recursion INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 10, sticky INTEGER NOT NULL DEFAULT 0, cooldown INTEGER NOT NULL DEFAULT 0, delay INTEGER NOT NULL DEFAULT 0, selective_logic INTEGER NOT NULL DEFAULT 0, use_probability INTEGER NOT NULL DEFAULT 1, vectorized INTEGER NOT NULL DEFAULT 0, vector_index_status TEXT NOT NULL DEFAULT 'not_enabled', vector_indexed_at INTEGER, vector_index_error TEXT, revision INTEGER NOT NULL DEFAULT 1);

CREATE VIRTUAL TABLE world_book_entries_fts USING fts5(
  comment, content, key, keysecondary,
  content='world_book_entries',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TABLE world_books (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE, folder TEXT NOT NULL DEFAULT '');

CREATE INDEX idx_account_userId ON "account"(userId);

CREATE INDEX idx_agent_activity_runs_chat
  ON agent_activity_runs(user_id, chat_id, created_at DESC, id DESC);

CREATE INDEX idx_cc_chat_created_desc
  ON chat_chunks(chat_id, created_at DESC);

CREATE INDEX idx_cc_chat_range ON chat_chunks(chat_id, message_range_start, message_range_end);

CREATE INDEX idx_cc_chat_salience ON chat_chunks(chat_id, salience_score DESC);

CREATE INDEX idx_cc_chat_vectorized_created_desc
  ON chat_chunks(chat_id, created_at DESC)
  WHERE vectorized_at IS NOT NULL;

CREATE INDEX idx_cc_consolidation ON chat_chunks(consolidation_id);

CREATE INDEX idx_ccl_chat ON cortex_chat_links(chat_id);

CREATE INDEX idx_ccl_user ON cortex_chat_links(user_id);

CREATE INDEX idx_character_gallery_lookup
  ON character_gallery(user_id, character_id);

CREATE INDEX idx_characters_image_id ON characters(image_id);

CREATE INDEX idx_characters_user_id ON characters(user_id);

CREATE INDEX idx_characters_user_library_scope
  ON characters(user_id, library_scope);

CREATE INDEX idx_characters_user_library_scope_updated
  ON characters(user_id, library_scope, updated_at DESC);

CREATE INDEX idx_characters_user_updated ON characters(user_id, updated_at DESC);

CREATE INDEX idx_chat_chunks_chat ON chat_chunks(chat_id);

CREATE INDEX idx_chat_chunks_end_message ON chat_chunks(end_message_id);

CREATE INDEX idx_chat_chunks_vectorized ON chat_chunks(chat_id, vectorized_at);

CREATE INDEX idx_chats_character_id ON chats(character_id);

CREATE INDEX idx_chats_user_character ON chats(user_id, character_id, updated_at DESC);

CREATE INDEX idx_chats_user_id ON chats(user_id);

CREATE INDEX idx_chats_user_updated ON chats(user_id, updated_at DESC);

CREATE INDEX idx_cmc_chat_updated ON chat_memory_cache(chat_id, updated_at DESC);

CREATE INDEX idx_cmc_user_chat ON chat_memory_cache(user_id, chat_id);

CREATE INDEX idx_connection_profiles_user_id ON connection_profiles(user_id);

CREATE INDEX idx_connection_profiles_user_updated ON connection_profiles(user_id, updated_at DESC);

CREATE INDEX idx_cortex_vaults_user ON cortex_vaults(user_id);

CREATE INDEX idx_cvc_salience ON cortex_vault_chunks(vault_id, salience_score DESC);

CREATE INDEX idx_cvc_vault ON cortex_vault_chunks(vault_id);

CREATE INDEX idx_cve_vault ON cortex_vault_entities(vault_id);

CREATE INDEX idx_cvr_vault ON cortex_vault_relations(vault_id);

CREATE INDEX idx_databank_chunks_bank ON databank_chunks(databank_id);

CREATE INDEX idx_databank_chunks_doc ON databank_chunks(document_id);

CREATE INDEX idx_databank_chunks_user ON databank_chunks(user_id);

CREATE INDEX idx_databank_docs_bank ON databank_documents(databank_id);

CREATE INDEX idx_databank_docs_slug ON databank_documents(user_id, slug);

CREATE INDEX idx_databank_docs_user ON databank_documents(user_id);

CREATE INDEX idx_databanks_scope ON databanks(user_id, scope, scope_id);

CREATE INDEX idx_databanks_user ON databanks(user_id);

CREATE INDEX idx_dw_saved_prompts_user
  ON dream_weaver_saved_prompts(user_id, updated_at DESC);

CREATE INDEX idx_dw_sessions_status ON dream_weaver_sessions(user_id, status);

CREATE INDEX idx_dw_sessions_user ON dream_weaver_sessions(user_id, created_at DESC);

CREATE INDEX idx_extensions_install_scope ON extensions(install_scope);

CREATE INDEX idx_extensions_installed_by_user_id ON extensions(installed_by_user_id);

CREATE INDEX idx_global_addons_user ON global_addons(user_id);

CREATE INDEX idx_igc_default ON image_gen_connections(user_id, is_default);

CREATE INDEX idx_igc_user ON image_gen_connections(user_id);

CREATE INDEX idx_images_user_id ON images(user_id);

CREATE INDEX idx_loom_items_pack_id ON loom_items(pack_id);

CREATE INDEX idx_loom_tools_pack_id ON loom_tools(pack_id);

CREATE INDEX idx_lumia_items_pack_id ON lumia_items(pack_id);

CREATE INDEX idx_mc_chat_range ON memory_consolidations(chat_id, message_range_start, message_range_end);

CREATE INDEX idx_mc_chat_tier ON memory_consolidations(chat_id, tier);

CREATE INDEX idx_mc_vectorized ON memory_consolidations(chat_id, vectorized_at);

CREATE INDEX idx_mcp_servers_enabled ON mcp_servers(user_id, is_enabled);

CREATE INDEX idx_mcp_servers_user ON mcp_servers(user_id);

CREATE INDEX idx_me_chat ON memory_entities(chat_id);

CREATE INDEX idx_me_chat_active_mentions_desc
  ON memory_entities(chat_id, mention_count DESC)
  WHERE status != 'inactive';

CREATE INDEX idx_me_chat_mentions_desc
  ON memory_entities(chat_id, mention_count DESC);

CREATE INDEX idx_me_chat_name ON memory_entities(chat_id, name COLLATE NOCASE);

CREATE INDEX idx_me_chat_type ON memory_entities(chat_id, entity_type);

CREATE INDEX idx_me_confidence ON memory_entities(chat_id, confidence);

CREATE INDEX idx_me_fact_status ON memory_entities(chat_id, fact_extraction_status, salience_avg);

CREATE INDEX idx_me_status ON memory_entities(chat_id, status);

CREATE INDEX idx_message_breakdowns_chat ON message_breakdowns(chat_id);

CREATE INDEX idx_message_breakdowns_user ON message_breakdowns(user_id);

CREATE INDEX idx_messages_chat_id ON messages(chat_id);

CREATE INDEX idx_messages_chat_index ON messages(chat_id, index_in_chat);

CREATE INDEX idx_messages_last_assistant ON messages(chat_id, is_user, index_in_chat DESC);

CREATE INDEX idx_messages_parent ON messages(parent_message_id);

CREATE INDEX idx_mfc_chat ON memory_font_colors(chat_id);

CREATE INDEX idx_mfc_chat_color ON memory_font_colors(chat_id, hex_color);

CREATE INDEX idx_mfc_entity ON memory_font_colors(entity_id);

CREATE INDEX idx_mm_chat_entity ON memory_mentions(chat_id, entity_id);

CREATE INDEX idx_mm_chunk ON memory_mentions(chunk_id);

CREATE INDEX idx_mm_entity ON memory_mentions(entity_id);

CREATE UNIQUE INDEX idx_mm_entity_chunk ON memory_mentions(entity_id, chunk_id);

CREATE INDEX idx_mr_active_source_salience
  ON memory_relations(chat_id, source_entity_id, edge_salience DESC, strength DESC)
  WHERE status = 'active' AND superseded_by IS NULL AND merged_into IS NULL AND contradiction_flag != 'suspect';

CREATE INDEX idx_mr_active_target_salience
  ON memory_relations(chat_id, target_entity_id, edge_salience DESC, strength DESC)
  WHERE status = 'active' AND superseded_by IS NULL AND merged_into IS NULL AND contradiction_flag != 'suspect';

CREATE INDEX idx_mr_chat ON memory_relations(chat_id);

CREATE INDEX idx_mr_contradiction ON memory_relations(chat_id, contradiction_flag);

CREATE INDEX idx_mr_edge_salience ON memory_relations(chat_id, edge_salience);

CREATE INDEX idx_mr_merged ON memory_relations(merged_into);

CREATE UNIQUE INDEX idx_mr_pair_type ON memory_relations(source_entity_id, target_entity_id, relation_type);

CREATE INDEX idx_mr_source ON memory_relations(source_entity_id);

CREATE INDEX idx_mr_target ON memory_relations(target_entity_id);

CREATE INDEX idx_ms_chat ON memory_salience(chat_id);

CREATE INDEX idx_ms_chat_score ON memory_salience(chat_id, score DESC);

CREATE INDEX idx_ms_chunk ON memory_salience(chunk_id);

CREATE INDEX idx_packs_user_id ON packs(user_id);

CREATE INDEX idx_packs_user_updated ON packs(user_id, updated_at DESC);

CREATE INDEX idx_personas_attached_wb ON personas(attached_world_book_id);

CREATE INDEX idx_personas_image_id ON personas(image_id);

CREATE INDEX idx_personas_user_id ON personas(user_id);

CREATE INDEX idx_personas_user_updated ON personas(user_id, updated_at DESC);

CREATE INDEX idx_presets_user_id ON presets(user_id);

CREATE INDEX idx_presets_user_updated ON presets(user_id, updated_at DESC);

CREATE UNIQUE INDEX idx_push_subs_endpoint
  ON push_subscriptions(user_id, endpoint);

CREATE INDEX idx_push_subs_user
  ON push_subscriptions(user_id);

CREATE INDEX idx_query_cache_chat_hash ON query_vector_cache(chat_id, query_hash);

CREATE UNIQUE INDEX idx_query_cache_chat_hash_unique ON query_vector_cache(chat_id, query_hash);

CREATE INDEX idx_query_cache_expires ON query_vector_cache(expires_at);

CREATE INDEX idx_regex_scripts_character ON regex_scripts(character_id);

CREATE INDEX idx_regex_scripts_pack ON regex_scripts(pack_id);

CREATE INDEX idx_regex_scripts_preset ON regex_scripts(preset_id);

CREATE INDEX idx_regex_scripts_scope
  ON regex_scripts(user_id, scope, scope_id);

CREATE UNIQUE INDEX idx_regex_scripts_script_id
  ON regex_scripts(user_id, script_id)
  WHERE script_id != '';

CREATE INDEX idx_regex_scripts_user_sort
  ON regex_scripts(user_id, sort_order ASC, created_at ASC);

CREATE INDEX idx_secrets_user_id ON secrets(user_id);

CREATE INDEX idx_session_token ON "session"(token);

CREATE INDEX idx_session_userId ON "session"(userId);

CREATE INDEX idx_settings_user_id ON settings(user_id);

CREATE INDEX idx_theme_assets_image_id
  ON theme_assets(image_id);

CREATE INDEX idx_theme_assets_user_bundle
  ON theme_assets(user_id, bundle_id);

CREATE UNIQUE INDEX idx_theme_assets_user_bundle_slug
  ON theme_assets(user_id, bundle_id, slug);

CREATE INDEX idx_tokenizer_model_patterns_priority ON tokenizer_model_patterns(priority DESC);

CREATE INDEX idx_tokenizer_model_patterns_tokenizer ON tokenizer_model_patterns(tokenizer_id);

CREATE INDEX idx_ttsc_default ON tts_connections(user_id, is_default);

CREATE INDEX idx_ttsc_user ON tts_connections(user_id);

CREATE INDEX idx_wbe_world_book_id ON world_book_entries(world_book_id);

CREATE INDEX idx_wbe_world_book_vector_index_status
ON world_book_entries(world_book_id, vector_index_status);

CREATE INDEX idx_wbe_world_book_vectorized ON world_book_entries(world_book_id, vectorized);

CREATE INDEX idx_world_books_user_id ON world_books(user_id);

CREATE TRIGGER characters_fts_delete BEFORE DELETE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_insert AFTER INSERT ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;

CREATE TRIGGER characters_fts_update BEFORE UPDATE ON characters BEGIN
  INSERT INTO characters_fts(characters_fts, rowid, name, creator, tags)
    VALUES ('delete', old.rowid, old.name, old.creator, old.tags);
END;

CREATE TRIGGER characters_fts_update_after AFTER UPDATE ON characters BEGIN
  INSERT INTO characters_fts(rowid, name, creator, tags)
    VALUES (new.rowid, new.name, new.creator, new.tags);
END;

CREATE TRIGGER world_book_entries_fts_delete BEFORE DELETE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(world_book_entries_fts, rowid, comment, content, key, keysecondary)
    VALUES ('delete', old.rowid, old.comment, old.content, old.key, old.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_insert AFTER INSERT ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
    VALUES (new.rowid, new.comment, new.content, new.key, new.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_update BEFORE UPDATE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(world_book_entries_fts, rowid, comment, content, key, keysecondary)
    VALUES ('delete', old.rowid, old.comment, old.content, old.key, old.keysecondary);
END;

CREATE TRIGGER world_book_entries_fts_update_after AFTER UPDATE ON world_book_entries BEGIN
  INSERT INTO world_book_entries_fts(rowid, comment, content, key, keysecondary)
    VALUES (new.rowid, new.comment, new.content, new.key, new.keysecondary);
END;
CREATE TABLE IF NOT EXISTS agent_run_attempts (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  previous_attempt_id TEXT,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  generation_type TEXT NOT NULL CHECK(generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  target_message_id TEXT,
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0, 1)),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= 0),
  host_correlation_id TEXT NOT NULL CHECK(length(host_correlation_id) BETWEEN 1 AND 256),
  reconciliation_state TEXT NOT NULL DEFAULT 'authoritative' CHECK(reconciliation_state IN ('authoritative', 'reconciling', 'recovered', 'stale')),
  terminal_receipt_json TEXT CHECK(terminal_receipt_json IS NULL OR length(terminal_receipt_json) <= 16384),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version = 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, attempt_id),
  UNIQUE(user_id, run_id),
  UNIQUE(user_id, host_correlation_id),
  FOREIGN KEY (user_id, previous_attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE SET NULL,
  FOREIGN KEY (target_message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_chat_updated
  ON agent_run_attempts(user_id, chat_id, updated_at DESC, attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_chat_target
  ON agent_run_attempts(user_id, chat_id, target_message_id, target_swipe_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_previous
  ON agent_run_attempts(user_id, previous_attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_terminal
  ON agent_run_attempts(user_id, chat_id, terminal, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_audit_records (
  record_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('transcript', 'turn_session', 'activity', 'marker', 'usage', 'prompt', 'cortex', 'council', 'workspace', 'stop', 'recovery')),
  event_id TEXT,
  causal_parent_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  late INTEGER NOT NULL DEFAULT 0 CHECK(late IN (0, 1)),
  payload_json TEXT NOT NULL CHECK(length(payload_json) <= 131072),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0 AND byte_size <= 131072),
  dedupe_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_attempt_sequence
  ON agent_run_audit_records(user_id, attempt_id, host_sequence, record_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_audit_chat_time
  ON agent_run_audit_records(user_id, chat_id, occurred_at, record_id);

CREATE TABLE IF NOT EXISTS agent_run_turn_session_entries (
  entry_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK(entry_kind IN ('target', 'input', 'policy', 'condition', 'hook', 'cancellation', 'completion', 'commit', 'terminal', 'retry', 'recovery')),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  detail_json TEXT NOT NULL CHECK(length(detail_json) <= 65536),
  transcript_links_json TEXT NOT NULL DEFAULT '[]' CHECK(length(transcript_links_json) <= 8192),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, host_sequence, entry_kind)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_turn_session_entries_order
  ON agent_run_turn_session_entries(user_id, attempt_id, host_sequence, entry_id);

CREATE TABLE IF NOT EXISTS agent_run_activity_nodes (
  node_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  parent_node_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('root', 'provider', 'child', 'tool', 'milestone')),
  actor TEXT NOT NULL CHECK(actor IN ('host', 'owner', 'provider', 'agent', 'child', 'tool')),
  phase TEXT NOT NULL CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal', 'omitted')),
  safe_label TEXT NOT NULL CHECK(length(safe_label) BETWEEN 1 AND 256),
  tool_id TEXT,
  task_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  ended_at INTEGER CHECK(ended_at IS NULL OR ended_at >= started_at),
  elapsed_ms INTEGER CHECK(elapsed_ms IS NULL OR elapsed_ms >= 0),
  usage_json TEXT CHECK(usage_json IS NULL OR length(usage_json) <= 8192),
  detail_json TEXT CHECK(detail_json IS NULL OR length(detail_json) <= 16384),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_activity_nodes_order
  ON agent_run_activity_nodes(user_id, attempt_id, host_sequence, node_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_activity_nodes_target
  ON agent_run_activity_nodes(user_id, chat_id, attempt_id, kind, host_sequence);

CREATE TABLE IF NOT EXISTS agent_run_inspection_markers (
  marker_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  marker_kind TEXT NOT NULL CHECK(marker_kind IN ('reconnect_gap', 'late_event', 'reordered_event', 'truncated', 'unavailable', 'credentials_withheld', 'other_user_data_withheld', 'recovered_duplicate')),
  scope TEXT NOT NULL CHECK(scope IN ('run', 'activity', 'transcript', 'turn_session', 'usage', 'prompt', 'cortex', 'council', 'workspace')),
  host_sequence INTEGER,
  first_sequence INTEGER,
  last_sequence INTEGER,
  recoverable INTEGER CHECK(recoverable IS NULL OR recoverable IN (0, 1)),
  detail TEXT CHECK(detail IS NULL OR length(detail) <= 2048),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, marker_kind, scope, host_sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_inspection_markers_order
  ON agent_run_inspection_markers(user_id, attempt_id, COALESCE(host_sequence, 0), marker_id);

CREATE TABLE IF NOT EXISTS agent_run_usage_evidence (
  usage_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('provider_reported', 'provisional', 'final', 'recovered_duplicate')),
  actor_id TEXT,
  phase TEXT,
  tool_id TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls >= 0),
  child_invocations INTEGER NOT NULL DEFAULT 0 CHECK(child_invocations >= 0),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, usage_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_usage_attempt
  ON agent_run_usage_evidence(user_id, attempt_id, host_sequence, usage_id);

CREATE TABLE IF NOT EXISTS agent_run_prompt_evidence (
  prompt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  destination TEXT NOT NULL CHECK(destination IN ('root_work', 'child_work', 'completion_handoff', 'render', 'council', 'cortex')),
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool', 'context', 'policy')),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  included INTEGER NOT NULL CHECK(included IN (0, 1)),
  content TEXT NOT NULL CHECK(length(content) <= 65536),
  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
  omission_reason TEXT CHECK(omission_reason IS NULL OR length(omission_reason) <= 512),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, prompt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_prompt_attempt
  ON agent_run_prompt_evidence(user_id, attempt_id, host_sequence, prompt_id);

CREATE TABLE IF NOT EXISTS agent_run_cortex_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'omitted', 'failed', 'cancelled')),
  result_digest TEXT,
  result_count INTEGER NOT NULL DEFAULT 0 CHECK(result_count >= 0),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_cortex_attempt
  ON agent_run_cortex_receipts(user_id, attempt_id, host_sequence, receipt_id);

CREATE TABLE IF NOT EXISTS agent_run_council_receipts (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'omitted', 'failed', 'cancelled')),
  member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count >= 0),
  result_digest TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 512),
  canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_council_attempt
  ON agent_run_council_receipts(user_id, attempt_id, host_sequence, receipt_id);

CREATE TABLE IF NOT EXISTS agent_run_workspace_associations (
  association_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 0),
  relation TEXT NOT NULL CHECK(relation IN ('linked', 'published', 'omitted')),
  object_kind TEXT NOT NULL CHECK(object_kind IN ('objective', 'task', 'finding', 'decision', 'question', 'submission', 'artifact', 'publication')),
  object_id TEXT,
  source_revision INTEGER,
  source_deleted INTEGER NOT NULL DEFAULT 0 CHECK(source_deleted IN (0, 1)),
  provenance_digest TEXT,
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id, attempt_id) REFERENCES agent_run_attempts(user_id, attempt_id) ON DELETE CASCADE,
  UNIQUE(user_id, attempt_id, association_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_workspace_associations_attempt
  ON agent_run_workspace_associations(user_id, attempt_id, host_sequence, association_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_workspace_associations_workspace
  ON agent_run_workspace_associations(user_id, workspace_id, workspace_revision);

CREATE TABLE persistent_workspaces (
  workspace_id TEXT PRIMARY KEY CHECK(length(workspace_id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  objective TEXT NOT NULL DEFAULT '' CHECK(length(objective) <= 65536),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(length(metadata_json) <= 32768 AND json_valid(metadata_json)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(length(progress_json) <= 16384 AND json_valid(progress_json)),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  quota_tasks INTEGER NOT NULL DEFAULT 256 CHECK(quota_tasks BETWEEN 0 AND 256),
  quota_records INTEGER NOT NULL DEFAULT 1024 CHECK(quota_records BETWEEN 0 AND 1024),
  quota_submissions INTEGER NOT NULL DEFAULT 1024 CHECK(quota_submissions BETWEEN 0 AND 1024),
  quota_artifacts INTEGER NOT NULL DEFAULT 256 CHECK(quota_artifacts BETWEEN 0 AND 256),
  quota_publications INTEGER NOT NULL DEFAULT 512 CHECK(quota_publications BETWEEN 0 AND 512),
  quota_bytes INTEGER NOT NULL DEFAULT 4194304 CHECK(quota_bytes BETWEEN 0 AND 4194304),
  task_count INTEGER NOT NULL DEFAULT 0 CHECK(task_count >= 0),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count >= 0),
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK(submission_count >= 0),
  artifact_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_count >= 0),
  publication_count INTEGER NOT NULL DEFAULT 0 CHECK(publication_count >= 0),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, workspace_id),
  UNIQUE(user_id, chat_id)
);

CREATE TABLE persistent_workspace_turn_sessions (
  turn_session_id TEXT PRIMARY KEY CHECK(length(turn_session_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
  execution_id TEXT CHECK(execution_id IS NULL OR length(execution_id) BETWEEN 1 AND 128),
  phase TEXT NOT NULL DEFAULT 'ADMIT' CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  terminal_at INTEGER,
  UNIQUE(user_id, turn_id, attempt_id),
  UNIQUE(workspace_id, turn_id, attempt_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE persistent_workspace_tasks (
  task_id TEXT PRIMARY KEY CHECK(length(task_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 4096),
  objective TEXT NOT NULL DEFAULT '' CHECK(length(objective) <= 65536),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')),
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
  dependency_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(length(dependency_ids_json) <= 65536 AND json_valid(dependency_ids_json)),
  creator TEXT NOT NULL DEFAULT 'owner' CHECK(creator IN ('host', 'owner')),
  host_admitted INTEGER NOT NULL DEFAULT 0 CHECK(host_admitted IN (0, 1)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(length(progress_json) <= 16384 AND json_valid(progress_json)),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 16384),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, task_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE,
  CHECK(
    (creator = 'owner' AND host_admitted = 0 AND required = 0)
    OR (creator = 'host' AND host_admitted = 1)
  )
);

CREATE TABLE persistent_workspace_records (
  record_id TEXT PRIMARY KEY CHECK(length(record_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('finding', 'decision', 'question')),
  content_json TEXT NOT NULL CHECK(length(content_json) <= 65536 AND json_valid(content_json)),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
  task_id TEXT,
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, record_id),
  UNIQUE(workspace_id, kind, summary),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES persistent_workspace_tasks(task_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE persistent_workspace_submissions (
  submission_id TEXT PRIMARY KEY CHECK(length(submission_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  state TEXT NOT NULL DEFAULT 'submitted' CHECK(state IN ('submitted', 'accepted', 'rejected')),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 65536),
  result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 4194304),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, submission_id),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES persistent_workspace_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE persistent_workspace_artifacts (
  artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  turn_session_id TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  blob_digest TEXT NOT NULL CHECK(length(blob_digest) = 64 AND blob_digest GLOB '[0-9a-fA-F]*'),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 4194304),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(length(provenance_json) <= 16384 AND json_valid(provenance_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, artifact_id),
  UNIQUE(workspace_id, blob_digest),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_session_id) REFERENCES persistent_workspace_turn_sessions(turn_session_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE persistent_workspace_publications (
  publication_id TEXT PRIMARY KEY CHECK(length(publication_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('task', 'finding', 'objective', 'artifact')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  source_provenance_json TEXT NOT NULL CHECK(length(source_provenance_json) <= 16384 AND json_valid(source_provenance_json)),
  source_created_at INTEGER NOT NULL CHECK(source_created_at >= 0),
  source_updated_at INTEGER NOT NULL CHECK(source_updated_at >= 0),
  source_deleted_at INTEGER,
  copy_json TEXT NOT NULL CHECK(length(copy_json) <= 131072 AND json_valid(copy_json)),
  copy_digest TEXT NOT NULL CHECK(length(copy_digest) = 64 AND copy_digest GLOB '[0-9a-fA-F]*'),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND 4194304),
  published_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_by TEXT NOT NULL CHECK(length(published_by) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision = 1),
  UNIQUE(workspace_id, category, source_id, source_revision),
  FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_persistent_workspaces_chat ON persistent_workspaces(user_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_sessions_turn ON persistent_workspace_turn_sessions(user_id, chat_id, turn_id, attempt_id);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_tasks_state ON persistent_workspace_tasks(user_id, chat_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_records_kind ON persistent_workspace_records(user_id, chat_id, workspace_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_submissions_state ON persistent_workspace_submissions(user_id, chat_id, workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_artifacts_digest ON persistent_workspace_artifacts(user_id, chat_id, workspace_id, blob_digest);
CREATE INDEX IF NOT EXISTS idx_persistent_workspace_publications_source ON persistent_workspace_publications(user_id, chat_id, workspace_id, category, source_id, source_revision);

CREATE TRIGGER trg_persistent_workspace_publications_immutable_update
BEFORE UPDATE ON persistent_workspace_publications
WHEN NOT (
  NEW.publication_id IS OLD.publication_id
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.user_id IS OLD.user_id
  AND NEW.category IS OLD.category
  AND NEW.source_id IS OLD.source_id
  AND NEW.source_revision IS OLD.source_revision
  AND NEW.source_created_at IS OLD.source_created_at
  AND NEW.source_updated_at IS OLD.source_updated_at
  AND NEW.copy_json IS OLD.copy_json
  AND NEW.copy_digest IS OLD.copy_digest
  AND NEW.byte_count IS OLD.byte_count
  AND NEW.published_at IS OLD.published_at
  AND NEW.published_by IS OLD.published_by
  AND NEW.revision IS OLD.revision
  AND (
    (
      OLD.chat_id IS NOT NULL
      AND NEW.chat_id IS NULL
      AND NEW.source_provenance_json IS OLD.source_provenance_json
      AND NEW.source_deleted_at IS OLD.source_deleted_at
    )
    OR (
      NEW.chat_id IS OLD.chat_id
      AND OLD.source_deleted_at IS NULL
      AND NEW.source_deleted_at IS NOT NULL
      AND NEW.source_provenance_json IS NOT OLD.source_provenance_json
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'persistent workspace publications are immutable');
END;
CREATE TRIGGER trg_persistent_workspaces_archive_on_detach
AFTER UPDATE OF chat_id ON persistent_workspaces
WHEN OLD.chat_id IS NOT NULL AND NEW.chat_id IS NULL
BEGIN
  UPDATE persistent_workspaces
     SET state = 'archived',
         revision = revision + 1,
         updated_at = unixepoch()
   WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER trg_persistent_workspace_detach_children_on_chat_delete
AFTER DELETE ON chats
BEGIN
  UPDATE persistent_workspace_tasks
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_records
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_submissions
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_artifacts
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
  UPDATE persistent_workspace_publications
     SET chat_id = NULL
   WHERE chat_id = OLD.id;
END;
CREATE TABLE agent_runtime_repair_acknowledgements (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  preset_revision TEXT NOT NULL CHECK(length(preset_revision) BETWEEN 1 AND 512),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at >= 0),
  PRIMARY KEY (user_id, preset_id, preset_revision, reason_code)
);

CREATE INDEX idx_agent_runtime_repair_ack_preset_revision
  ON agent_runtime_repair_acknowledgements(user_id, preset_id, preset_revision, acknowledged_at DESC);

CREATE TABLE agent_run_source_deletions (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  previous_attempt_id TEXT CHECK(previous_attempt_id IS NULL OR length(previous_attempt_id) BETWEEN 1 AND 256),
  chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 256),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('chat', 'message', 'swipe')),
  target_message_id TEXT CHECK(target_message_id IS NULL OR length(target_message_id) BETWEEN 1 AND 256),
  target_swipe_id INTEGER CHECK(target_swipe_id IS NULL OR target_swipe_id >= 0),
  run_id TEXT CHECK(run_id IS NULL OR length(run_id) BETWEEN 1 AND 256),
  turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
  generation_id TEXT CHECK(generation_id IS NULL OR length(generation_id) BETWEEN 1 AND 256),
  generation_type TEXT CHECK(generation_type IS NULL OR generation_type IN ('normal', 'continue', 'regenerate', 'swipe')),
  lifecycle TEXT CHECK(lifecycle IS NULL OR lifecycle IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
  status TEXT CHECK(status IS NULL OR status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
  terminal INTEGER CHECK(terminal IS NULL OR terminal IN (0, 1)),
  attempt_reason TEXT CHECK(attempt_reason IS NULL OR length(attempt_reason) <= 128),
  started_at INTEGER CHECK(started_at IS NULL OR started_at >= 0),
  updated_at INTEGER CHECK(updated_at IS NULL OR updated_at >= 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= 0),
  host_correlation_id TEXT CHECK(host_correlation_id IS NULL OR length(host_correlation_id) BETWEEN 1 AND 256),
  reconciliation_state TEXT CHECK(reconciliation_state IS NULL OR reconciliation_state IN ('authoritative', 'reconciling', 'recovered', 'stale')),
  attempt_version INTEGER CHECK(attempt_version IS NULL OR attempt_version >= 1),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  source_deleted_at INTEGER NOT NULL CHECK(source_deleted_at >= 0),
  reason TEXT NOT NULL DEFAULT 'source_deleted' CHECK(reason = 'source_deleted'),
  activity_json TEXT NOT NULL DEFAULT '[]' CHECK(length(activity_json) <= 65536 AND json_valid(activity_json)),
  usage_json TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"totalTokens":0,"toolCalls":0,"childInvocations":0}' CHECK(length(usage_json) <= 4096 AND json_valid(usage_json)),
  PRIMARY KEY(user_id, attempt_id),
  CHECK(target_swipe_id IS NULL OR target_message_id IS NOT NULL),
  CHECK(source_kind = 'chat' OR target_message_id IS NOT NULL),
  CHECK(source_kind <> 'swipe' OR target_swipe_id IS NOT NULL)
);
CREATE TRIGGER trg_agent_run_attempts_reject_source_deleted
BEFORE INSERT ON agent_run_attempts
WHEN EXISTS (
  SELECT 1
    FROM agent_run_source_deletions
   WHERE user_id = NEW.user_id AND attempt_id = NEW.attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent run attempt source was deleted');
END;

CREATE INDEX idx_agent_run_source_deletions_chat
  ON agent_run_source_deletions(user_id, chat_id, source_kind, target_message_id, target_swipe_id);
CREATE INDEX idx_agent_run_source_deletions_attempt
  ON agent_run_source_deletions(user_id, attempt_id);
CREATE TABLE agent_run_source_deletion_workspace (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  association_id TEXT NOT NULL CHECK(length(association_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision >= 0),
  relation TEXT NOT NULL CHECK(relation IN ('linked', 'published', 'omitted')),
  object_kind TEXT NOT NULL CHECK(object_kind IN ('objective', 'task', 'finding', 'decision', 'question', 'submission', 'artifact', 'publication')),
  object_id TEXT CHECK(object_id IS NULL OR length(object_id) BETWEEN 1 AND 256),
  source_revision INTEGER CHECK(source_revision IS NULL OR source_revision >= 0),
  source_deleted INTEGER NOT NULL CHECK(source_deleted IN (0, 1)),
  provenance_digest TEXT CHECK(provenance_digest IS NULL OR length(provenance_digest) = 64),
  host_sequence INTEGER NOT NULL CHECK(host_sequence >= 0),
  PRIMARY KEY(user_id, attempt_id, association_id)
);
CREATE INDEX idx_agent_run_source_deletion_workspace_attempt
  ON agent_run_source_deletion_workspace(user_id, attempt_id, host_sequence, association_id);
