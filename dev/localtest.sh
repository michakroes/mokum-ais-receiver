#!/usr/bin/env bash
# Local testing of the cloud dashboard on http://localhost:8888
#
# Runs `netlify dev` (functions + frontend + local Blobs sandbox) AND a feeder
# that pumps snapshots into the local /api/ingest, so you see exactly what would
# be live - without deploying. Edit the frontend -> refresh -> see.
#
#   ./dev/localtest.sh          feeder reads the LIVE Pi (mokum-ais.local:8801)
#   ./dev/localtest.sh sample   feeder pumps a fixed sample snapshot (no Pi needed)
#
# GMAPS_KEY / GMAPS_ID / AIS_PUSH_KEY come from matsutec/.env.local
# (override with ENV_FILE=/path/to/.env.local).
set -euo pipefail
cd "$(dirname "$0")/.."

ENVF="${ENV_FILE:-/Users/Micha@backbase.com/Downloads/matsutec/.env.local}"
[ -f "$ENVF" ] || { echo "ERROR: env file not found: $ENVF"; exit 1; }

# Read GMAPS + AIS_PUSH_KEY safely (cut, no `source` - values are NOT executed
# as shell code) and export -> netlify dev (build + functions) + feeder.
getval(){ grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }
export GMAPS_KEY="$(getval GMAPS_KEY)"
export GMAPS_ID="$(getval GMAPS_ID)"
export AIS_PUSH_KEY="$(getval AIS_PUSH_KEY)"
: "${AIS_PUSH_KEY:?AIS_PUSH_KEY missing in $ENVF}"

PORT=8888
INGEST="http://localhost:${PORT}/api/ingest"

if [ "${1:-}" = "sample" ]; then
  ( while true; do
      curl -s -o /dev/null -X POST -H "x-ais-key: ${AIS_PUSH_KEY}" -H 'content-type: application/json' \
        --data @dev/sample-state.json "$INGEST" 2>/dev/null || true
      sleep 4
    done ) &
  echo "sample feeder -> ${INGEST}"
else
  CLOUD_INGEST_URL="$INGEST" LOCAL_STATE_URL="http://mokum-ais.local:8801/state" \
    python3 pi/cloud-push.py &
  echo "Pi feeder: mokum-ais.local:8801 -> ${INGEST}"
fi
FEEDER=$!
trap 'kill "$FEEDER" 2>/dev/null || true' EXIT

echo "netlify dev starting on http://localhost:${PORT}  (Ctrl+C stops everything)"
# --offline: don't fetch remote env; purely the vars exported above from
# .env.local. That way the functions' AIS_PUSH_KEY == the feeder's.
exec netlify dev --offline --port "$PORT"
