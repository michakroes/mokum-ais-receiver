// Proxy to the mokum-radar vessel-detail API. Keeps the READ_KEY server-side
// (mokum-radar's /api/v2/vessel/:mmsi is key-gated AND sends no CORS, so the
// browser cannot call it directly). Env: MOKUM_READ_KEY.
const MOKUM = "https://mokum-radar.fly.dev";

// Best-effort rate limit against abuse as an open relay. Per-instance and thus
// not watertight (Netlify runs multiple instances), but it bounds the use of
// our READ_KEY per visitor. The 30s cache already absorbs repeated clicks.
const WINDOW_MS = 60000, MAX_PER_IP = 60;
const hits = new Map();   // ip -> [timestamps within the window]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {   // clean up so the Map doesn't grow unbounded
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  }
  return arr.length > MAX_PER_IP;
}

export default async (req) => {
  const headers = {
    "content-type": "application/json",
    "cache-control": "public, max-age=30",
    "access-control-allow-origin": "*",
  };

  const ip = req.headers.get("x-nf-client-connection-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers });
  }

  const url = new URL(req.url);
  const mmsi = (url.searchParams.get("mmsi") || "").replace(/\D/g, "");
  if (!mmsi) return new Response(JSON.stringify({ error: "missing mmsi" }), { status: 400, headers });
  if (mmsi.length > 9) return new Response(JSON.stringify({ error: "invalid mmsi" }), { status: 400, headers });

  const key = process.env.MOKUM_READ_KEY;
  if (!key) return new Response(JSON.stringify({ error: "MOKUM_READ_KEY not configured" }), { status: 503, headers });

  try {
    const r = await fetch(`${MOKUM}/api/v2/vessel/${mmsi}`, { headers: { "x-key": key } });
    if (!r.ok) {
      // 401 from mokum = our key is wrong -> pass on as 502 (not as 401 to the client)
      const code = r.status === 401 ? 502 : r.status;
      return new Response(JSON.stringify({ error: `mokum-radar ${r.status}` }), { status: code, headers });
    }
    const data = await r.json();
    return new Response(JSON.stringify(data), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers });
  }
};
