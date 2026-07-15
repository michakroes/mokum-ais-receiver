/* Mokum AIS dashboard - read-only, polls /api/state. */
const $ = id => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";

/* HTML-escape for everything that enters the DOM via innerHTML. Vessel names and
   mokum-radar fields cannot be trusted: an AIS name arrives over the air
   (the 6-bit charset contains < and >), so no escaping = XSS for every visitor. */
const ESC_MAP = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ESC_MAP[c]);
/* only allow http(s) links (no javascript:/data: from external data) */
function safeUrl(u){
  try { const p = new URL(u, location.href); return (p.protocol === "http:" || p.protocol === "https:") ? p.href : ""; }
  catch { return ""; }
}

/* ---------- dark mode ---------- */
(function initTheme(){
  const saved = localStorage.getItem("mokum-theme");
  const dark = saved ? saved === "dark"
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("dark", dark);
  setThemeIcon(dark);
})();
function setThemeIcon(dark){
  // moon in light mode (click = dark), sun in dark mode (click = light)
  const b = $("darkToggle"); if(!b) return;
  b.innerHTML = dark
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
}
$("darkToggle").addEventListener("click", () => {
  const dark = !document.body.classList.contains("dark");
  document.body.classList.toggle("dark", dark);
  localStorage.setItem("mokum-theme", dark ? "dark" : "light");
  setThemeIcon(dark);
});

/* ---------- map ---------- */
const AMS = { lat: 52.37, lng: 4.90 };
let gmap = null, AdvMarker = null, mapReady = false;
const markers = {};
let lastVessels = {};   // mmsi -> vessel (for click->detail)

const MOKUM = "https://mokum-radar.fly.dev";
const photoCache = {};   // mmsi -> true (has photo) / false (no photo)
function checkPhoto(mmsi){
  if(mmsi in photoCache) return;          // check only once per vessel
  photoCache[mmsi] = false;               // assumption: no photo until proven
  const img = new Image();
  img.onload = () => { photoCache[mmsi] = true; };   // photo exists -> blue on the next tick
  img.src = MOKUM + "/api/v2/vessel/" + mmsi + "/photo";
}
// photo = blue (in both themes, not the dark-mode neon), no photo = purple
function vesselColor(mmsi){
  return photoCache[mmsi] ? "#3366FF" : "#7C3AED";
}

/* ---------- VesselFinder fallback (name + photo) ----------
   Fills in name/photo when AIS + mokum-radar have nothing. Does NOT touch the
   marker color (that stays purely photoCache). /api/vf caches server-side in Blobs. */
const vfInfo = {};            // mmsi -> {name, photoUrl, vesselFinderUrl} or null (VF doesn't know either)
const vfQueue = [];           // mmsi's still to be fetched (table names)
const vfQueued = new Set();   // in the queue or already fetched -> don't queue again
let vfPumping = false;

async function vfFetch(mmsi){
  if(mmsi in vfInfo) return vfInfo[mmsi];
  try{
    const r = await fetch("/api/vf?mmsi=" + encodeURIComponent(mmsi), { cache: "no-store" });
    const d = await r.json();
    vfInfo[mmsi] = (d && !d.error && (d.name || d.photoUrl))
      ? { name: d.name || null, photoUrl: d.photoUrl || null, vesselFinderUrl: d.vesselFinderUrl || null }
      : null;
  }catch(e){ vfInfo[mmsi] = null; }
  return vfInfo[mmsi];
}

// Work through the queue sequentially, max ~1 request/s, only while the tab is visible.
async function pumpVfQueue(){
  if(vfPumping) return;
  vfPumping = true;
  try{
    while(vfQueue.length){
      if(document.hidden) break;         // hidden tab: pause, resume on return
      const mmsi = vfQueue.shift();
      if(mmsi in vfInfo) continue;
      await vfFetch(mmsi);
      await new Promise(res => setTimeout(res, 1000));
    }
  } finally { vfPumping = false; }
}

// Every tick: queue visible vessels without an AIS name (once).
function queueVfNames(vessels){
  if(document.hidden) return;
  vessels.forEach(v => {
    if(v.name || (v.mmsi in vfInfo) || vfQueued.has(v.mmsi)) return;
    vfQueued.add(v.mmsi);
    vfQueue.push(v.mmsi);
  });
  pumpVfQueue();
}

async function initMap(){
  if(!window.GMAPS_KEY){ $("map").innerHTML = '<div class="maperr">No GMAPS_KEY loaded - cannot show Google Maps.</div>'; return; }
  try{
    const { Map } = await google.maps.importLibrary("maps");
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    AdvMarker = AdvancedMarkerElement;
    gmap = new Map($("map"), {
      center: AMS, zoom: 13, minZoom: 10, maxZoom: 18,
      mapId: window.GMAPS_ID || undefined,
      disableDefaultUI: true, zoomControl: true,
      gestureHandling: "greedy", clickableIcons: false, keyboardShortcuts: false,
      backgroundColor: "#F3F6F9",
    });
    mapReady = true;
  }catch(e){ $("map").innerHTML = '<div class="maperr">Google Maps load error: ' + e.message + '</div>'; }
}

/* boat silhouette (hull, rotated to course) for moving vessels */
const HULL = "M14 3C17 7 19 11 19 16L19 22Q19 24 17 24L11 24Q9 24 9 22L9 16C9 11 11 7 14 3Z";
function boatEl(cog, color){
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 28 28"); svg.setAttribute("width", "26"); svg.setAttribute("height", "26");
  svg.classList.add("boat-mk");
  svg.style.filter = "drop-shadow(0 1px 1.4px rgba(9,28,53,.42))";
  const g = document.createElementNS(SVGNS, "g");
  g.setAttribute("transform", `rotate(${cog||0} 14 14)`);
  const halo = document.createElementNS(SVGNS, "path");
  halo.setAttribute("d", HULL); halo.setAttribute("fill", "none");
  halo.setAttribute("stroke", "#fff"); halo.setAttribute("stroke-width", "2.6"); halo.setAttribute("opacity", ".95");
  const body = document.createElementNS(SVGNS, "path");
  body.setAttribute("d", HULL); body.setAttribute("fill", color);
  body.setAttribute("stroke", "rgba(9,28,53,.55)"); body.setAttribute("stroke-width", ".8");
  const line = document.createElementNS(SVGNS, "path");
  line.setAttribute("d", "M14 7L14 22"); line.setAttribute("stroke", "rgba(255,255,255,.5)"); line.setAttribute("stroke-width", ".8");
  g.appendChild(halo); g.appendChild(body); g.appendChild(line); svg.appendChild(g);
  return svg;
}
/* small dot for stationary vessels (color = photo yes/no) */
function dotEl(color){
  const d = document.createElement("div");
  d.className = "boat-mk";
  d.style.cssText = "width:11px;height:11px;border-radius:50%;background:" + color + ";box-shadow:0 0 0 1.5px rgba(255,255,255,.85);transform:translateY(50%)";
  return d;
}

/* ---------- freshness ---------- */
function freshness(age){
  if(age == null) return { on:false, txt:"unknown" };
  if(age < 20) return { on:true, txt:"live" };
  if(age < 120) return { on:false, txt:`delayed ${age}s` };
  return { on:false, txt:`offline ${age}s` };
}

/* Push freshness (_ageSec) says nothing about RECEPTION: the Pi happily pushes
   an unchanged snapshot every few seconds too. So track separately when the
   last AIS message actually came in: newest timestamp from the raw feed +
   vessels[].last_seen (both Pi clock time, epoch s). */
function lastMsgEpoch(s){
  let t = 0;
  (s.raw || []).forEach(r => { if(r.t && r.t > t) t = r.t; });
  (s.vessels || []).forEach(v => { if(v.last_seen && v.last_seen > t) t = v.last_seen; });
  return t || null;
}
function gapTxt(sec){
  if(sec < 90) return Math.round(sec) + "s";
  if(sec < 5400) return Math.round(sec / 60) + "m";
  return (sec / 3600).toFixed(1) + "h";
}

/* ---------- Raspberry Pi host panel ---------- */
function fmtUptime(s){
  if(s < 3600) return Math.round(s / 60) + "m";
  if(s < 86400) return (s / 3600).toFixed(1) + "h";
  return Math.round(s / 86400) + "d";
}
const PI_SVC_LABEL = { "ais-forward":"forward", "ais-dashboard":"dashboard", "ais-cloud-push":"cloud" };
function renderPi(pi){
  const card = $("piCard");
  if(!pi){ card.hidden = true; return; }   // oude/live data zonder pi-blok: paneel verbergen
  card.hidden = false;

  const svc = pi.services || {};
  $("piSvc").innerHTML = Object.keys(PI_SVC_LABEL).map(k => {
    const st = svc[k] || "unknown";
    const ok = st === "active";
    return `<span class="pi-svc-item ${ok ? "ok" : "bad"}" title="${esc(k)}: ${esc(st)}"><span class="pi-dot"></span>${PI_SVC_LABEL[k]}</span>`;
  }).join("");

  const th = pi.throttled;
  const rows = [];
  if(pi.uptime_s != null) rows.push(["Uptime", fmtUptime(pi.uptime_s)]);
  if(pi.load1 != null) rows.push(["CPU load", pi.load1.toFixed(2) + (pi.ncpu ? " / " + pi.ncpu : ""), pi.ncpu && pi.load1 > pi.ncpu ? "warn" : ""]);
  if(pi.mem_used_mb != null && pi.mem_total_mb) rows.push(["RAM", pi.mem_used_mb + " / " + pi.mem_total_mb + " MB", pi.mem_used_mb / pi.mem_total_mb > 0.9 ? "warn" : ""]);
  if(pi.disk_pct != null) rows.push(["Disk", pi.disk_pct + "%", pi.disk_pct >= 90 ? "bad" : pi.disk_pct >= 80 ? "warn" : ""]);
  if(pi.temp_c != null) rows.push(["CPU temp", pi.temp_c + "°C", pi.temp_c >= 75 ? "bad" : pi.temp_c >= 65 ? "warn" : ""]);
  if(th) rows.push(["Power", th.status === "ok" ? "OK" : th.status === "warn" ? "throttled (past)" : "throttling now", th.status === "ok" ? "" : th.status]);
  $("piStats").innerHTML = rows.map(([l, v, cls]) =>
    `<div class="pi-row"><span class="l">${esc(l)}</span><span class="v ${cls || ""}">${esc(v)}</span></div>`).join("");

  const age = pi.at ? Math.max(0, Math.round(Date.now() / 1000 - pi.at)) : null;
  $("piMeta").textContent = age == null ? "" : (age < 90 ? age + "s ago" : gapTxt(age) + " ago");
}

/* ---------- fix log ---------- */
let seenLines = new Set();
let lastRaw = [];   // latest raw feed (for click -> byte breakdown + fragment reassembly)
function renderFeed(raw){
  lastRaw = raw;
  const box = $("raw");
  const keys = raw.map(r => (r.t || "") + "|" + (r.line || ""));
  box.innerHTML = raw.map((r, i) => {
    const t = r.t ? new Date(r.t * 1000).toLocaleTimeString("en-GB") : "";
    const fresh = !seenLines.has(keys[i]);
    return `<div class="l${fresh ? " flash" : ""}" data-i="${i}" title="Click for byte breakdown"><span class="t">${t}</span>${String(r.line||"").replace(/</g,"&lt;")}</div>`;
  }).join("");
  seenLines = new Set(keys);
  box.scrollTop = box.scrollHeight;
}
$("raw").addEventListener("click", e => {
  const el = e.target.closest(".l[data-i]");
  if(!el) return;
  const r = lastRaw[+el.dataset.i];
  if(r && r.line) openNmeaModal(r);
});

/* ============================================================
   NMEA/AIS byte breakdown - everything explained down to bit level.
   Purely client-side; works on the raw !AIVDM/!AIVDO line.
   ============================================================ */

/* AIS 6-bit "armored" payload-charset -> 0..63. */
function armorVal(ch){ let v = ch.charCodeAt(0) - 48; if(v > 40) v -= 8; return v; }
/* AIS 6-bit text charset (for names/callsign/destination). */
const AIS_TEXT = "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !\"#$%&'()*+,-./0123456789:;<=>?";

/* NMEA checksum: XOR of everything between the '!'/'$' and the '*'. */
function nmeaChecksum(line){
  const body = line.replace(/^[!$]/, "").split("*")[0];
  let c = 0;
  for(let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c;
}

/* Transport layer: !AIVDM,<count>,<num>,<seq>,<chan>,<payload>,<fill>*<cs> */
function parseNmea(line){
  const star = line.lastIndexOf("*");
  const stated = star >= 0 ? line.slice(star + 1).trim() : null;
  const fields = (star >= 0 ? line.slice(0, star) : line).split(",");
  return {
    line, fields,
    talker: fields[0] || "",
    fragCount: +fields[1] || 1,
    fragNum: +fields[2] || 1,
    seqId: fields[3] || "",
    channel: fields[4] || "",
    payload: fields[5] || "",
    fillBits: +fields[6] || 0,
    statedCs: stated,
    calcCs: nmeaChecksum(line),
  };
}

/* Pull all fragments of a multi-sentence message from the feed and glue the
   payload together. Only works if the whole set is in view. */
function assemblePayload(p){
  if(p.fragCount <= 1) return { payload: p.payload, fillBits: p.fillBits, complete: true, frags: 1 };
  const parts = [];
  for(const r of lastRaw){
    const q = parseNmea(String(r.line || ""));
    if(q.talker === p.talker && q.channel === p.channel && q.seqId === p.seqId && q.fragCount === p.fragCount)
      parts[q.fragNum] = q;
  }
  let payload = "", fill = 0, have = 0;
  for(let i = 1; i <= p.fragCount; i++){
    if(!parts[i]) return { payload: p.payload, fillBits: p.fillBits, complete: false, frags: p.fragCount, have };
    payload += parts[i].payload; fill = parts[i].fillBits; have++;
  }
  return { payload, fillBits: fill, complete: true, frags: p.fragCount, have };
}

/* Payload -> bitstring, with the armor table per character. */
function armorBits(payload, fillBits){
  let bits = "";
  const table = [];
  for(const ch of payload){
    const v = armorVal(ch);
    const b = (v & 63).toString(2).padStart(6, "0");
    table.push({ ch, val: v, bits: b });
    bits += b;
  }
  if(fillBits > 0) bits = bits.slice(0, bits.length - fillBits);   // fill bits are padding, not data
  return { bits, table };
}

/* Sequential bit reader that tracks [start,len]+raw bits per field. */
function bitReader(bits){
  let pos = 0;
  const grab = n => { const s = bits.substr(pos, n); pos += n; return { start: pos - n, len: n, bits: s }; };
  return {
    get pos(){ return pos; },
    left(){ return bits.length - pos; },
    u(n){ const t = grab(n); t.val = t.bits ? parseInt(t.bits, 2) : 0; return t; },
    i(n){ const t = grab(n); let v = t.bits ? parseInt(t.bits, 2) : 0; if(t.bits[0] === "1") v -= Math.pow(2, n); t.val = v; return t; },
    txt(chars){ const t = grab(chars * 6); let s = ""; for(let i = 0; i < t.bits.length; i += 6) s += AIS_TEXT[parseInt(t.bits.substr(i, 6), 2)] || ""; t.val = s.replace(/@+$/, "").replace(/\s+$/, ""); return t; },
  };
}

const MSG_NAMES = {
  1:"Position report (Class A)", 2:"Position report (Class A, assigned)", 3:"Position report (Class A, response)",
  4:"Base station report", 5:"Static & voyage data", 6:"Addressed binary", 7:"Binary ACK", 8:"Binary broadcast",
  9:"Search-and-rescue aircraft", 10:"UTC/date inquiry", 11:"UTC/date response", 12:"Safety message (addressed)",
  13:"Safety ACK", 14:"Safety message (broadcast)", 15:"Interrogation", 16:"Assignment", 17:"DGNSS corrections",
  18:"Position report (Class B)", 19:"Position report (Class B, extended)", 20:"Datalink management",
  21:"Aid to navigation (AtoN)", 22:"Channel management", 23:"Group assignment", 24:"Static data report (Class B)",
  25:"Single-slot binary", 26:"Multi-slot binary", 27:"Position report (long-range)",
};
const NAV_STATUS = ["Under way (engine)","At anchor","Not under command","Restricted manoeuvrability","Constrained by draught","Moored","Aground","Engaged in fishing","Under way (sailing)","(reserved)","(reserved)","(reserved)","(reserved)","(reserved)","AIS-SART","Undefined"];
const EPFD = ["Undefined","GPS","GLONASS","GPS+GLONASS","Loran-C","Chayka","Integrated","Surveyed","Galileo"];
const SHIPTYPE = { 30:"Fishing", 31:"Tug", 32:"Tug (large)", 33:"Dredger", 34:"Diving ops", 35:"Military", 36:"Sailing", 37:"Pleasure craft", 40:"High-speed craft (HSC)", 50:"Pilot vessel", 51:"Search & rescue", 52:"Tug", 53:"Port tender", 54:"Anti-pollution", 55:"Law enforcement", 60:"Passenger", 70:"Cargo", 80:"Tanker", 90:"Other" };
function shipTypeLabel(n){ if(n === 0) return "Not available"; if(SHIPTYPE[n]) return SHIPTYPE[n]; const base = Math.floor(n / 10) * 10; return (SHIPTYPE[base] ? SHIPTYPE[base] + " (variant)" : "type " + n); }

/* Splits the payload bits into AIS fields. Covers the types the AR-10 sees most
   in the Amsterdam canals; other types show up to MMSI + a tidy "not broken out"
   note. Each field carries its own [start,len]+bits so the modal can show exactly
   where in the bitstream it sits. */
function decodeAisReal(bits){
  const r = bitReader(bits);
  const F = [];
  const put = (label, tok, value, note) => { F.push({ label, start: tok.start, len: tok.len, bits: tok.bits, value, note }); return tok.val; };
  if(r.left() < 38) return { type: null, fields: F, note: "Payload too short to break out — most likely a lone fragment of a longer message." };

  const type = put("Message type", r.u(6), null);
  F[0].value = type + " — " + (MSG_NAMES[type] || "unknown");
  put("Repeat indicator", r.u(2), null); F[1].value = F[1].bits ? parseInt(F[1].bits, 2) + "× repeated" : "0×";
  const mmsi = put("MMSI", r.u(30), null); F[2].value = String(mmsi).padStart(9, "0");
  F[2].note = "Maritime Mobile Service Identity — unique vessel ID";

  const lon = v => v === 181 * 600000 ? "not available" : (v / 600000).toFixed(5) + "°";
  const lat = v => v === 91 * 600000 ? "not available" : (v / 600000).toFixed(5) + "°";
  const sogF = v => v === 1023 ? "not available" : v === 1022 ? "≥102.2 kn" : (v / 10).toFixed(1) + " kn";
  const cogF = v => v === 3600 ? "not available" : (v / 10).toFixed(1) + "°";
  const hdgF = v => v === 511 ? "not available" : v + "°";
  const rotF = v => { if(v === -128) return "not available"; if(v === 0) return "no turn"; const d = Math.round(Math.pow(v / 4.733, 2)) * Math.sign(v); return (v > 0 ? "starboard" : "port") + " ~" + Math.abs(d) + "°/min"; };
  const tsF = v => v <= 59 ? v + "s into the minute" : v === 60 ? "not available" : v === 62 ? "dead reckoning" : v === 63 ? "positioning system off" : String(v);
  const boolF = v => v ? "yes" : "no";

  const U = (label, n, f, note) => { const t = r.u(n); F.push({ label, start: t.start, len: t.len, bits: t.bits, value: f ? f(t.val) : String(t.val), note }); return t.val; };
  const I = (label, n, f, note) => { const t = r.i(n); F.push({ label, start: t.start, len: t.len, bits: t.bits, value: f ? f(t.val) : String(t.val), note }); return t.val; };
  const T = (label, chars, note) => { const t = r.txt(chars); F.push({ label, start: t.start, len: t.len, bits: t.bits, value: t.val ? '"' + t.val + '"' : "(empty)", note }); return t.val; };

  let handled = true;
  if(type === 1 || type === 2 || type === 3){
    U("Navigation status", 4, v => (NAV_STATUS[v] || v) + " (" + v + ")");
    I("Rate of turn", 8, rotF, "ROTais code");
    U("Speed over ground", 10, sogF);
    U("Position accuracy", 1, v => v ? "high (<10 m, DGPS)" : "low (>10 m)");
    I("Longitude", 28, lon);
    I("Latitude", 27, lat);
    U("Course over ground", 12, cogF);
    U("True heading", 9, hdgF);
    U("Timestamp", 6, tsF, "second of UTC fix");
    U("Maneuver indicator", 2, v => ["not available","no special maneuver","special maneuver"][v] || v);
    U("Spare", 3);
    U("RAIM flag", 1, boolF, "position integrity check");
    U("Radio status", 19, v => "0x" + v.toString(16));
  } else if(type === 4 || type === 11){
    U("Year (UTC)", 14, v => v || "n/a");
    U("Month", 4); U("Day", 5); U("Hour", 5); U("Minute", 6); U("Second", 6);
    U("Fix quality", 1, v => v ? "high" : "low");
    I("Longitude", 28, lon);
    I("Latitude", 27, lat);
    U("EPFD type", 4, v => EPFD[v] || v, "position source");
  } else if(type === 5){
    U("AIS version", 2);
    U("IMO number", 30, v => v || "none");
    T("Call sign", 7);
    T("Vessel name", 20);
    U("Ship type", 8, shipTypeLabel);
    const b = U("Dimension to bow", 9, v => v + " m"), s = U("to stern", 9, v => v + " m"),
          p = U("to port", 6, v => v + " m"), st = U("to starboard", 6, v => v + " m");
    F[F.length - 4].note = "hull: " + (b + s) + " m long × " + (p + st) + " m wide";
    U("EPFD type", 4, v => EPFD[v] || v);
    U("ETA month", 4); U("ETA day", 5); U("ETA hour", 5); U("ETA minute", 6);
    U("Draught", 8, v => (v / 10).toFixed(1) + " m");
    T("Destination", 20);
    U("DTE", 1, v => v ? "data terminal not ready" : "ready");
  } else if(type === 18){
    U("Reserved", 8);
    U("Speed over ground", 10, sogF);
    U("Position accuracy", 1, v => v ? "high" : "low");
    I("Longitude", 28, lon);
    I("Latitude", 27, lat);
    U("Course over ground", 12, cogF);
    U("True heading", 9, hdgF);
    U("Timestamp", 6, tsF);
    U("Reserved (regional)", 2);
    U("CS unit", 1, v => v ? "Carrier Sense (SOTDMA)" : "ITDMA");
    U("Display", 1, boolF, "has display");
    U("DSC", 1, boolF); U("Band", 1, boolF); U("Can message 22", 1, boolF);
    U("Assigned", 1, boolF); U("RAIM flag", 1, boolF); U("Radio status", 20, v => "0x" + v.toString(16));
  } else if(type === 19){
    U("Reserved", 8);
    U("Speed over ground", 10, sogF);
    U("Position accuracy", 1, v => v ? "high" : "low");
    I("Longitude", 28, lon);
    I("Latitude", 27, lat);
    U("Course over ground", 12, cogF);
    U("True heading", 9, hdgF);
    U("Timestamp", 6, tsF);
    U("Reserved (regional)", 4);
    T("Vessel name", 20);
    U("Ship type", 8, shipTypeLabel);
    U("Dimension to bow", 9, v => v + " m"); U("to stern", 9, v => v + " m");
    U("to port", 6, v => v + " m"); U("to starboard", 6, v => v + " m");
    U("EPFD type", 4, v => EPFD[v] || v);
  } else if(type === 21){
    U("AtoN type", 5, v => "code " + v, "aid-to-navigation type");
    T("Name", 20);
    U("Position accuracy", 1, v => v ? "high" : "low");
    I("Longitude", 28, lon);
    I("Latitude", 27, lat);
    U("Dimension to bow", 9, v => v + " m"); U("to stern", 9, v => v + " m");
    U("to port", 6, v => v + " m"); U("to starboard", 6, v => v + " m");
    U("EPFD type", 4, v => EPFD[v] || v);
    U("Timestamp", 6, tsF);
    U("Off-position", 1, boolF); U("Regional", 8); U("RAIM flag", 1, boolF);
    U("Virtual", 1, v => v ? "virtual AtoN" : "real AtoN"); U("Assigned", 1, boolF);
  } else if(type === 24){
    const part = r.u(2); F.push({ label:"Part", start:part.start, len:part.len, bits:part.bits, value:"part " + part.val + (part.val === 0 ? " (A: name)" : " (B: type/dimensions)") });
    if(part.val === 0){
      T("Vessel name", 20);
    } else {
      U("Ship type", 8, shipTypeLabel);
      T("Vendor ID", 3);
      U("Model", 4); U("Serial number", 20);
      T("Call sign", 7);
      U("Dimension to bow", 9, v => v + " m"); U("to stern", 9, v => v + " m");
      U("to port", 6, v => v + " m"); U("to starboard", 6, v => v + " m");
    }
  } else if(type === 27){
    U("Position accuracy", 1, v => v ? "high" : "low");
    U("RAIM flag", 1, boolF);
    U("Navigation status", 4, v => NAV_STATUS[v] || v);
    I("Longitude", 18, v => (v === 0x1a838 ? "not available" : (v / 600).toFixed(4) + "°"), "low resolution (1/10 min)");
    I("Latitude", 17, v => (v === 0xd548 ? "not available" : (v / 600).toFixed(4) + "°"), "low resolution");
    U("Speed over ground", 6, v => v === 63 ? "not available" : v + " kn");
    U("Course over ground", 9, v => v === 511 ? "not available" : v + "°");
    U("GNSS position", 1, v => v ? "last fix" : "current");
  } else {
    handled = false;
  }
  return { type, fields: F, note: handled ? null : "Message type " + type + " (" + (MSG_NAMES[type] || "unknown") + ") is not broken out field-by-field — only the header (type, repeat, MMSI) above." };
}

/* ---------- byte dump of the raw line ---------- */
function byteDump(line){
  const out = [];
  for(let i = 0; i < line.length; i++){
    const code = line.charCodeAt(i);
    out.push({ ch: line[i], hex: code.toString(16).toUpperCase().padStart(2, "0") });
  }
  return out;
}

/* ---------- build & show the modal ---------- */
function ensureModal(){
  let m = $("nmeaModal");
  if(m) return m;
  m = document.createElement("div");
  m.id = "nmeaModal"; m.className = "nm-back"; m.hidden = true;
  m.innerHTML = '<div class="nm-card glass" role="dialog" aria-modal="true" aria-label="NMEA byte breakdown">'
    + '<button class="nm-close" aria-label="Close">&times;</button><div class="nm-scroll" id="nmBody"></div></div>';
  document.body.appendChild(m);
  m.addEventListener("click", e => { if(e.target === m) closeNmeaModal(); });
  m.querySelector(".nm-close").addEventListener("click", closeNmeaModal);
  return m;
}
function closeNmeaModal(){ const m = $("nmeaModal"); if(m) m.hidden = true; }
document.addEventListener("keydown", e => { if(e.key === "Escape") closeNmeaModal(); });

function fieldTable(fields){
  const rows = fields.map(f => {
    const grp = String(f.bits || "").replace(/(.{6})/g, "$1 ").trim();
    const range = f.len ? `${f.start}–${f.start + f.len - 1}` : "-";
    return `<tr><td class="nm-fl">${esc(f.label)}${f.note ? `<span class="nm-note">${esc(f.note)}</span>` : ""}</td>`
      + `<td class="mono nm-rng">${range}<span class="nm-len">${f.len} bit</span></td>`
      + `<td class="mono nm-bits">${esc(grp) || "-"}</td>`
      + `<td class="nm-val">${esc(f.value == null ? "" : String(f.value))}</td></tr>`;
  }).join("");
  return `<table class="nm-tbl"><thead><tr><th>Field</th><th>Bits</th><th>Raw bits</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function openNmeaModal(rec){
  const line = String(rec.line || "");
  const m = ensureModal();
  const p = parseNmea(line);
  const asm = assemblePayload(p);
  const ab = armorBits(asm.payload, asm.fillBits);
  const ais = decodeAisReal(ab.bits);
  const csOk = p.statedCs != null && p.calcCs === parseInt(p.statedCs, 16);
  const tTxt = rec.t ? new Date(rec.t * 1000).toLocaleString("en-GB") : "";

  // transport-layer table
  const tl = [
    ["Talker + type", esc(p.talker), talkerNote(p.talker)],
    ["Fragment count", p.fragCount, p.fragCount > 1 ? "message split across multiple sentences" : "1 sentence = complete message"],
    ["Fragment number", p.fragNum, p.fragCount > 1 ? "which sentence this is" : ""],
    ["Sequence ID", p.seqId || "(empty)", p.fragCount > 1 ? "links the fragments" : "only for multi-sentence"],
    ["Channel", esc(p.channel), p.channel === "A" ? "161.975 MHz (AIS 1)" : p.channel === "B" ? "162.025 MHz (AIS 2)" : ""],
    ["Payload", `<span class="mono nm-pl">${esc(p.payload)}</span>`, p.payload.length + " chars, 6-bit armored"],
    ["Fill bits", p.fillBits, "padding bits at the end of the payload"],
  ].map(([k, v, n]) => `<tr><td class="nm-fl">${esc(k)}</td><td class="nm-val">${v}${n ? `<span class="nm-note">${esc(n)}</span>` : ""}</td></tr>`).join("");

  // checksum
  const cs = `<div class="nm-cs ${csOk ? "ok" : "bad"}">`
    + `<span class="nm-cs-badge">${csOk ? "✓ checksum valid" : "✗ checksum INVALID"}</span>`
    + `<span class="mono">stated *${esc(p.statedCs || "?")} &middot; computed ${p.calcCs.toString(16).toUpperCase().padStart(2, "0")}</span>`
    + `<span class="nm-note">XOR of every byte between '!' and '*'</span></div>`;

  // byte-dump
  const bd = byteDump(line).map(b =>
    `<span class="nm-byte"><span class="nm-bhex">${b.hex}</span><span class="nm-bchar">${esc(b.ch === " " ? "·" : b.ch)}</span></span>`
  ).join("");

  // 6-bit armor table
  const armor = ab.table.map(x =>
    `<span class="nm-arm"><b>${esc(x.ch)}</b><span class="nm-arm-v">${x.val}</span><span class="mono nm-arm-b">${x.bits}</span></span>`
  ).join("");

  // bitstream (grouped by 6)
  const grouped = ais.type == null ? "" : ab.bits.replace(/(.{6})/g, "$1 ").trim();

  const fragNote = asm.complete
    ? (p.fragCount > 1 ? `<div class="nm-info">All ${asm.frags} fragments merged into one payload.</div>` : "")
    : `<div class="nm-info warn">Multi-sentence message: only ${asm.have}/${p.fragCount} fragments visible. The payload decode below is incomplete.</div>`;

  $("nmBody").innerHTML =
      `<div class="nm-h"><div class="nm-title">NMEA byte breakdown</div>${tTxt ? `<div class="nm-time mono">${esc(tTxt)}</div>` : ""}</div>`
    + `<pre class="nm-raw mono">${esc(line)}</pre>`
    + cs
    + section("1 &middot; Bytes on the wire", `<div class="nm-hint">Every byte of the line as received (hex + char). ${line.length} bytes.</div><div class="nm-bytes">${bd}</div>`)
    + section("2 &middot; NMEA transport layer", `<table class="nm-tbl kv"><tbody>${tl}</tbody></table>`)
    + section("3 &middot; 6-bit ASCII armoring", `<div class="nm-hint">Each payload char → value 0–63 → 6 bits. ${asm.fillBits ? `The last ${asm.fillBits} bit(s) are fill and don't count.` : ""}</div><div class="nm-arms">${armor}</div>`)
    + (grouped ? section("4 &middot; Bitstream", `<div class="nm-hint">${ab.bits.length} data bits, grouped by 6.</div><pre class="nm-stream mono">${esc(grouped)}</pre>`) : "")
    + section("5 &middot; AIS payload decoded", fragNote + fieldTable(ais.fields) + (ais.note ? `<div class="nm-info">${esc(ais.note)}</div>` : ""));

  m.hidden = false;
  $("nmBody").scrollTop = 0;
}
function section(title, inner){ return `<div class="nm-sec"><div class="nm-sec-h">${title}</div>${inner}</div>`; }
function talkerNote(t){
  if(t === "!AIVDM") return "AIS from another vessel (VHF Data-link Message)";
  if(t === "!AIVDO") return "AIS from own station";
  return t.startsWith("!") || t.startsWith("$") ? "NMEA 0183 sentence" : "";
}

/* ---------- tick ---------- */
function setOffline(msg){
  $("statepill").classList.remove("on");
  $("statepill").classList.remove("quiet");
  $("stateTxt").textContent = "offline";
  const e = $("err"); e.style.display = "block"; e.textContent = msg;
}
function fmt(x, d=1){ return x == null ? "-" : (typeof x === "number" ? x.toFixed(d) : x); }

let ticking = false;
async function tick(){
  if(ticking) return;            // no overlapping fetches on a slow /api/state
  ticking = true;
  try { await tickBody(); } finally { ticking = false; }
}
async function tickBody(){
  let s;
  try{
    const r = await fetch("/api/state", { cache: "no-store" });
    if(r.status === 404){ setOffline("No data from the station yet."); return; }
    s = await r.json();
  }catch(e){ setOffline("No connection to the cloud."); return; }
  if(s.error){ setOffline(s.error); return; }
  $("err").style.display = "none";

  const fr = freshness(s._ageSec);
  // Make a reception lull visible: chain live but no AIS message for 3+ min -> amber "quiet".
  const lastMsg = lastMsgEpoch(s);
  const gap = lastMsg ? Math.max(0, Date.now() / 1000 - lastMsg) : null;
  const quiet = fr.on && gap != null && gap >= 180;
  $("statepill").classList.toggle("on", fr.on);
  $("statepill").classList.toggle("quiet", quiet);
  $("stateTxt").textContent = quiet ? `live · quiet ${gapTxt(gap)}` : fr.txt;
  $("lastMsgSub").textContent = gap == null ? "received" : `last: ${gapTxt(gap)} ago`;
  $("ageMeta").textContent = s._ageSec == null ? "-" : (s._ageSec + "s ago");
  renderPi(s.pi);
  $("port").textContent = s.serial_port || "-";
  $("sentences").textContent = s.sentences || 0;
  $("decoded").textContent = s.decoded || 0;
  $("spmSub").textContent = (s.sentences_per_sec || 0) + "/s";
  $("vessels").textContent = s.vessel_count || 0;
  $("positioned").textContent = s.positioned || 0;
  $("bytes").textContent = s.bytes || 0;
  $("errors").textContent = s.errors || 0;
  $("typesMeta").textContent = (s.types && Object.keys(s.types).length)
    ? Object.entries(s.types).sort((a,b)=>a[0]-b[0]).map(([k,v])=>`t${k}:${v}`).join(" ") : "-";

  const vessels = s.vessels || [];
  lastVessels = {}; vessels.forEach(v => { lastVessels[v.mmsi] = v; });
  $("shipMeta").textContent = vessels.length ? `${vessels.length} visible` : "newest first";
  const rows = $("rows");
  if(!vessels.length){
    rows.innerHTML = `<tr><td colspan="4" class="empty">${fr.on ? "Waiting for first vessel (reception)&hellip;" : "No recent data from the station."}</td></tr>`;
  } else {
    rows.innerHTML = vessels.map(v => {
      const moving = (v.sog != null && v.sog >= 0.5);
      const st = v.lat == null ? '<span class="pill no">no pos</span>'
        : (moving ? '<span class="pill mv">moving</span>' : '<span class="pill st">idle</span>');
      // AIS name always wins -> VF name with badge -> "-"
      const vf = vfInfo[v.mmsi];
      const nm = v.name ? esc(v.name)
        : (vf && vf.name) ? esc(vf.name) + '<span class="pill vf" title="Name via VesselFinder">VF</span>'
        : '<span style="color:var(--ink-faint)">-</span>';
      return `<tr class="vrow" data-mmsi="${esc(v.mmsi)}"><td class="mono">${esc(v.mmsi)}</td>
      <td class="nm">${nm}</td>
      <td class="mono">${v.sog == null ? "-" : fmt(v.sog)}</td>
      <td>${st}</td></tr>`;
    }).join("");
  }
  queueVfNames(vessels);   // fetch names without AIS via VF (for the next tick)

  // Map markers in a try/catch: a map hiccup (e.g. referer error) must NEVER
  // break the rest of the UI (vessel list, feed).
  if(mapReady){
    try{
      const seen = {};
      vessels.filter(v => v.lat != null).forEach(v => {
        seen[v.mmsi] = 1;
        const moving = (v.sog != null && v.sog >= 0.5);
        const cog = (v.cog != null && v.cog < 360) ? v.cog : (v.heading != null ? v.heading : 0);
        checkPhoto(v.mmsi);
        const color = vesselColor(v.mmsi);   // blue = photo, purple = no photo
        const el = moving ? boatEl(cog, color) : dotEl(color);
        const pos = { lat: v.lat, lng: v.lon };
        const vfName = (vfInfo[v.mmsi] && vfInfo[v.mmsi].name) || null;
        const title = (v.name || vfName || String(v.mmsi)) + " · " + (v.sog == null ? "?" : fmt(v.sog) + "kn");
        if(markers[v.mmsi]){ markers[v.mmsi].position = pos; markers[v.mmsi].content = el; markers[v.mmsi].title = title; }
        else {
          const mk = new AdvMarker({ map: gmap, position: pos, content: el, title, gmpClickable: true });
          mk.addListener("click", () => selectVessel(lastVessels[v.mmsi]));
          markers[v.mmsi] = mk;
        }
      });
      Object.keys(markers).forEach(m => { if(!seen[m]){ markers[m].map = null; delete markers[m]; } });
    }catch(e){ /* map error ignored - feed/list keep working */ }
  }

  renderFeed(s.raw || []);
}

/* ---------- click vessel -> detail via mokum-radar proxy ---------- */
const TYPE_EN = { passenger:"Passenger", cargo:"Cargo", tanker:"Tanker", service:"Service", "high-speed":"High-speed", recreational:"Recreational", other:"Other" };
function typeLabel(cat, num){ return (cat && TYPE_EN[cat]) || (num != null ? "type " + num : "-"); }

let detailMmsi = null;   // which vessel is open now (async VF callbacks ignore stale updates)

// Name in the detail panel; fromVf adds a VF badge (name always via esc()).
function setDtName(name, fromVf){
  const el = $("dtName");
  if(fromVf) el.innerHTML = esc(name) + '<span class="pill vf" title="Name via VesselFinder">VF</span>';
  else el.textContent = name;
}
// Show the VF photo in dtPhoto with source attribution. Own onerror for the
// placeholder edge case (then show nothing instead of a broken image).
function showVfPhoto(mmsi){
  const info = vfInfo[mmsi];
  if(!info || !info.photoUrl) return;
  const src = safeUrl(info.photoUrl);
  if(!src) return;
  const ph = $("dtPhoto");
  const img = new Image(); img.alt = "";
  img.onload = () => {
    if(detailMmsi !== mmsi) return;
    ph.innerHTML = "";
    ph.appendChild(img);
    const cap = document.createElement("div");
    cap.className = "dt-photo-src"; cap.textContent = "photo: VesselFinder";
    ph.appendChild(cap);
  };
  img.onerror = () => {};   // VF placeholder/404: leave dtPhoto empty
  img.src = src;
}
// VF supplement for the detail panel. Deliberately flag-driven: a failing
// mokum PHOTO may only replace the photo (name:false), so a name that
// mokum/AIS did provide doesn't get a VF badge after all. The name badge only
// appears when neither AIS (v.name) nor mokum had a name. Stale updates ignored.
async function vfApply(v, { name = false, photo = false } = {}){
  if(detailMmsi !== v.mmsi) return;
  const info = await vfFetch(v.mmsi);
  if(detailMmsi !== v.mmsi || !info) return;
  if(name && !v.name && info.name) setDtName(info.name, true);
  if(photo && info.photoUrl) showVfPhoto(v.mmsi);
  if(info.vesselFinderUrl){ const u = safeUrl(info.vesselFinderUrl); if(u) $("dtVf").href = u; }
}

function detailRows(v, d){
  const info = (d && d.info) || {}, live = (d && d.live) || {};
  const sog = live.sog != null ? live.sog : v.sog;
  const cog = live.cog != null ? live.cog : v.cog;
  const rows = [
    ["Speed", sog == null ? "-" : fmt(sog) + " kn"],
    ["Course", (cog == null || cog >= 360) ? "-" : Math.round(cog) + "°"],
    ["Type", typeLabel(info.shipCategory, info.shipType)],
    ["Length", info.lengthM ? info.lengthM + " m" : "-"],
    ["Class", info.aisClass ? "Class " + info.aisClass : "-"],
  ];
  $("dtRows").innerHTML = rows.map(([l, val]) => `<div class="dt-row"><span class="l">${esc(l)}</span><span class="v">${esc(val)}</span></div>`).join("");
}
function applyDetail(v, d){
  const info = d.info || {};
  const nm = info.name || v.name;
  if(nm) setDtName(nm, false);
  else { setDtName("MMSI " + v.mmsi, false); vfApply(v, { name: true }); }   // no mokum/AIS name -> VF name
  const op = $("dtOp"); op.innerHTML = "";
  if(info.operator){
    if(info.operatorLogoUrl){ const im = document.createElement("img"); im.src = MOKUM + info.operatorLogoUrl; im.onerror = () => im.remove(); op.appendChild(im); }
    op.appendChild(document.createTextNode(info.operator));
  }
  const ph = $("dtPhoto"); ph.innerHTML = "";
  const img = new Image(); img.alt = "";
  img.onload = () => { if(detailMmsi === v.mmsi){ ph.innerHTML = ""; ph.appendChild(img); } };
  img.onerror = () => { if(detailMmsi === v.mmsi) vfApply(v, { photo: true }); };   // mokum photo fails -> VF photo only
  img.src = MOKUM + "/api/v2/vessel/" + v.mmsi + "/photo";
  const vfUrl = info.vesselFinderUrl && safeUrl(info.vesselFinderUrl);
  if(vfUrl) $("dtVf").href = vfUrl;
  detailRows(v, d);
  $("dtNote").textContent = (!info.operator && !info.lengthM) ? "Limited info (outside the Amsterdam canals)." : "";
}
async function selectVessel(v){
  if(!v) return;
  detailMmsi = v.mmsi;
  $("detail").hidden = false;
  $("dtPhoto").innerHTML = ""; $("dtOp").innerHTML = ""; $("dtNote").textContent = "";
  // show an already-known VF name immediately (badge); otherwise AIS name or MMSI
  const known = vfInfo[v.mmsi];
  if(!v.name && known && known.name) setDtName(known.name, true);
  else setDtName(v.name || ("MMSI " + v.mmsi), false);
  const vf = $("dtVf"); vf.href = "https://www.vesselfinder.com/?mmsi=" + v.mmsi; vf.hidden = false;
  detailRows(v, null);
  try{
    const r = await fetch("/api/vessel?mmsi=" + encodeURIComponent(v.mmsi), { cache: "no-store" });
    const d = await r.json();
    if(detailMmsi !== v.mmsi) return;   // another vessel was clicked in the meantime
    if(d && !d.error) applyDetail(v, d);
    else { $("dtNote").textContent = "No extra info from mokum-radar."; vfApply(v, { name: true, photo: true }); }
  }catch(e){ if(detailMmsi === v.mmsi){ $("dtNote").textContent = "Detail info not available."; vfApply(v, { name: true, photo: true }); } }
}
$("dtClose").addEventListener("click", () => { $("detail").hidden = true; });
$("rows").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-mmsi]");
  if(tr) selectVessel(lastVessels[tr.dataset.mmsi]);
});

initMap();
tick();
// Only poll while the tab is visible: a hidden tab doesn't need to query the
// cloud every 2s (saves Netlify invocations). Refresh immediately on return.
setInterval(() => { if(!document.hidden) tick(); }, 2000);
document.addEventListener("visibilitychange", () => { if(!document.hidden) tick(); });
