#!/usr/bin/env bash
# Image pipeline: build + scan + tag the Lane-3 variant matrix.
# Usage: build-image.sh [variant] — default builds all.
# Variants: frankenphp (default), apache, php74, mysql8, redis, elastic.
set -euo pipefail
V=${1:-all}

build() {
  local tag=$1 dockerfile=$2; shift 2
  docker build -t "wpcloud-site:$tag" -f "container/$dockerfile" "$@" container/
  trivy image --scanners vuln,secret --severity HIGH,CRITICAL "wpcloud-site:$tag"
  echo "built+scanned: wpcloud-site:$tag"
}

case "$V" in
  frankenphp) build frankenphp Dockerfile ;;
  apache)     build apache apache.Dockerfile ;;
  php74)      build php74 php74.Dockerfile ;;
  mysql8)     build mysql8 mysql8.Dockerfile ;;
  mariadb)    build mariadb db.Dockerfile ;;
  redis)      build redis redis.Dockerfile ;;
  elastic)    build elastic elastic.Dockerfile ;;
  all)
    build frankenphp Dockerfile
    build apache apache.Dockerfile
    build php74 php74.Dockerfile
    build mysql8 mysql8.Dockerfile
    build mariadb db.Dockerfile
    build redis redis.Dockerfile
    build elastic elastic.Dockerfile
    ;;
  *) echo "unknown variant: $V (frankenphp|apache|php74|mysql8|mariadb|redis|elastic|all)" >&2; exit 1 ;;
esac
