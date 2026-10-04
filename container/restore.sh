#!/usr/bin/env bash
set -uo pipefail
STATE_DIR=${STATE_DIR:-/state}
R2_REMOTE=${R2_REMOTE:-r2:wpcloud-state/${SITE_ID:-unknown}}
mkdir -p "$STATE_DIR"
rclone copy "$R2_REMOTE" "$STATE_DIR" --exclude ".versions/**" --exclude "wp-content/**" --transfers 8 --checkers 8
# overlay saved wp-content over image defaults (user plugins/themes/uploads win)
rclone copy "$R2_REMOTE/wp-content" /srv/site/wp-content --transfers 8 --checkers 8 2>/dev/null || true
# reimport MariaDB dump if present
if [ -f "$STATE_DIR/mysql-dump.sql" ] && command -v mariadb >/dev/null && mariadb-admin -h 127.0.0.1 ping >/dev/null 2>&1; then
  mariadb -h 127.0.0.1 < "$STATE_DIR/mysql-dump.sql" 2>/dev/null || true
fi
