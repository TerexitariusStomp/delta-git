#!/usr/bin/env bash
set -uo pipefail
STATE_DIR=${STATE_DIR:-/state}
R2_REMOTE=${R2_REMOTE:-r2:wpcloud-state/${SITE_ID:-unknown}}
mkdir -p "$STATE_DIR"
rclone copy "$R2_REMOTE" "$STATE_DIR" --exclude ".versions/**" --transfers 8 --checkers 8
