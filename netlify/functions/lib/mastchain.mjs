// Best-effort forward of newly received AIS messages to MastChain
// (https://api.mastchain.io), mimicking AIS-catcher's HTTP output format.
// Called from ingest on every Pi push; a cursor in Blobs ("mc-cursor")
// tracks what was already sent so overlapping raw buffers don't duplicate.
import { assembleRaw, decodeAis } from "./ais.mjs";

const UPLOAD_URL = "https://api.mastchain.io/api/upload";
const HEARTBEAT_S = 90;   // send an empty batch after this much silence (keeps the station "online")

const ts = epochS => {
  const d = new Date(epochS * 1000);
  const two = n => String(n).padStart(2, "0");
  return d.getUTCFullYear() + two(d.getUTCMonth() + 1) + two(d.getUTCDate())
       + two(d.getUTCHours()) + two(d.getUTCMinutes()) + two(d.getUTCSeconds());
};

export async function forwardToMastchain(store, state) {
  const userpwd = process.env.MASTCHAIN_USERPWD;
  if (!userpwd) return;
  try {
    const cursor = (await store.get("mc-cursor", { type: "json" })) || { lastT: 0, lastPost: 0 };
    const nowS = Date.now() / 1000;

    const fresh = assembleRaw(state.raw || []).filter(m => m.t > cursor.lastT);
    if (!fresh.length && nowS - cursor.lastPost < HEARTBEAT_S) return;

    const msgs = [];
    for (const f of fresh) {
      const d = decodeAis(f);
      if (!d) continue;
      msgs.push({
        class: "AIS", device: "AIS-catcher", rxtime: ts(f.t),
        scaled: true, channel: f.channel, nmea: f.nmea, ...d,
      });
    }

    const payload = {
      protocol: "jsonaiscatcher",
      encodetime: ts(nowS),
      stationid: "Matsutec",
      receiver: { description: "AIS-catcher v0.66", version: 66, engine: "Base (non-coherent)", setting: "" },
      device: { product: "MATSUTEC-AR10", vendor: "Matsutec", serial: "", setting: "NMEA0183 38400" },
      msgs,
    };

    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(userpwd).toString("base64"),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.log("mastchain: HTTP", res.status, await res.text().catch(() => ""));
      return;   // don't advance the cursor; retry these messages on the next push
    }
    if (fresh.length) cursor.lastT = Math.max(...fresh.map(m => m.t));
    cursor.lastPost = nowS;
    await store.setJSON("mc-cursor", cursor);
  } catch (e) {
    console.log("mastchain: forward failed:", e && e.message || e);
  }
}
