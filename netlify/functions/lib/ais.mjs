// Minimal AIVDM parser/decoder for the MastChain forward.
// Produces AIS-catcher-style JSON fields (gpsd naming) for the message types
// this station actually receives; anything else is forwarded header-only.

const NAV_STATUS = [
  "Under way using engine", "At anchor", "Not under command", "Restricted manoeuverability",
  "Constrained by her draught", "Moored", "Aground", "Engaged in Fishing", "Under way sailing",
  "Reserved for future amendment of Navigational Status for HSC",
  "Reserved for future amendment of Navigational Status for WIG",
  "Reserved for future use", "Reserved for future use", "Reserved for future use",
  "AIS-SART is active", "Not defined",
];

// ---------- NMEA transport layer ----------

function checksumOk(line) {
  const star = line.lastIndexOf("*");
  if (line[0] !== "!" || star < 0) return false;
  let cs = 0;
  for (let i = 1; i < star; i++) cs ^= line.charCodeAt(i);
  return cs === parseInt(line.slice(star + 1, star + 3), 16);
}

// 6-bit ASCII armoring -> bit string ("0"/"1"), minus fill bits.
function armorToBits(payload, fill) {
  let bits = "";
  for (const ch of payload) {
    let v = ch.charCodeAt(0) - 48;
    if (v > 40) v -= 8;
    if (v < 0 || v > 63) return null;
    bits += v.toString(2).padStart(6, "0");
  }
  return fill > 0 ? bits.slice(0, -fill) : bits;
}

/* Groups raw records ({t, line}) into complete messages. Multi-fragment
   messages are keyed on channel+seqId and emitted with the timestamp of the
   final fragment (incomplete groups are dropped silently). */
export function assembleRaw(records) {
  const out = [];
  const pending = {}; // "channel:seqId" -> { frags: {num: {line, bits}}, count }
  for (const r of records) {
    const line = String(r.line || "").trim();
    const p = line.split(",");
    if (p.length < 7 || !line.startsWith("!AIVD") || !checksumOk(line)) continue;
    const fragCount = +p[1], fragNum = +p[2], channel = p[4] || "A";
    const fill = +((p[6] || "0").split("*")[0]) || 0;
    const bits = armorToBits(p[5] || "", fill);
    if (bits == null || !fragCount || !fragNum) continue;
    if (fragCount === 1) {
      out.push({ t: r.t, channel, nmea: [line], bits });
      continue;
    }
    const key = channel + ":" + (p[3] || "");
    const grp = pending[key] || (pending[key] = { frags: {}, count: fragCount });
    grp.frags[fragNum] = { line, bits };
    if (Object.keys(grp.frags).length === grp.count) {
      let all = "", nmea = [];
      for (let i = 1; i <= grp.count; i++) { all += grp.frags[i].bits; nmea.push(grp.frags[i].line); }
      out.push({ t: r.t, channel, nmea, bits: all });
      delete pending[key];
    }
  }
  return out;
}

// ---------- payload decoding ----------

function reader(bits) {
  let pos = 0;
  const u = n => { const v = parseInt(bits.slice(pos, pos + n), 2); pos += n; return v; };
  const i = n => { let v = u(n); if (v >= 1 << (n - 1)) v -= 1 << n; return v; };
  const txt = chars => {
    let s = "";
    for (let c = 0; c < chars; c++) {
      const v = parseInt(bits.slice(pos, pos + 6), 2); pos += 6;
      if (v === 0) { pos += 6 * (chars - c - 1); break; }   // '@' terminates
      s += String.fromCharCode(v < 32 ? v + 64 : v);
    }
    return s.trim();
  };
  const left = () => bits.length - pos;
  return { u, i, txt, left };
}

const two = n => String(n).padStart(2, "0");

/* Decodes one assembled message into AIS-catcher/gpsd-style fields.
   Returns null if even the header doesn't fit. */
export function decodeAis(msg) {
  const r = reader(msg.bits);
  if (r.left() < 38) return null;
  const m = { type: r.u(6), repeat: r.u(2), mmsi: r.u(30) };
  try {
    if ((m.type === 1 || m.type === 2 || m.type === 3) && r.left() >= 130) {
      m.status = r.u(4); m.status_text = NAV_STATUS[m.status];
      m.turn = r.i(8);
      m.speed = r.u(10) / 10; m.accuracy = !!r.u(1);
      m.lon = +(r.i(28) / 600000).toFixed(6); m.lat = +(r.i(27) / 600000).toFixed(6);
      m.course = r.u(12) / 10; m.heading = r.u(9); m.second = r.u(6);
      m.maneuver = r.u(2); r.u(3); m.raim = !!r.u(1); m.radio = r.u(19);
    } else if (m.type === 4 && r.left() >= 130) {
      const y = r.u(14), mo = r.u(4), d = r.u(5), h = r.u(5), mi = r.u(6), s = r.u(6);
      Object.assign(m, { year: y, month: mo, day: d, hour: h, minute: mi, second: s });
      if (y && mo && d) m.timestamp = `${y}-${two(mo)}-${two(d)}T${two(h)}:${two(mi)}:${two(s)}Z`;
      m.accuracy = !!r.u(1);
      m.lon = +(r.i(28) / 600000).toFixed(6); m.lat = +(r.i(27) / 600000).toFixed(6);
      m.epfd = r.u(4);
    } else if (m.type === 5 && r.left() >= 380) {
      m.ais_version = r.u(2); m.imo = r.u(30);
      m.callsign = r.txt(7); m.shipname = r.txt(20); m.shiptype = r.u(8);
      m.to_bow = r.u(9); m.to_stern = r.u(9); m.to_port = r.u(6); m.to_starboard = r.u(6);
      m.epfd = r.u(4);
      m.month = r.u(4); m.day = r.u(5); m.hour = r.u(5); m.minute = r.u(6);
      m.eta = `${two(m.month)}-${two(m.day)}T${two(m.hour)}:${two(m.minute)}Z`;
      m.draught = r.u(8) / 10; m.destination = r.txt(20); m.dte = r.u(1);
    } else if (m.type === 18 && r.left() >= 130) {
      m.reserved = r.u(8);
      m.speed = r.u(10) / 10; m.accuracy = !!r.u(1);
      m.lon = +(r.i(28) / 600000).toFixed(6); m.lat = +(r.i(27) / 600000).toFixed(6);
      m.course = r.u(12) / 10; m.heading = r.u(9); m.second = r.u(6);
      m.regional = r.u(2); m.cs = !!r.u(1); m.display = !!r.u(1); m.dsc = !!r.u(1);
      m.band = !!r.u(1); m.msg22 = !!r.u(1); m.assigned = !!r.u(1);
      m.raim = !!r.u(1); m.radio = r.u(20);
    } else if (m.type === 19 && r.left() >= 273) {
      m.reserved = r.u(8);
      m.speed = r.u(10) / 10; m.accuracy = !!r.u(1);
      m.lon = +(r.i(28) / 600000).toFixed(6); m.lat = +(r.i(27) / 600000).toFixed(6);
      m.course = r.u(12) / 10; m.heading = r.u(9); m.second = r.u(6);
      m.regional = r.u(4); m.shipname = r.txt(20); m.shiptype = r.u(8);
      m.to_bow = r.u(9); m.to_stern = r.u(9); m.to_port = r.u(6); m.to_starboard = r.u(6);
      m.epfd = r.u(4); m.raim = !!r.u(1); m.dte = r.u(1); m.assigned = !!r.u(1);
    } else if (m.type === 24 && r.left() >= 2) {
      m.partno = r.u(2);
      if (m.partno === 0 && r.left() >= 120) {
        m.shipname = r.txt(20);
      } else if (m.partno === 1 && r.left() >= 120) {
        m.shiptype = r.u(8); m.vendorid = r.txt(3); m.model = r.u(4); m.serial = r.u(20);
        m.callsign = r.txt(7);
        m.to_bow = r.u(9); m.to_stern = r.u(9); m.to_port = r.u(6); m.to_starboard = r.u(6);
      }
    } else if (m.type === 27 && r.left() >= 58) {
      m.accuracy = !!r.u(1); m.raim = !!r.u(1);
      m.status = r.u(4); m.status_text = NAV_STATUS[m.status];
      m.lon = +(r.i(18) / 600).toFixed(4); m.lat = +(r.i(17) / 600).toFixed(4);
      m.speed = r.u(6); m.course = r.u(9); m.gnss = !r.u(1);
    }
    // any other type: header only (type/repeat/mmsi) + the raw sentences
  } catch { /* header-only on any decode hiccup */ }
  return m;
}
