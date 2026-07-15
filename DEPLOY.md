# Deploy - matsutec cloud-dashboard

Read-only cloud-weergave van het AR-10-station. De Pi pusht elke paar seconden
`/state` naar een Netlify Function (`ingest`), die het in Netlify Blobs bewaart;
de frontend leest het via `state`. Frontend-updates = gewoon `git push`.

```
Pi: serve.py (:8801) --/state--> cloud-push.py --POST /api/ingest--> Netlify Blobs
                                                        frontend <--/api/state-- Blobs
```

## 1. Repo naar GitHub

```sh
cd ~/Downloads/matsutec-dashboard
gh repo create matsutec-dashboard --private --source=. --remote=origin --push
```
(of maak handmatig een repo aan en `git push -u origin main`)

## 2. Netlify-site aan de repo koppelen

- Netlify -> Add new site -> Import from Git -> kies `matsutec-dashboard`.
- Build settings worden uit `netlify.toml` gelezen (command `node build-config.mjs`,
  publish `public`, functions `netlify/functions`). Niks aan te passen.
- Deploy. Je krijgt een URL zoals `https://<naam>.netlify.app`.

## 3. Netlify env-vars zetten (Site configuration -> Environment variables)

| Var | Waarde |
|---|---|
| `AIS_PUSH_KEY` | lang willekeurig geheim, genereer met `openssl rand -hex 24` |
| `GMAPS_KEY` | je Google Maps browser-key (uit `matsutec/.env.local`) |
| `GMAPS_ID` | je Google Maps Map ID (uit `matsutec/.env.local`) |

Na het zetten: **Trigger deploy** (Deploys -> Trigger deploy) zodat `config.js`
met de GMAPS-waarden opnieuw gegenereerd wordt.

## 4. Google Maps referrer toestaan

In de Google Cloud Console -> Credentials -> je Maps-key -> Website restrictions:
voeg `https://<naam>.netlify.app/*` toe. Anders blijft de kaart "Oops! Something
went wrong." geven.

## 5. Netlify Blobs

Werkt out-of-the-box op moderne Netlify (geen setup). De functions gebruiken
`@netlify/blobs`; de store heet `ais`.

## 6. Op de Pi: de pusher installeren

```sh
# vanaf je Mac, vanuit ~/Downloads/matsutec-dashboard:
scp pi/cloud-push.py pi@mokum-ais.local:~/matsutec/cloud-push.py
scp pi/.cloud-push.env.example pi@mokum-ais.local:~/matsutec/.cloud-push.env
scp pi/ais-cloud-push.service pi@mokum-ais.local:/tmp/ais-cloud-push.service

# op de Pi:
ssh pi@mokum-ais.local
nano ~/matsutec/.cloud-push.env         # CLOUD_INGEST_URL + AIS_PUSH_KEY invullen (zelfde key als Netlify)
chmod 600 ~/matsutec/.cloud-push.env
sudo mv /tmp/ais-cloud-push.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ais-cloud-push
journalctl -u ais-cloud-push -f        # moet "ok=..." tonen, geen 401/fout
```

## 7. Verifieren

- `https://<naam>.netlify.app` opent -> statuspill wordt "live" zodra de eerste push
  binnen is (< 20s).
- Zonder ontvangst blijven de tellers 0 (dat is antenne, niet de pijplijn).
- 401 in de push-log = `AIS_PUSH_KEY` op de Pi != die in Netlify.

## Frontend updaten

Pas `public/index.html` aan, `git push` -> Netlify deployt automatisch. Klaar.
