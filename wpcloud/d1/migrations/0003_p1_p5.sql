-- P1–P5 schema additions
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'creator';
ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by TEXT;
ALTER TABLE sites ADD COLUMN custom_domain TEXT;
ALTER TABLE sites ADD COLUMN source TEXT NOT NULL DEFAULT 'new'; -- new|fork|import|clone

CREATE TABLE domains (
  fqdn TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  user_did TEXT NOT NULL REFERENCES users(did),
  status TEXT NOT NULL DEFAULT 'pending', -- pending|active|failed
  price_micro INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE health (
  site_id TEXT PRIMARY KEY REFERENCES sites(id),
  last_ok_at INTEGER,
  last_status INTEGER,
  consecutive_fails INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_did TEXT NOT NULL,
  site_id TEXT,
  action TEXT NOT NULL,          -- site.create|publish|rollback|suspend|fork|domain.buy|topup|debit
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_user ON audit(user_did, created_at);
