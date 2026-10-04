#!/usr/bin/env bash
# Register/unregister a plugin daemon as a runit service.
# The mu-plugin (or compat-scan) calls this via the agent when it detects a
# long-running plugin process. Service dirs live under /state/daemons so they
# survive sleep/wake; runsvdir picks them up automatically.
# Usage: daemon-svc.sh add <slug> <command...> | del <slug>
set -euo pipefail
SVDIR=/state/daemons
cmd="$1"; slug="$2"; shift 2 || true
case "$cmd" in
  add)
    mkdir -p "$SVDIR/$slug"
    cat > "$SVDIR/$slug/run" <<EOF
#!/bin/sh
cd /srv/site
exec $*
EOF
    chmod +x "$SVDIR/$slug/run"
    echo "daemon $slug registered"
    ;;
  del)
    rm -rf "$SVDIR/$slug" || true
    echo "daemon $slug removed"
    ;;
  *) echo "usage: daemon-svc.sh add|del <slug> [command...]" >&2; exit 1 ;;
esac
