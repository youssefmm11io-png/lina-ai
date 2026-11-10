CREATE TABLE IF NOT EXISTS agent_codes (
  code TEXT PRIMARY KEY NOT NULL CHECK(length(code) = 22),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redeemed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_codes_expiry ON agent_codes(expires_at);
