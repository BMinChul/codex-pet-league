-- Codex Pet League PostgreSQL schema.
-- migrate:up
BEGIN;

CREATE TABLE IF NOT EXISTS league_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS league_state_snapshots (
  id BIGSERIAL PRIMARY KEY,
  state_json JSONB NOT NULL,
  state_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  identifier TEXT UNIQUE,
  email TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',
  verified BOOLEAN NOT NULL DEFAULT false,
  auth_methods JSONB NOT NULL DEFAULT '[]'::jsonb,
  enforcement_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL,
  client_ip_hash TEXT,
  device_hash TEXT,
  user_agent_hash TEXT,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  identifier TEXT NOT NULL,
  code_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  ranked_seed_lp INTEGER NOT NULL,
  placement_matches INTEGER NOT NULL,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  canonical_hash TEXT NOT NULL,
  atlas_object_key TEXT,
  atlas_sha256 TEXT,
  atlas_byte_length INTEGER,
  manifest_json JSONB NOT NULL,
  appearance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  asset_status TEXT NOT NULL DEFAULT 'active',
  safety_status TEXT NOT NULL DEFAULT 'clear',
  visibility TEXT NOT NULL DEFAULT 'public',
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pets (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  bound_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pet_asset_id TEXT NOT NULL REFERENCES assets(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  primary_element TEXT NOT NULL,
  secondary_element TEXT,
  level INTEGER NOT NULL DEFAULT 1,
  mastery_level INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  style_xp INTEGER NOT NULL DEFAULT 0,
  stats_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  battle_class TEXT NOT NULL,
  skills_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  skill_aliases_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  rating_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  cosmetics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_report_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary_hash TEXT,
  workspace_hash TEXT,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS training_reports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  client_report_id TEXT NOT NULL,
  status TEXT NOT NULL,
  report_type TEXT NOT NULL,
  summary_hash TEXT,
  workspace_hash TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0,
  pet_xp_delta INTEGER NOT NULL DEFAULT 0,
  style_xp_delta INTEGER NOT NULL DEFAULT 0,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, client_report_id)
);

CREATE TABLE IF NOT EXISTS xp_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  pet_xp_delta INTEGER NOT NULL DEFAULT 0,
  style_xp_delta INTEGER NOT NULL DEFAULT 0,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lp_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  battle_room_id TEXT,
  lp_delta INTEGER NOT NULL DEFAULT 0,
  previous_lp INTEGER NOT NULL,
  next_lp INTEGER NOT NULL,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS battle_rooms (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  turn_index INTEGER NOT NULL DEFAULT 1,
  turn_nonce TEXT,
  player_a_account_id TEXT REFERENCES accounts(id),
  player_b_account_id TEXT REFERENCES accounts(id),
  player_a_pet_id TEXT REFERENCES pets(id),
  player_b_pet_id TEXT REFERENCES pets(id),
  replay_hash TEXT,
  result_signature TEXT,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY,
  battle_room_id TEXT REFERENCES battle_rooms(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  pet_id TEXT REFERENCES pets(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  result TEXT NOT NULL,
  pet_xp_delta INTEGER NOT NULL DEFAULT 0,
  lp_delta INTEGER NOT NULL DEFAULT 0,
  replay_hash TEXT,
  result_signature TEXT,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_tickets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  battle_class TEXT NOT NULL,
  lp INTEGER NOT NULL,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  matched_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS friend_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  creator_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  creator_pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS asset_reports (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  reporter_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  pet_id TEXT REFERENCES pets(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  actor_key TEXT NOT NULL,
  route_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  window_starts_at TIMESTAMPTZ NOT NULL,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  route_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, route_key, request_id)
);

CREATE TABLE IF NOT EXISTS abuse_alerts (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ops_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  document_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS season_rewards (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pet_id TEXT REFERENCES pets(id) ON DELETE SET NULL,
  reward_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS realtime_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_identifier ON accounts(identifier);
CREATE INDEX IF NOT EXISTS idx_sessions_account_expires ON sessions(account_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_identifier ON auth_challenges(identifier, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_account_id, safety_status, visibility);
CREATE INDEX IF NOT EXISTS idx_pets_owner_status ON pets(owner_account_id, status);
CREATE INDEX IF NOT EXISTS idx_training_reports_pet_created ON training_reports(pet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_pet_applied ON xp_ledger(pet_id, applied_at);
CREATE INDEX IF NOT EXISTS idx_lp_ledger_pet_applied ON lp_ledger(pet_id, applied_at);
CREATE INDEX IF NOT EXISTS idx_battle_rooms_status_turn ON battle_rooms(status, turn_index, updated_at);
CREATE INDEX IF NOT EXISTS idx_battles_pet_created ON battles(pet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_match_tickets_queue ON match_tickets(status, mode, battle_class, lp, created_at);
CREATE INDEX IF NOT EXISTS idx_friend_invites_code_status ON friend_invites(code_hash, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_asset_reports_asset_status ON asset_reports(asset_id, status);
CREATE INDEX IF NOT EXISTS idx_risk_events_account_created ON risk_events(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_actor_route ON rate_limits(actor_key, route_key, window_starts_at);
CREATE INDEX IF NOT EXISTS idx_abuse_alerts_status_created ON abuse_alerts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_realtime_outbox_unpublished ON realtime_outbox(created_at) WHERE published_at IS NULL;

COMMIT;

-- migrate:down
BEGIN;

DROP TABLE IF EXISTS realtime_outbox;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS season_rewards;
DROP TABLE IF EXISTS ops_jobs;
DROP TABLE IF EXISTS abuse_alerts;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS risk_events;
DROP TABLE IF EXISTS asset_reports;
DROP TABLE IF EXISTS friend_invites;
DROP TABLE IF EXISTS match_tickets;
DROP TABLE IF EXISTS battles;
DROP TABLE IF EXISTS battle_rooms;
DROP TABLE IF EXISTS lp_ledger;
DROP TABLE IF EXISTS xp_ledger;
DROP TABLE IF EXISTS training_reports;
DROP TABLE IF EXISTS training_report_drafts;
DROP TABLE IF EXISTS pets;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS seasons;
DROP TABLE IF EXISTS auth_challenges;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS league_state_snapshots;
DROP TABLE IF EXISTS league_schema_migrations;

COMMIT;
