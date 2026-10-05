#!/usr/bin/env bash
# Scan installed plugins → report {slug, source} set to the platform
# classifier (POST /api/internal/compat-report, machine auth via SITE_TOKEN).
# Also writes next-cron-due for the DO cron-wake alarm.
set -euo pipefail
cd /srv/site

# build [{slug, source}] — source = plugin main file capped at 64KB
wp plugin list --field=name --allow-root 2>/dev/null | while read -r p; do
  f="wp-content/plugins/$p/$p.php"
  [ -f "$f" ] || f=$(find "wp-content/plugins/$p" -maxdepth 1 -name "*.php" 2>/dev/null | head -1)
  src=""
  [ -n "$f" ] && src=$(head -c 65536 "$f" | jq -Rs . 2>/dev/null || echo '""')
  [ -z "$src" ] && src='""'
  jq -n --arg slug "$p" --argjson source "${src:-\"\"}" '{slug:$slug, source:$source}'
done | jq -s '.' > /tmp/plugins.json

# next cron due — DO wakes a sleeping site before this fires
NEXT_DUE=$(wp cron event list --format=json --allow-root 2>/dev/null | jq '[.[].next_run_gmt // .[].next_run] | min // 0' 2>/dev/null || echo 0)

PAYLOAD=$(jq -n --argjson plugins "$(cat /tmp/plugins.json)" --argjson due "${NEXT_DUE:-0}" \
  '{plugins:$plugins, next_cron_due:$due}')

# report to platform (no-op on free tier where WORKER_URL isn't set)
if [ -n "${WORKER_URL:-}" ] && [ -n "${SITE_TOKEN:-}" ]; then
  curl -fsSL -X POST "$WORKER_URL/api/internal/compat-report" \
    -H "content-type: application/json" -H "x-site-token: $SITE_TOKEN" \
    -d "$PAYLOAD" || true
fi
echo "scanned $(jq length /tmp/plugins.json) plugins"
