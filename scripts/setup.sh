#!/usr/bin/env bash
# Account bootstrap: creates the free-tier resources wp-cloud needs.
# Run once per account. Requires: wrangler login + R2 keys (dash → R2 → manage API tokens)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== create D1 =="
wrangler d1 create wpcloud || true
echo ">> paste the printed database_id into wrangler.jsonc d1_databases[0].database_id"

echo "== create R2 buckets =="
wrangler r2 bucket create wpcloud-artifacts || true   # published site artifacts (immutable, sha-addressed)
wrangler r2 bucket create wpcloud-state || true       # Lane-2/3 persisted site state (paid phases)

echo "== R2 CORS (browser presigned-PUT uploads) =="
cat > /tmp/cors.json <<'EOF'
[{"AllowedOrigins":["https://*pages.dev","http://localhost:8787"],
  "AllowedMethods":["PUT","GET","HEAD"],
  "AllowedHeaders":["*"],
  "ExposeHeaders":["ETag"],
  "MaxAgeSeconds":86400}]
EOF
wrangler r2 bucket cors set wpcloud-artifacts --file /tmp/cors.json

echo "== secrets (prompts) =="
for s in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME R2_ACCOUNT_ID USDC_DEPOSIT_ADDRESS SESSION_SECRET; do
  echo "-- $s"; wrangler secret put "$s" || true
done

echo "== migrations =="
wrangler d1 migrations apply wpcloud --remote

echo "Done. wrangler deploy   (free tier)"
