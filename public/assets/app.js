/* Mokum AIS dashboard - read-only, pollt /api/state. */
const $ = id => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";

/* ---------- dark mode ---------- */
(function initTheme(){
  const saved = localStorage.getItem("mokum-theme");
  const dark = saved ? saved === "dark"
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("dark", dark);
  setThemeIcon(dark);
})();
function setThemeIcon(dark){
  // maan bij licht (klik = donker), zon bij donker (klik = licht)
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

/* ---------- kaart ---------- */
const AMS = { lat: 52.37, lng: 4.90 };
let gmap = null, AdvMarker = null, mapReady = false;
const markers = {};
let lastVessels = {};   // mmsi -> vessel (voor klik->detail)

const MOKUM = "https://mokum-radar.fly.dev";
const photoCache = {};   // mmsi -> true (heeft foto) / false (geen foto)
function checkPhoto(mmsi){
  if(mmsi in photoCache) return;          // maar 1x checken per schip
  photoCache[mmsi] = false;               // aanname: geen foto tot bewezen
  const img = new Image();
  img.onload = () => { photoCache[mmsi] = true; };   // foto bestaat -> blauw bij de volgende tick
  img.src = MOKUM + "/api/v2/vessel/" + mmsi + "/photo";
}
// foto = blauw, geen foto = paars
function vesselColor(mmsi){ return photoCache[mmsi] ? "#3366FF" : "#7C3AED"; }

async function initMap(){
  if(!window.GMAPS_KEY){ $("map").innerHTML = '<div class="maperr">Geen GMAPS_KEY geladen - kan Google Maps niet tonen.</div>'; return; }
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
  }catch(e){ $("map").innerHTML = '<div class="maperr">Google Maps laadfout: ' + e.message + '</div>'; }
}

/* boot-silhouet (romp, geroteerd op koers) voor varende schepen */
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
/* stipje voor stilliggende schepen (kleur = foto ja/nee) */
function dotEl(color){
  const d = document.createElement("div");
  d.className = "boat-mk";
  d.style.cssText = "width:11px;height:11px;border-radius:50%;background:" + color + ";box-shadow:0 0 0 1.5px rgba(255,255,255,.85);transform:translateY(50%)";
  return d;
}

/* ---------- versheid ---------- */
function freshness(age){
  if(age == null) return { on:false, txt:"onbekend" };
  if(age < 20) return { on:true, txt:"live" };
  if(age < 120) return { on:false, txt:`vertraagd ${age}s` };
  return { on:false, txt:`offline ${age}s` };
}

/* ---------- fix-log ---------- */
let seenLines = new Set();
function renderFeed(raw){
  const box = $("raw");
  const keys = raw.map(r => (r.t || "") + "|" + (r.line || ""));
  box.innerHTML = raw.map((r, i) => {
    const t = r.t ? new Date(r.t * 1000).toLocaleTimeString("nl-NL") : "";
    const fresh = !seenLines.has(keys[i]);
    return `<div class="l${fresh ? " flash" : ""}"><span class="t">${t}</span>${String(r.line||"").replace(/</g,"&lt;")}</div>`;
  }).join("");
  seenLines = new Set(keys);
  box.scrollTop = box.scrollHeight;
}

/* ---------- tick ---------- */
function setOffline(msg){
  $("statepill").classList.remove("on");
  $("stateTxt").textContent = "offline";
  const e = $("err"); e.style.display = "block"; e.textContent = msg;
}
function fmt(x, d=1){ return x == null ? "-" : (typeof x === "number" ? x.toFixed(d) : x); }

async function tick(){
  let s;
  try{
    const r = await fetch("/api/state", { cache: "no-store" });
    if(r.status === 404){ setOffline("Nog geen data van het station."); return; }
    s = await r.json();
  }catch(e){ setOffline("Geen verbinding met de cloud."); return; }
  if(s.error){ setOffline(s.error); return; }
  $("err").style.display = "none";

  const fr = freshness(s._ageSec);
  $("statepill").classList.toggle("on", fr.on);
  $("stateTxt").textContent = fr.txt;
  $("ageMeta").textContent = s._ageSec == null ? "-" : (s._ageSec + "s geleden");
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
  $("shipMeta").textContent = vessels.length ? `${vessels.length} zichtbaar` : "nieuwste eerst";
  const rows = $("rows");
  if(!vessels.length){
    rows.innerHTML = `<tr><td colspan="5" class="empty">${fr.on ? "Wachten op eerste schip (ontvangst)&hellip;" : "Geen recente data van het station."}</td></tr>`;
  } else {
    rows.innerHTML = vessels.map(v => {
      const moving = (v.sog != null && v.sog >= 0.5);
      const st = v.lat == null ? '<span class="pill no">geen pos</span>'
        : (moving ? '<span class="pill mv">varend</span>' : '<span class="pill st">stil</span>');
      return `<tr class="vrow" data-mmsi="${v.mmsi}"><td class="mono">${v.mmsi}</td>
      <td class="nm">${v.name || '<span style="color:var(--ink-faint)">-</span>'}</td>
      <td class="mono">${v.sog == null ? "-" : fmt(v.sog)}</td>
      <td>${st}</td></tr>`;
    }).join("");
  }

  // Kaart-markers in een try/catch: een kaart-hik (bv. referer-fout) mag NOOIT
  // de rest van de UI (schepenlijst, feed) breken.
  if(mapReady){
    try{
      const seen = {};
      vessels.filter(v => v.lat != null).forEach(v => {
        seen[v.mmsi] = 1;
        const moving = (v.sog != null && v.sog >= 0.5);
        const cog = (v.cog != null && v.cog < 360) ? v.cog : (v.heading != null ? v.heading : 0);
        checkPhoto(v.mmsi);
        const color = vesselColor(v.mmsi);   // blauw = foto, paars = geen foto
        const el = moving ? boatEl(cog, color) : dotEl(color);
        const pos = { lat: v.lat, lng: v.lon };
        const title = (v.name || String(v.mmsi)) + " · " + (v.sog == null ? "?" : fmt(v.sog) + "kn");
        if(markers[v.mmsi]){ markers[v.mmsi].position = pos; markers[v.mmsi].content = el; markers[v.mmsi].title = title; }
        else {
          const mk = new AdvMarker({ map: gmap, position: pos, content: el, title, gmpClickable: true });
          mk.addListener("click", () => selectVessel(lastVessels[v.mmsi]));
          markers[v.mmsi] = mk;
        }
      });
      Object.keys(markers).forEach(m => { if(!seen[m]){ markers[m].map = null; delete markers[m]; } });
    }catch(e){ /* kaartfout genegeerd - feed/lijst blijven werken */ }
  }

  renderFeed(s.raw || []);
}

/* ---------- klik op schip -> detail via mokum-radar proxy ---------- */
const TYPE_NL = { passenger:"Passagiers", cargo:"Vracht", tanker:"Tanker", service:"Dienst", "high-speed":"Snelvaart", recreational:"Recreatie", other:"Overig" };
function typeLabel(cat, num){ return (cat && TYPE_NL[cat]) || (num != null ? "type " + num : "-"); }

function detailRows(v, d){
  const info = (d && d.info) || {}, live = (d && d.live) || {};
  const sog = live.sog != null ? live.sog : v.sog;
  const cog = live.cog != null ? live.cog : v.cog;
  const rows = [
    ["Snelheid", sog == null ? "-" : fmt(sog) + " kn"],
    ["Koers", (cog == null || cog >= 360) ? "-" : Math.round(cog) + "°"],
    ["Type", typeLabel(info.shipCategory, info.shipType)],
    ["Lengte", info.lengthM ? info.lengthM + " m" : "-"],
    ["Klasse", info.aisClass ? "Class " + info.aisClass : "-"],
  ];
  $("dtRows").innerHTML = rows.map(([l, val]) => `<div class="dt-row"><span class="l">${l}</span><span class="v">${val}</span></div>`).join("");
}
function applyDetail(v, d){
  const info = d.info || {};
  $("dtName").textContent = info.name || v.name || ("MMSI " + v.mmsi);
  const op = $("dtOp"); op.innerHTML = "";
  if(info.operator){
    if(info.operatorLogoUrl){ const im = document.createElement("img"); im.src = MOKUM + info.operatorLogoUrl; im.onerror = () => im.remove(); op.appendChild(im); }
    op.appendChild(document.createTextNode(info.operator));
  }
  const ph = $("dtPhoto"); ph.innerHTML = "";
  const img = new Image(); img.alt = "";
  img.onload = () => ph.appendChild(img);
  img.src = MOKUM + "/api/v2/vessel/" + v.mmsi + "/photo";
  if(info.vesselFinderUrl) $("dtVf").href = info.vesselFinderUrl;
  detailRows(v, d);
  $("dtNote").textContent = (!info.operator && !info.lengthM) ? "Beperkte info (buiten de Amsterdamse grachten)." : "";
}
async function selectVessel(v){
  if(!v) return;
  $("detail").hidden = false;
  $("dtPhoto").innerHTML = ""; $("dtOp").innerHTML = ""; $("dtNote").textContent = "";
  $("dtName").textContent = v.name || ("MMSI " + v.mmsi);
  const vf = $("dtVf"); vf.href = "https://www.vesselfinder.com/?mmsi=" + v.mmsi; vf.hidden = false;
  detailRows(v, null);
  try{
    const r = await fetch("/api/vessel?mmsi=" + encodeURIComponent(v.mmsi), { cache: "no-store" });
    const d = await r.json();
    if(d && !d.error) applyDetail(v, d);
    else $("dtNote").textContent = "Geen extra info bij mokum-radar.";
  }catch(e){ $("dtNote").textContent = "Detail-info niet beschikbaar."; }
}
$("dtClose").addEventListener("click", () => { $("detail").hidden = true; });
$("rows").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-mmsi]");
  if(tr) selectVessel(lastVessels[tr.dataset.mmsi]);
});

initMap();
tick();
setInterval(tick, 2000);
