// VesselFinder-fallback: scrapet naam + foto-URL van de publieke VF-detailpagina
// wanneer mokum-radar/AIS niks heeft. Geen publieke VF-API; de pagina geeft 403
// zonder browser-UA, 200 mét. Naam staat in <title>, de foto-URL als
// static.vesselfinder.net/ship-photo/0-<mmsi>-<hash>/... (hash niet construeerbaar
// -> scrapen verplicht). Resultaat wordt in Netlify Blobs gecachet.
import { getStore } from "@netlify/blobs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const POS_TTL_MS = 7 * 24 * 3600 * 1000;   // gevonden: 7 dagen bewaren
const NEG_TTL_MS = 24 * 3600 * 1000;       // niks gevonden: 1 dag

// Zelfde best-effort per-IP rate-limit als vessel.mjs (per-instance, 60/min).
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

// Parse de VF-detail-HTML. Alleen aanroepen bij HTTP 200 (een 404-pagina heeft
// <title>Error 404 - VesselFinder</title> en zou anders "Error 404" als naam geven).
function parseVf(html) {
  let name = null;
  const tm = html.match(/<title>([^<]*)<\/title>/i);
  if (tm) {
    const t = tm[1].trim();
    // formaat: "NAAM, Type ship - Details ... - VesselFinder"
    const comma = t.indexOf(",");
    let cand = comma > 0 ? t.slice(0, comma).trim()
      : (t.indexOf(" - ") > 0 ? t.slice(0, t.indexOf(" - ")).trim() : "");
    // afvang: foutpagina's / lege / generieke titels niet als naam gebruiken
    if (cand && !/^error\b/i.test(cand) && !/^vessels?$/i.test(cand) && !/vesselfinder/i.test(cand)) {
      name = cand;
    }
  }
  let photoUrl = null;
  const pm = html.match(/https:\/\/static\.vesselfinder\.net\/ship-photo\/0-\d+-[0-9a-f]+\/\d+(?:\?v\d+)?/i);
  if (pm) photoUrl = pm[0];
  return { name, photoUrl };
}

export default async (req) => {
  const headers = {
    "content-type": "application/json",
    // CDN/browser mogen lang cachen; de Blobs-cache dekt de scrape zelf af.
    "cache-control": "public, max-age=86400",
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

  const store = getStore("ais");
  const cacheKey = `vf/${mmsi}`;

  // Cache-hit binnen TTL -> geen VF-request.
  try {
    const cached = await store.get(cacheKey, { type: "json" });
    if (cached && cached.fetchedAt) {
      const age = Date.now() - cached.fetchedAt;
      const ttl = cached.name || cached.photoUrl ? POS_TTL_MS : NEG_TTL_MS;
      if (age < ttl) {
        return new Response(JSON.stringify({
          name: cached.name || null,
          photoUrl: cached.photoUrl || null,
          vesselFinderUrl: cached.vesselFinderUrl || null,
          cached: true,
        }), { headers });
      }
    }
  } catch { /* blob-leesfout: gewoon opnieuw scrapen */ }

  const vesselFinderUrl = `https://www.vesselfinder.com/vessels/details/${mmsi}`;
  let name = null, photoUrl = null;
  try {
    const r = await fetch(vesselFinderUrl, {
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    });
    if (r.status === 200) {
      const html = await r.text();
      const parsed = parseVf(html);
      name = parsed.name;
      photoUrl = parsed.photoUrl;
    }
    // niet-200 (404/403/5xx) -> negatief cachen, geen error naar de client
  } catch { /* netwerkfout -> negatief resultaat teruggeven, negatief cachen */ }

  // Resultaat cachen (positief én negatief). fetchedAt bepaalt de TTL.
  const record = { fetchedAt: Date.now(), name, photoUrl, vesselFinderUrl };
  try { await store.setJSON(cacheKey, record); } catch { /* schrijffout negeren */ }

  return new Response(JSON.stringify({ name, photoUrl, vesselFinderUrl }), { headers });
};
