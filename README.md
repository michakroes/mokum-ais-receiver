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

Het onderliggende station (AR-10 -> `ais-forward` -> AIS Friends + AISHub + lokaal
dashboard) leeft in het aparte `matsutec`-project op de Pi.
