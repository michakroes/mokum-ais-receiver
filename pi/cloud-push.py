#!/usr/bin/env python3
"""cloud-push.py - sends the local /state snapshot to the Netlify cloud.

Reads http://127.0.0.1:8801/state (the local dashboard) every PUSH_INTERVAL seconds
and POSTs the JSON to CLOUD_INGEST_URL with the x-ais-key header.

Python stdlib only, no pip deps. Config via env (see .cloud-push.env):
  CLOUD_INGEST_URL   https://<your-site>.netlify.app/api/ingest
  AIS_PUSH_KEY       shared secret (must equal the Netlify env var AIS_PUSH_KEY)
  LOCAL_STATE_URL    default http://127.0.0.1:8801/state
  PUSH_INTERVAL      default 6 (seconds)
"""
import os, sys, time, json, subprocess, urllib.request, urllib.error

LOCAL = os.environ.get("LOCAL_STATE_URL", "http://127.0.0.1:8801/state")
CLOUD = os.environ.get("CLOUD_INGEST_URL", "").strip()
KEY = os.environ.get("AIS_PUSH_KEY", "").strip()
INTERVAL = float(os.environ.get("PUSH_INTERVAL", "6"))

if not CLOUD or not KEY:
    print("ERROR: CLOUD_INGEST_URL and AIS_PUSH_KEY must be set (see .cloud-push.env)", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Host stats for the dashboard's Pi panel. Everything here is read-only and
# best-effort: /proc, /sys and statvfs are plain reads, systemctl/vcgencmd run
# read-only as user pi. A single failing probe returns None; the whole thing
# never raises and never writes to the SD card. Gathered at most once per
# HOST_TTL seconds and reused, so we don't spawn subprocesses every push.
# ---------------------------------------------------------------------------
SERVICES = ["ais-forward", "ais-dashboard", "ais-cloud-push"]
HOST_TTL = 30
_host_cache = {"at": 0.0, "data": None}

def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except Exception:
        return ""

def _uptime_s():
    try:
        return int(float(_read("/proc/uptime").split()[0]))
    except Exception:
        return None

def _load1():
    try:
        return round(float(_read("/proc/loadavg").split()[0]), 2)
    except Exception:
        return None

def _mem_mb():
    try:
        info = {}
        for line in _read("/proc/meminfo").splitlines():
            k, _, v = line.partition(":")
            if v:
                info[k] = int(v.strip().split()[0])   # kB
        total = info.get("MemTotal", 0) // 1024
        avail = info.get("MemAvailable", 0) // 1024
        return (total - avail, total) if total else (None, None)
    except Exception:
        return (None, None)

def _disk_pct():
    try:
        s = os.statvfs("/")
        total = s.f_blocks * s.f_frsize
        used = (s.f_blocks - s.f_bfree) * s.f_frsize
        return round(used / total * 100) if total else None
    except Exception:
        return None

def _temp_c():
    try:
        return round(int(_read("/sys/class/thermal/thermal_zone0/temp")) / 1000, 1)
    except Exception:
        return None

def _throttled():
    # vcgencmd get_throttled -> "throttled=0x0". Bits 0-3 = a problem happening
    # NOW (under-voltage / freq-cap / throttled / soft-temp-limit); bits 16-19 =
    # it occurred since boot but recovered. 0x0 = perfectly healthy.
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=4)
        raw = out.stdout.strip().split("=")[-1]
        val = int(raw, 16)
        status = "bad" if (val & 0xF) else ("warn" if (val & 0xF0000) else "ok")
        return {"raw": raw, "status": status}
    except Exception:
        return None

def _services():
    try:
        out = subprocess.run(["systemctl", "is-active", *SERVICES], capture_output=True, text=True, timeout=5)
        states = out.stdout.split()
        return {s: (states[i] if i < len(states) else "unknown") for i, s in enumerate(SERVICES)}
    except Exception:
        return None

def host_stats():
    now = time.time()
    if _host_cache["data"] is not None and now - _host_cache["at"] < HOST_TTL:
        return _host_cache["data"]
    mem_used, mem_total = _mem_mb()
    data = {
        "at": int(now),
        "uptime_s": _uptime_s(),
        "load1": _load1(),
        "ncpu": os.cpu_count(),
        "mem_used_mb": mem_used,
        "mem_total_mb": mem_total,
        "disk_pct": _disk_pct(),
        "temp_c": _temp_c(),
        "throttled": _throttled(),
        "services": _services(),
    }
    _host_cache["data"] = data
    _host_cache["at"] = now
    return data

print(f"[push] {LOCAL} -> {CLOUD} every {INTERVAL}s", flush=True)

ok = 0
fail = 0
last_err = 0.0       # last error line (throttle: max 1/min)
last_status = time.time()   # last ok/fail status line (once per ~5 min)

while True:
    try:
        state = urllib.request.urlopen(LOCAL, timeout=5).read()
        # Enrich with host stats for the dashboard's Pi panel. If parsing or
        # enrichment fails for any reason, fall back to pushing the raw bytes.
        try:
            doc = json.loads(state)
            doc["pi"] = host_stats()
            state = json.dumps(doc).encode()
        except Exception:
            pass
        req = urllib.request.Request(
            CLOUD, data=state, method="POST",
            headers={"Content-Type": "application/json", "x-ais-key": KEY},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
        ok += 1
    except Exception as e:
        fail += 1
        # only log occasionally to avoid filling up the journal
        if time.time() - last_err > 60:
            print(f"[push] error: {e}", file=sys.stderr, flush=True)
            last_err = time.time()
    # status line once per ~5 min (own timer, so errors don't hide it)
    if time.time() - last_status > 300:
        print(f"[push] ok={ok} fail={fail}", flush=True)
        last_status = time.time()
    time.sleep(INTERVAL)
