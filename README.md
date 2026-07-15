# Mokum AIS Receiver

**Live: https://mokum-ais-receiver.netlify.app/**

Read-only **cloud dashboard** for a private AIS receiving station in Amsterdam:
a **Matsutec AR-10** (USB, NMEA 0183 @ 38400) running 24/7 on a Raspberry Pi
Zero W (`mokum-ais`). The Pi pushes its live `/state` to Netlify; this site
shows it from anywhere.

## What you see

- **Map** (Google Maps) with live vessel markers — hull silhouette rotated to
  course for moving vessels, a dot for idle ones; blue = photo available,
  purple = no photo.
- **Vessel list** — MMSI, name, speed, status. Names come from AIS static
  messages, enriched via mokum-radar, with a VesselFinder fallback (marked
  with a small `VF` badge).
- **Click a vessel** (row or marker) for a detail card: photo, operator,
  speed/course/type/length/class, VesselFinder link.
- **Raw NMEA feed** — every received sentence; **click a line** for a full
  byte-level breakdown (transport layer, 6-bit armoring, bitstream, decoded
  AIS fields).
- **Freshness that tells the truth**: the status pill shows push freshness,
  and turns **amber ("quiet Xm")** when the chain is live but no AIS message
  has been received for 3+ minutes — a reception lull, not an outage. The
  Sentences tile always shows "last: X ago".

## Architecture

```
AR-10 ──serial──> Pi: ais-forward ──UDP──> AIS Friends + AISHub
                           │
                           └──UDP──> serve.py (:8801, local dashboard)
                                        │  /state
                                        ▼
                              cloud-push.py ──POST /api/ingest──> Netlify Function
                                                                      │
                                                              Netlify Blobs (store "ais")
                                                                      │
                    frontend (this repo) <──GET /api/state── Netlify Function
```

- **Frontend:** `public/` (static, polls `/api/state` every 2s, pauses when
  the tab is hidden).
- **Functions:** `netlify/functions/` — `ingest` (auth-gated write from the
  Pi), `state` (public read, filters vessels older than 12h), `vessel`
  (proxy to mokum-radar, keeps the read key server-side), `vf`
  (VesselFinder name/photo fallback, cached in Blobs).
- **Pi side:** `pi/cloud-push.py` + `pi/ais-cloud-push.service` (systemd).
- **Secrets** (`GMAPS_KEY`, `AIS_PUSH_KEY`, `MOKUM_READ_KEY`) live in Netlify
  env vars, never in git; `public/config.js` is generated at build time by
  `build-config.mjs`.

## Local development (fast — localhost:8899)

Test the frontend without deploying. The lightweight Python server starts in
milliseconds (no `netlify dev`) and serves the real `index.html` + `config.js`
(GMAPS keys from `.env.local`):

```sh
python3 dev/localserve.py          # /api/state = dev/sample-state.json (no Pi/cloud needed)
python3 dev/localserve.py pi       # /api/state = live Pi  (mokum-ais.local:8801)
python3 dev/localserve.py cloud    # /api/state = live Netlify site
```

Open http://localhost:8899 (port via `PORT=...`, env file via `ENV_FILE=...`).
Edit the frontend → refresh → see it. The map works locally if your Maps key
allows `http://localhost:8899/*` in its referrer list.

Only when you need to test the Functions/ingest themselves, use
`./dev/localtest.sh` (= `netlify dev --offline` + a feeder, on :8888) — it is
slow.

Deploying + Pi installation: see [DEPLOY.md](DEPLOY.md).

## Notes

- The counters stay at 0 until the AR-10 actually receives AIS. That is
  antenna/placement (VHF, line-of-sight, height) — not a pipeline issue.
  Reception lulls of 10-50 minutes are normal for this station.
- The underlying station scripts (AR-10 → forwarder → local dashboard) run on
  the Pi and are not part of this public repo.
