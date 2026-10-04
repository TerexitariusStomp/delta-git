#!/usr/bin/env bash
# Zero-loss checkpoint: DB + wp-content → R2 (deduped via rclone copy + --backup-dir versioning)
set -uo pipefail
STATE_DIR=${STATE_DIR:-/state}
R2_REMOTE=${R2_REMOTE:-r2:wpcloud-state/${SITE_ID:-unknown}}
TS=$(date +%Y%m%d-%H%M%S)

# SQLite-safe copy: checkpoint WAL first
sqlite3 "$STATE_DIR/db.sqlite" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
rclone copy "$STATE_DIR" "$R2_REMOTE" --backup-dir "$R2_REMOTE/.versions/$TS" --transfers 8 --checkers 8
# prune old versions beyond 7 (keep storage bounded)
rclone lsf "$R2_REMOTE/.versions" --dirs-only 2>/dev/null | sort -r | tail -n +8 | while read -r d; do
  rclone purge "$R2_REMOTE/.versions/$d" || true
done
