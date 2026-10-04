# Redis sidecar — object cache for WooCommerce/high-traffic sites
# (redis-cache plugin, Woo transients). Reachable via DO ws↔TCP on :6379.
FROM redis:7-alpine
# persist to the synced state volume so the cache survives sleep
CMD ["redis-server", "--appendonly", "yes", "--dir", "/state/redis", "--port", "6379"]
