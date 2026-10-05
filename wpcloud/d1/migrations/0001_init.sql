-- wp-cloud v1 schema
CREATE TABLE users (
  did TEXT PRIMARY KEY,              -- did:pkh:eip155:8453:0x...  (SIWE identity)
  deposit_salt INTEGER NOT NULL UNIQUE, -- cents-salt for amount-salt USDC attribution
  created_at INTEGER NOT NULL
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  owner_did TEXT NOT NULL REFERENCES users(did),
  lane INTEGER NOT NULL DEFAULT 1,   -- 1=static, 2=wasm, 3=container
  status TEXT NOT NULL DEFAULT 'active', -- active|suspended|archived
  manifest_sha TEXT,                 -- current published manifest
  preview_host TEXT UNIQUE,
  lease_expires_at INTEGER,          -- preview TTL (epoch s); NULL = owned domain
  created_at INTEGER NOT NULL
);

CREATE TABLE manifests (
  site_id TEXT NOT NULL REFERENCES sites(id),
  sha TEXT NOT NULL,                 -- content-addressed manifest hash
  file_count INTEGER NOT NULL,
  bytes_total INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, sha)
);

CREATE TABLE credits (
  user_did TEXT PRIMARY KEY REFERENCES users(did),
  balance_micro INTEGER NOT NULL DEFAULT 0, -- micro-USDC (6dp)
  updated_at INTEGER NOT NULL
);

CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_did TEXT NOT NULL REFERENCES users(did),
  txhash TEXT UNIQUE,                -- NULL for debits/refunds
  amount_micro INTEGER NOT NULL,     -- +credit / -debit
  kind TEXT NOT NULL,                -- deposit|debit|refund
  memo TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_did TEXT NOT NULL REFERENCES users(did),
  amount_salt TEXT NOT NULL,         -- requested top-up amount e.g. "10.042"
  status TEXT NOT NULL DEFAULT 'pending', -- pending|filled|expired
  txhash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  post_path TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sites_host ON sites(preview_host);
CREATE INDEX idx_ledger_user ON ledger(user_did);
CREATE INDEX idx_comments_site ON comments(site_id, post_path, status);
