// Proxy naar de mokum-radar vessel-detail API. Houdt de READ_KEY server-side
// (mokum-radar's /api/v2/vessel/:mmsi is key-gated EN stuurt geen CORS, dus de
// browser kan het niet direct aanroepen). Env: MOKUM_READ_KEY.
const MOKUM = "https://mokum-radar.fly.dev";

// Best-effort rate-limit tegen misbruik als open relay. Per-instance en dus niet
// waterdicht (Netlify draait meerdere instances), maar begrenst het gebruik van
// onze READ_KEY per bezoeker. De 30s-cache vangt herhaalde clicks al op.
const WINDOW_MS = 60000, MAX_PER_IP = 60;
const hits = new Map();   // ip -> [timestamps binnen het venster]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {   // opruimen zodat de Map niet onbeperkt groeit
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
    return new Response(JSON.stringify({ error: "te veel verzoeken" }), { status: 429, headers });
  }

  const url = new URL(req.url);
  const mmsi = (url.searchParams.get("mmsi") || "").replace(/\D/g, "");
  if (!mmsi) return new Response(JSON.stringify({ error: "mmsi ontbreekt" }), { status: 400, headers });
  if (mmsi.length > 9) return new Response(JSON.stringify({ error: "ongeldige mmsi" }), { status: 400, headers });

  const key = process.env.MOKUM_READ_KEY;
  if (!key) return new Response(JSON.stringify({ error: "MOKUM_READ_KEY niet geconfigureerd" }), { status: 503, headers });

  try {
    const r = await fetch(`${MOKUM}/api/v2/vessel/${mmsi}`, { headers: { "x-key": key } });
    if (!r.ok) {
      // 401 van mokum = onze key klopt niet -> als 502 doorgeven (niet als 401 aan de client)
      const code = r.status === 401 ? 502 : r.status;
      return new Response(JSON.stringify({ error: `mokum-radar ${r.status}` }), { status: code, headers });
    }
    const data = await r.json();
    return new Response(JSON.stringify(data), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers });
  }
};
