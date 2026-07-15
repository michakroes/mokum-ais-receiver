// Serveert de laatste snapshot (publiek, read-only) aan de frontend.
// Voegt _ageSec toe (server-side berekend) zodat de frontend versheid kan tonen
// zonder afhankelijk te zijn van de klok van de bezoeker.
import { getStore } from "@netlify/blobs";

export default async () => {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  };

  const store = getStore("ais");
  const doc = await store.get("latest", { type: "json" });
  if (!doc) {
    return new Response(JSON.stringify({ error: "nog geen data van het station" }), {
      status: 404,
      headers,
    });
  }

  const ageSec = Math.max(0, Math.round((Date.now() - (doc.receivedAt || 0)) / 1000));

  // Schepen die langer dan 12h (VESSEL_MAX_AGE_H) geen contact hadden weglaten.
  const state = { ...(doc.state || {}) };
  const maxAgeS = (Number(process.env.VESSEL_MAX_AGE_H) || 12) * 3600;
  const nowS = Date.now() / 1000;
  if (Array.isArray(state.vessels)) {
    state.vessels = state.vessels.filter(v => v.last_seen == null || (nowS - v.last_seen) <= maxAgeS);
    state.vessel_count = state.vessels.length;
    state.positioned = state.vessels.filter(v => v.lat != null).length;
  }

  return new Response(JSON.stringify({ ...state, _ageSec: ageSec }), { headers });
};
