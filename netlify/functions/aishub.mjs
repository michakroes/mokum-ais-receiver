// AISHub station status: proxies the public (but undocumented) realtime endpoint
// the AISHub station page uses. The browser can't call it cross-origin (needs an
// XMLHttpRequest header and AISHub sends no CORS headers), so we fetch it here
// server-side and cache in Netlify Blobs. Gentle: cached ~60s, best-effort.
//   https://www.aishub.net/station/<id>/realtime.json
//   -> {ships:{all,unique}, class:{a,b:{number,percent}}, uptime, shipType:{...}}
import { getStore } from "@netlify/blobs";

const STATION = (process.env.AISHUB_STATION || "2276").replace(/\D/g, "") || "2276";
const TTL_MS = 60000;   // realtime updates slowly; don't hammer the source

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Best-effort per-IP rate limit (per-instance, 60/min) — same shape as vf.mjs.
const WINDOW_MS = 60000, MAX_PER_IP = 60;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  }
  return arr.length > MAX_PER_IP;
}

// Keep only the fields the dashboard shows; ignore the donut/shipType payload.
function shape(raw) {
  const cls = raw.class || {};
  const a = cls.a || {}, b = cls.b || {};
  return {
    station: STATION,
    stationUrl: `https://www.aishub.net/stations/${STATION}`,
    ships: { all: raw.ships?.all ?? null, unique: raw.ships?.unique ?? null },
    classA: { number: a.number ?? null, percent: a.percent ?? null },
    classB: { number: b.number ?? null, percent: b.percent ?? null },
    uptime: typeof raw.uptime === "number" ? raw.uptime : null,   // weekly %, 0..100
  };
}

export default async (req) => {
  const headers = {
    "content-type": "application/json",
    "cache-control": "public, max-age=60",
    "access-control-allow-origin": "*",
  };

  const ip = req.headers.get("x-nf-client-connection-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers });
  }

  const store = getStore("ais");
  const cacheKey = `aishub/realtime/${STATION}`;

  // Fresh cache hit -> no upstream request.
  let cached = null;
  try {
    cached = await store.get(cacheKey, { type: "json" });
    if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < TTL_MS) {
      return new Response(JSON.stringify({ ...cached.data, cached: true }), { headers });
    }
  } catch { /* blob read error: fetch fresh */ }

  try {
    const r = await fetch(`https://www.aishub.net/station/${STATION}/realtime.json`, {
      headers: {
        "user-agent": UA,
        "x-requested-with": "XMLHttpRequest",              // AISHub returns empty without this
        "referer": `https://www.aishub.net/stations/${STATION}`,
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (r.status === 200) {
      const raw = await r.json();
      const data = shape(raw);
      try { await store.setJSON(cacheKey, { fetchedAt: Date.now(), data }); } catch { /* ignore */ }
      return new Response(JSON.stringify(data), { headers });
    }
    // non-200: fall through to stale cache / error
  } catch { /* network error: fall through */ }

  // Upstream failed — serve stale cache if we have any, else an error.
  if (cached && cached.data) {
    return new Response(JSON.stringify({ ...cached.data, cached: true, stale: true }), { headers });
  }
  return new Response(JSON.stringify({ error: "aishub unavailable" }), { status: 502, headers });
};
