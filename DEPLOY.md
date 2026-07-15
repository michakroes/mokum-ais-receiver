# Deploy - Mokum AIS cloud dashboard

Read-only cloud view of the AR-10 station, live at
**https://mokum-ais-receiver.netlify.app/**. The Pi pushes `/state` to a
Netlify Function (`ingest`) every few seconds, which stores it in Netlify
Blobs; the frontend reads it via `state`. Frontend updates = just `git push`.

```
Pi: serve.py (:8801) --/state--> cloud-push.py --POST /api/ingest--> Netlify Blobs
                                                        frontend <--/api/state-- Blobs
```

## 1. Repo on GitHub

The repo is **`michakroes/mokum-ais-receiver`** (PUBLIC, personal account
michakroes), checked out locally at `~/Downloads/matsutec`. It already exists;
recreating it from scratch would be:

```sh
cd ~/Downloads/matsutec
gh repo create mokum-ais-receiver --public --source=. --remote=origin --push
```
(or create a repo manually and `git push -u origin main`)

Note: `station/`, `.env.local`, `.cloud-push.env`, `public/config.js`,
`CLAUDE.md` and `.claude/` are gitignored - the public repo stays purely the
dashboard, with no secrets or Pi scripts.

## 2. Connect the Netlify site to the repo

- Netlify -> Add new site -> Import from Git -> pick `mokum-ais-receiver`.
- Build settings are read from `netlify.toml` (command `node build-config.mjs`,
  publish `public`, functions `netlify/functions`). Nothing to change.
- Deploy. You get a URL like `https://<name>.netlify.app`.

## 3. Set Netlify env vars (Site configuration -> Environment variables)

| Var | Value |
|---|---|
| `AIS_PUSH_KEY` | long random secret, generate with `openssl rand -hex 24` (must equal the Pi's) |
| `GMAPS_KEY` | your Google Maps browser key (from `matsutec/.env.local`) |
| `GMAPS_ID` | your Google Maps Map ID (from `matsutec/.env.local`) |
| `MOKUM_READ_KEY` | READ key for mokum-radar (the `vessel` function proxies the vessel-detail API with it) |
| `VESSEL_MAX_AGE_H` | optional, default 12 - drop vessels older than X hours from `state` |

After setting them: **Trigger deploy** (Deploys -> Trigger deploy) so
`config.js` is regenerated with the GMAPS values.

## 4. Allow the Google Maps referrer

In the Google Cloud Console -> Credentials -> your Maps key -> Website
restrictions: add `https://mokum-ais-receiver.netlify.app/*`. Otherwise the map
keeps showing "Oops! Something went wrong."

## 5. Netlify Blobs

Works out of the box on modern Netlify (no setup). The functions use
`@netlify/blobs`; the store is named `ais`.

## 6. On the Pi: install the pusher

```sh
# from your Mac, inside ~/Downloads/matsutec:
scp pi/cloud-push.py pi@mokum-ais.local:~/matsutec/cloud-push.py
scp pi/.cloud-push.env.example pi@mokum-ais.local:~/matsutec/.cloud-push.env
scp pi/ais-cloud-push.service pi@mokum-ais.local:/tmp/ais-cloud-push.service

# on the Pi:
ssh pi@mokum-ais.local
nano ~/matsutec/.cloud-push.env         # fill in CLOUD_INGEST_URL + AIS_PUSH_KEY (same key as Netlify)
chmod 600 ~/matsutec/.cloud-push.env
sudo mv /tmp/ais-cloud-push.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ais-cloud-push
journalctl -u ais-cloud-push -f        # should show "ok=...", no 401/errors
```

## 7. Verify

- https://mokum-ais-receiver.netlify.app/ opens -> the status pill turns
  "live" as soon as the first push lands (< 20s).
- Without reception the counters stay 0 (that's the antenna, not the
  pipeline). The pill turns amber ("quiet Xm") during a reception lull.
- A 401 in the push log = `AIS_PUSH_KEY` on the Pi != the one in Netlify.

## Updating the frontend

Edit files under `public/`, `git push` -> Netlify deploys automatically. Done.
