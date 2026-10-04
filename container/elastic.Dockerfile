# Elasticsearch sidecar — ElasticPress and search-heavy plugins.
# ENTERPRISE ONLY: ES wants ≥1GB RAM → forces an instance-size bump.
# Single-node, security disabled (pod-local only, never public).
FROM docker.elastic.co/elasticsearch/elasticsearch:8.15.0
ENV discovery.type=single-node \
    xpack.security.enabled=false \
    ES_JAVA_OPTS="-Xms512m -Xmx512m" \
    path.data=/state/elastic
EXPOSE 9200
