# matsutec-dashboard

Read-only **cloud-weergave** van het Matsutec AR-10 AIS-station dat op een Raspberry
Pi Zero draait (`mokum-ais`). De Pi pusht zijn live `/state` naar Netlify; deze site
toont kaart + schepenlijst + ruwe feed, bereikbaar van overal.

- **Frontend:** `public/index.html` (static, pollt `/api/state` elke 2s).
- **Functions:** `netlify/functions/ingest.mjs` (Pi POST't hierheen) + `state.mjs`
  (frontend leest), opslag via Netlify Blobs (store `ais`).
- **Pi-kant:** `pi/cloud-push.py` + `pi/ais-cloud-push.service` (systemd).
- **GMAPS-key** komt uit Netlify-env via `build-config.mjs` -> `public/config.js`
  (niet in git).

Deployen + Pi-installatie: zie [DEPLOY.md](DEPLOY.md).

## Lokaal testen (localhost:8888)

Frontend testen met echte data zonder te deployen. Vereist `netlify` CLI en de vars
`GMAPS_KEY` / `GMAPS_ID` / `AIS_PUSH_KEY` in `matsutec/.env.local` (override met
`ENV_FILE=/pad/.env.local`). Draait `netlify dev --offline` (dus puur die lokale env,
niet de remote) + een feeder die `/api/ingest` voedt:

```sh
./dev/localtest.sh          # feeder leest de LIVE Pi (mokum-ais.local:8801)
./dev/localtest.sh sample   # feeder pompt dev/sample-state.json (Pi niet nodig)
```

Open daarna http://localhost:8888. Frontend aanpassen -> refresh -> zien. Ctrl+C stopt
alles. De kaart werkt lokaal als je Maps-key `http://localhost:8888/*` (of localhost)
toestaat in de referrer-lijst.

Het onderliggende station (AR-10 -> `ais-forward` -> AIS Friends + AISHub + lokaal
dashboard) leeft in het aparte `matsutec`-project op de Pi.
