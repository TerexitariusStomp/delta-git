#!/usr/bin/env bash
# Image pipeline (P4): build + scan + tag the Lane-3 site image.
set -euo pipefail
TAG=${1:-wpcloud-site:latest}
docker build -t "$TAG" container/
trivy image --scanners vuln,secret --severity HIGH,CRITICAL "$TAG"
echo "built+scanned: $TAG"
