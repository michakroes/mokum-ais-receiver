// VesselFinder fallback: scrapes name + photo URL from the public VF detail page
// when mokum-radar/AIS has nothing. No public VF API; the page returns 403
// without a browser UA, 200 with one. The name is in <title>, the photo URL as
// static.vesselfinder.net/ship-photo/0-<mmsi>-<hash>/... (hash not constructible
// -> scraping required). Result is cached in Netlify Blobs.
import { getStore } from "@netlify/blobs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const POS_TTL_MS = 7 * 24 * 3600 * 1000;   // found: keep for 7 days
const NEG_TTL_MS = 24 * 3600 * 1000;       // nothing found: 1 day

// Same best-effort per-IP rate limit as vessel.mjs (per-instance, 60/min).
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

// Parse the VF detail HTML. Only call on HTTP 200 (a 404 page has
// <title>Error 404 - VesselFinder</title> and would otherwise yield "Error 404" as the name).
function parseVf(html) {
  let name = null;
  const tm = html.match(/<title>([^<]*)<\/title>/i);
  if (tm) {
    const t = tm[1].trim();
    // format: "NAME, Type ship - Details ... - VesselFinder"
    const comma = t.indexOf(",");
    let cand = comma > 0 ? t.slice(0, comma).trim()
      : (t.indexOf(" - ") > 0 ? t.slice(0, t.indexOf(" - ")).trim() : "");
    // guard: don't use error pages / empty / generic titles as the name
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
    // CDN/browser may cache for a long time; the Blobs cache covers the scrape itself.
    "cache-control": "public, max-age=86400",
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

  const store = getStore("ais");
  const cacheKey = `vf/${mmsi}`;

  // Cache hit within TTL -> no VF request.
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
  } catch { /* blob read error: just scrape again */ }

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
    // non-200 (404/403/5xx) -> cache negatively, no error to the client
  } catch { /* network error -> return negative result, cache negatively */ }

  // Cache the result (positive and negative). fetchedAt determines the TTL.
  const record = { fetchedAt: Date.now(), name, photoUrl, vesselFinderUrl };
  try { await store.setJSON(cacheKey, record); } catch { /* ignore write error */ }

  return new Response(JSON.stringify({ name, photoUrl, vesselFinderUrl }), { headers });
};
