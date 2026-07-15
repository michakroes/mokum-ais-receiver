#!/usr/bin/env bash
# Lokaal testen van het cloud-dashboard op http://localhost:8888
#
# Draait `netlify dev` (functions + frontend + lokale Blobs-sandbox) EN een feeder
# die snapshots in de lokale /api/ingest pompt, zodat je precies ziet wat er live
# zou staan - zonder te deployen. Frontend aanpassen -> refresh -> zien.
#
#   ./dev/localtest.sh          feeder leest de LIVE Pi (mokum-ais.local:8801)
#   ./dev/localtest.sh sample   feeder pompt een vaste voorbeeld-snapshot (Pi niet nodig)
#
# GMAPS_KEY / GMAPS_ID / AIS_PUSH_KEY komen uit matsutec/.env.local
# (override met ENV_FILE=/pad/naar/.env.local).
set -euo pipefail
cd "$(dirname "$0")/.."

ENVF="${ENV_FILE:-/Users/Micha@backbase.com/Downloads/matsutec/.env.local}"
[ -f "$ENVF" ] || { echo "FOUT: env-bestand niet gevonden: $ENVF"; exit 1; }

# GMAPS + AIS_PUSH_KEY veilig uitlezen (cut, geen `source` - waarden worden NIET
# als shell-code uitgevoerd) en exporteren -> netlify dev (build + functions) + feeder.
getval(){ grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }
export GMAPS_KEY="$(getval GMAPS_KEY)"
export GMAPS_ID="$(getval GMAPS_ID)"
export AIS_PUSH_KEY="$(getval AIS_PUSH_KEY)"
: "${AIS_PUSH_KEY:?AIS_PUSH_KEY ontbreekt in $ENVF}"

PORT=8888
INGEST="http://localhost:${PORT}/api/ingest"

if [ "${1:-}" = "sample" ]; then
  ( while true; do
      curl -s -o /dev/null -X POST -H "x-ais-key: ${AIS_PUSH_KEY}" -H 'content-type: application/json' \
        --data @dev/sample-state.json "$INGEST" 2>/dev/null || true
      sleep 4
    done ) &
  echo "sample-feeder -> ${INGEST}"
else
  CLOUD_INGEST_URL="$INGEST" LOCAL_STATE_URL="http://mokum-ais.local:8801/state" \
    python3 pi/cloud-push.py &
  echo "Pi-feeder: mokum-ais.local:8801 -> ${INGEST}"
fi
FEEDER=$!
trap 'kill "$FEEDER" 2>/dev/null || true' EXIT

echo "netlify dev start op http://localhost:${PORT}  (Ctrl+C stopt alles)"
# --offline: geen remote-env ophalen; puur de hierboven geexporteerde vars uit
# .env.local. Zo is de AIS_PUSH_KEY van de functions == die van de feeder.
exec netlify dev --offline --port "$PORT"
