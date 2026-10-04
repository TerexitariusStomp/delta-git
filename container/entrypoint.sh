#!/usr/bin/env bash
set -euo pipefail

SITE_DIR=/srv/site
STATE_DIR=/state            # mounted/ephemeral site state (sqlite db, wp-content/uploads)
R2_REMOTE="${R2_REMOTE:-r2:wpcloud-state/${SITE_ID:-unknown}}"

# rclone config from env (credentials injected by TenantDO at boot)
mkdir -p /root/.config/rclone
cat > /root/.config/rclone/rclone.conf <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_KEY_ID:-}
secret_access_key = ${R2_KEY_SECRET:-}
endpoint = https://${R2_ACCOUNT_ID:-}.r2.cloudflarestorage.com
EOF

# 1. Restore prior state if present (zero-loss wake)
mkdir -p "$STATE_DIR"
if rclone lsf "$R2_REMOTE" --max-depth 1 2>/dev/null | grep -q .; then
  echo "[entrypoint] restoring state from $R2_REMOTE"
  rclone copy "$R2_REMOTE" "$STATE_DIR" --transfers 8 --checkers 8
fi

# 2. WP bootstrap if fresh
if [ ! -f "$SITE_DIR/wp-config.php" ]; then
  cd "$SITE_DIR"
  wp core config --dbname=site --dbuser=wp --dbhost=file://$STATE_DIR/db.sqlite --dbprefix=wp_ \
      --extra-php <<'PHP' --allow-root
define('WP_ENVIRONMENT_TYPE', 'production');
define('DISALLOW_FILE_EDIT', true);
define('S3_UPLOADS_BUCKET', getenv('S3_BUCKET') ?: '');
define('S3_UPLOADS_REGION', 'auto');
define('S3_UPLOADS_KEY', getenv('R2_KEY_ID') ?: '');
define('S3_UPLOADS_SECRET', getenv('R2_KEY_SECRET') ?: '');
define('S3_UPLOADS_ENDPOINT', 'https://' . (getenv('R2_ACCOUNT_ID') ?: '') . '.r2.cloudflarestorage.com');
if (getenv('CURATED')) define('DISALLOW_FILE_MODS', true); // Lane 2: no arbitrary code
PHP
  wp db create --allow-root || true
  wp core install --url="${SITE_URL:-http://localhost}" --title="${SITE_TITLE:-wp-cloud site}" \
      --admin_user="${WP_ADMIN_USER:-admin}" --admin_password="${WP_ADMIN_PASS:-$(openssl rand -hex 8)}" \
      --admin_email="${WP_ADMIN_EMAIL:-admin@wp-cloud}" --allow-root
  wp plugin activate sqlite-database-integration s3-uploads fluent-smtp --allow-root || true
fi

# Lane 2 curation: deactivate anything outside the whitelist
if [ "${CURATED:-}" = "1" ]; then
  cd "$SITE_DIR"
  wp plugin list --field=name --allow-root 2>/dev/null | while read -r p; do
    case "|${CURATED_PLUGINS:-sqlite-database-integration s3-uploads fluent-smtp sqlite-object-cache contact-form-7 wpforms-lite wordpress-seo akismet simply-static}|" in
      *"$p"*) : ;;
      *) wp plugin deactivate "$p" --allow-root 2>/dev/null || true ;;
    esac
  done
fi

# 3. scheduled tasks: WP-Cron every 5 min + hourly sync-out (not traffic-dependent)
cat > /etc/crontabs/root <<EOF
*/5 * * * * cd $SITE_DIR && wp cron event run --due-now --allow-root >/dev/null 2>&1
0 * * * * /usr/local/bin/sync-out.sh >> /var/log/sync.log 2>&1
EOF
crond -b -l 2

# 4. agent API + dev shell + adminer
webhook -hooks /etc/webhook/hooks.json -port 8080 -verbose &
ttyd -p 7681 -W bash &

# 5. serve — FrankenPHP worker mode keeps WP hot in memory
exec frankenphp run --config /etc/frankenphp/Caddyfile
