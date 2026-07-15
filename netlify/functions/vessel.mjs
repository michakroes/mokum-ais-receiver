// Proxy naar de mokum-radar vessel-detail API. Houdt de READ_KEY server-side
// (mokum-radar's /api/v2/vessel/:mmsi is key-gated EN stuurt geen CORS, dus de
// browser kan het niet direct aanroepen). Env: MOKUM_READ_KEY.
const MOKUM = "https://mokum-radar.fly.dev";

export default async (req) => {
  const headers = {
    "content-type": "application/json",
    "cache-control": "public, max-age=30",
    "access-control-allow-origin": "*",
  };
  const url = new URL(req.url);
  const mmsi = (url.searchParams.get("mmsi") || "").replace(/\D/g, "");
  if (!mmsi) return new Response(JSON.stringify({ error: "mmsi ontbreekt" }), { status: 400, headers });

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
