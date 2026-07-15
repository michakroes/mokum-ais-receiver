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

## Lokaal testen (snel - localhost:8899)

Frontend testen zonder te deployen. Het lichte Python-servertje start in ~ms (geen
`netlify dev`) en serveert de echte `index.html` + `config.js` (GMAPS uit `.env.local`):

```sh
python3 dev/localserve.py          # /api/state = dev/sample-state.json (Pi/cloud niet nodig)
python3 dev/localserve.py pi       # /api/state = live Pi  (mokum-ais.local:8801)
python3 dev/localserve.py cloud    # /api/state = live Netlify-site
```

Open http://localhost:8899 (poort via `PORT=...`, env-bestand via `ENV_FILE=...`).
Frontend aanpassen -> refresh -> zien. De kaart werkt lokaal als je Maps-key
`http://localhost:8899/*` toestaat in de referrer-lijst.

Alleen als je de Functions/ingest zelf moet testen is er `./dev/localtest.sh`
(= `netlify dev --offline` + feeder, op :8888) - maar dat is traag.

Het onderliggende station (AR-10 -> `ais-forward` -> AIS Friends + AISHub + lokaal
dashboard) leeft in het aparte `matsutec`-project op de Pi.
