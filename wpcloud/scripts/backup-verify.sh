#!/usr/bin/env bash
# DR drill (P4): verify a site's R2 state backup restores cleanly.
set -euo pipefail
SITE_ID=${1:?usage: backup-verify.sh <site_id>}
TMP=$(mktemp -d)
rclone copy "r2:wpcloud-state/$SITE_ID" "$TMP" --exclude ".versions/**"
test -f "$TMP/db.sqlite" && sqlite3 "$TMP/db.sqlite" "PRAGMA integrity_check;" | grep -q ok
echo "backup verified: $SITE_ID ($(du -sh "$TMP" | cut -f1))"
rm -rf "$TMP"
