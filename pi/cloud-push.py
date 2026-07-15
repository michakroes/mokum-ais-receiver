#!/usr/bin/env python3
"""cloud-push.py - stuurt de lokale /state-snapshot naar de Netlify-cloud.

Leest elke PUSH_INTERVAL seconden http://127.0.0.1:8801/state (het lokale dashboard)
en POST't de JSON naar CLOUD_INGEST_URL met de header x-ais-key.

Alleen Python-stdlib, geen pip-deps. Config via env (zie .cloud-push.env):
  CLOUD_INGEST_URL   https://<jouw-site>.netlify.app/api/ingest
  AIS_PUSH_KEY       gedeeld geheim (moet gelijk zijn aan de Netlify-env AIS_PUSH_KEY)
  LOCAL_STATE_URL    default http://127.0.0.1:8801/state
  PUSH_INTERVAL      default 4 (seconden)
"""
import os, sys, time, urllib.request, urllib.error

LOCAL = os.environ.get("LOCAL_STATE_URL", "http://127.0.0.1:8801/state")
CLOUD = os.environ.get("CLOUD_INGEST_URL", "").strip()
KEY = os.environ.get("AIS_PUSH_KEY", "").strip()
INTERVAL = float(os.environ.get("PUSH_INTERVAL", "4"))

if not CLOUD or not KEY:
    print("FOUT: CLOUD_INGEST_URL en AIS_PUSH_KEY moeten gezet zijn (zie .cloud-push.env)", file=sys.stderr)
    sys.exit(1)

print(f"[push] {LOCAL} -> {CLOUD} elke {INTERVAL}s", flush=True)

ok = 0
fail = 0
last_log = 0.0

while True:
    try:
        state = urllib.request.urlopen(LOCAL, timeout=5).read()
        req = urllib.request.Request(
            CLOUD, data=state, method="POST",
            headers={"Content-Type": "application/json", "x-ais-key": KEY},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
        ok += 1
    except Exception as e:
        fail += 1
        # alleen af en toe loggen om de journal niet vol te schrijven
        if time.time() - last_log > 60:
            print(f"[push] fout: {e}", file=sys.stderr, flush=True)
            last_log = time.time()
    # statusregel eens per ~5 min
    if time.time() - last_log > 300:
        print(f"[push] ok={ok} fail={fail}", flush=True)
        last_log = time.time()
    time.sleep(INTERVAL)
