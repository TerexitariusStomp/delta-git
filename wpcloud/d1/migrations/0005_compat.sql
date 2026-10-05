-- Effective-100% plugin compatibility: variant matrix per site

-- site variant selection (auto-set by compat classifier)
ALTER TABLE sites ADD COLUMN sapi TEXT NOT NULL DEFAULT 'frankenphp';   -- frankenphp|apache
ALTER TABLE sites ADD COLUMN php_version TEXT NOT NULL DEFAULT '8.4';   -- image tag track
ALTER TABLE sites ADD COLUMN db_engine TEXT NOT NULL DEFAULT 'sqlite';  -- sqlite|mariadb|mysql8
ALTER TABLE sites ADD COLUMN multisite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN daemons INTEGER NOT NULL DEFAULT 0;        -- count of supervised plugin daemons
ALTER TABLE sites ADD COLUMN tcp_ingress INTEGER NOT NULL DEFAULT 0;    -- needs public TCP (Spectrum tier)
ALTER TABLE sites ADD COLUMN cron_wake_at INTEGER;                      -- next wp-cron due (DO alarm wake)
ALTER TABLE sites ADD COLUMN agent_token TEXT;                          -- machine auth for in-container agent

-- crowdsourced plugin verdict cache — first scan of a slug benefits everyone
CREATE TABLE plugin_compat (
  slug TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,          -- JSON: {db, sapi, php_version, daemons, tcp_ingress, sidecars[], multisite, reason}
  scanned_at INTEGER NOT NULL,
  scanner_version INTEGER NOT NULL DEFAULT 1
);

-- sidecar containers attached to a site
CREATE TABLE site_sidecars (
  site_id TEXT NOT NULL REFERENCES sites(id),
  type TEXT NOT NULL,             -- mariadb|mysql8|redis|elastic|memcached
  port INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning', -- provisioning|running|failed
  PRIMARY KEY (site_id, type)
);
