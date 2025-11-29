// public/app-google.js (v2.2 — robust Google Maps loader + SSE + legend counts)
// No JSX. Vanilla JS only.

////////////////////////////////////////////////////////////////////////////////
// Phase colors & constants
////////////////////////////////////////////////////////////////////////////////
const PHASE_COLORS = {
  "Not Helioscoped": "#1e88e5",
  "Helioscoped Projects": "#7e57c2",
  "Early Stage Pipeline Projects": "#e53935",
  "Late Stage Pipeline Projects": "#fdd835",
  "Operating Projects": "#43a047",
  "Other": "#607d8b",
};
const PHASE_ORDER = [
  "Not Helioscoped",
  "Helioscoped Projects",
  "Early Stage Pipeline Projects",
  "Late Stage Pipeline Projects",
  "Operating Projects",
];

const REFRESH_MS = 300000;        // 5 minutes polling (SSE also pushes)
const GEOCODE_DELAY_MS = 50;      // gentle throttle for client-side geocoding
const GEOCODE_CONCURRENCY = 10;   // number of parallel geocoding requests
const DOT_SCALE = 11, DOT_STROKE = 2, DOT_HOVER_DELTA = 3, DOT_MIN = 8, DOT_MAX = 24;

////////////////////////////////////////////////////////////////////////////////
// Globals
////////////////////////////////////////////////////////////////////////////////
let map, geocoder;
let markersById = new Map();
let currentFilterText = "";
const enabledPhases = new Set(Object.keys(PHASE_COLORS));
// Phase filter persistence
const PHASE_STORE_KEY = 'cam_phase_filters_v1';
function loadPhasePrefs() {
  try {
    const raw = localStorage.getItem(PHASE_STORE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length) {
      enabledPhases.clear();
      for (const p of list) enabledPhases.add(p);
    }
  } catch {}
}
function savePhasePrefs() {
  try { localStorage.setItem(PHASE_STORE_KEY, JSON.stringify(Array.from(enabledPhases))); } catch {}
}
loadPhasePrefs();
let firstFitDone = false;
let legendEl = null;
let lastLegendCounts = {};
let pollTimer = null;

////////////////////////////////////////////////////////////////////////////////
// UI helpers
////////////////////////////////////////////////////////////////////////////////
function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg || "";
}

function showOverlayError(msg) {
  const el = document.getElementById("overlayError");
  if (!el) return;
  el.style.display = "flex";
  el.innerHTML = `<div class="box">${(msg || "").replace(/</g, "&lt;")}</div>`;
}

////////////////////////////////////////////////////////////////////////////////
/** Normalize Phase values to our buckets */
////////////////////////////////////////////////////////////////////////////////
function normalizePhase(p) {
  const s = (p || "").toLowerCase().trim();
  if (s === "not helioscoped" || s.startsWith("not-helio") || s.startsWith("not helio")) return "Not Helioscoped";
  if (s.startsWith("helioscope") || s.startsWith("helioscoped")) return "Helioscoped Projects";
  if (s.startsWith("early"))  return "Early Stage Pipeline Projects";
  if (s.startsWith("late"))   return "Late Stage Pipeline Projects";
  if (s.startsWith("operat")) return "Operating Projects";
  return p || "Other";
}

function popupHtml(r) {
  const name = r.name || "(no name)";
  const phase = normalizePhase(r.phase);
  const address = r.address || "";
  return `<div><strong>${name}</strong><br/><em>${phase}</em><br/><span>${address}</span></div>`;
}

////////////////////////////////////////////////////////////////////////////////
// Markers
////////////////////////////////////////////////////////////////////////////////
function markerIcon(color, scale = DOT_SCALE) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: "#ffffff",
    strokeOpacity: 0.95,
    strokeWeight: DOT_STROKE,
  };
}

function createOrUpdateMarker(rec) {
  const phaseNorm = normalizePhase(rec.phase);
  const color = PHASE_COLORS[phaseNorm] || PHASE_COLORS["Other"];
  const pos = { lat: rec.lat, lng: rec.lng };
  const existing = markersById.get(rec.id);

  if (existing) {
    existing.setOptions({ position: pos, icon: markerIcon(color) });
    existing.__phase = phaseNorm;
    existing.__name = (rec.name || "").toLowerCase();
    existing.__address = rec.address || "";
    return;
  }

  const m = new google.maps.Marker({
    position: pos,
    icon: markerIcon(color),
    map,
    optimized: true,
    title: rec.name || "",
  });

  m.__phase = phaseNorm;
  m.__name = (rec.name || "").toLowerCase();
  m.__address = rec.address || "";

  let iw = null;
  m.addListener("click", () => {
    if (!iw) iw = new google.maps.InfoWindow({ content: popupHtml({ ...rec, phase: phaseNorm }) });
    iw.open({ anchor: m, map });
  });
  m.addListener("mouseover", () => {
    const cur = m.getIcon();
    const curColor = cur?.fillColor || color;
    const curScale = typeof cur?.scale === "number" ? cur.scale : DOT_SCALE;
    m.setIcon(markerIcon(curColor, Math.min(DOT_MAX, curScale + DOT_HOVER_DELTA)));
  });
  m.addListener("mouseout", () => {
    const cur = m.getIcon();
    const curColor = cur?.fillColor || color;
    m.setIcon(markerIcon(curColor, DOT_SCALE));
  });

  markersById.set(rec.id, m);
}

function removeMarkersNotIn(newIds) {
  for (const [id, mk] of Array.from(markersById.entries())) {
    if (!newIds.has(id)) {
      mk.setMap(null);
      markersById.delete(id);
    }
  }
}

function applyFilters() {
  const text = (currentFilterText || "").trim().toLowerCase();
  for (const m of markersById.values()) {
    const phaseOk = enabledPhases.has(m.__phase);
    const textOk = !text || m.__name.includes(text);
    m.setVisible(phaseOk && textOk);
  }
}

function fitBoundsIfNeeded() {
  if (firstFitDone) return;
  const visible = Array.from(markersById.values()).filter(m => m.getVisible());
  if (!visible.length) return;
  const b = new google.maps.LatLngBounds();
  for (const m of visible) b.extend(m.getPosition());
  map.fitBounds(b, 80);
  firstFitDone = true;
}

////////////////////////////////////////////////////////////////////////////////
// Legend (with counts)
////////////////////////////////////////////////////////////////////////////////
function buildLegendContainer() {
  const el = document.createElement("div");
  el.className = "gm-legend";
  el.innerHTML = `<div class="title">Legend</div>`;

  for (const phase of PHASE_ORDER) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.phase = phase;
    row.innerHTML = `
      <span class="dot" style="background:${PHASE_COLORS[phase]}"></span>
      <span class="label">${phase}</span>
      <span class="count" style="margin-left:6px;color:#475569;"></span>
    `;
    el.appendChild(row);
  }

  if (!PHASE_ORDER.includes("Other")) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.phase = "Other";
    row.innerHTML = `
      <span class="dot" style="background:${PHASE_COLORS["Other"]}"></span>
      <span class="label">Other</span>
      <span class="count" style="margin-left:6px;color:#475569;"></span>
    `;
    el.appendChild(row);
  }

  map.controls[google.maps.ControlPosition.LEFT_BOTTOM].push(el);
  return el;
}

function updateLegendCounts(counts) {
  lastLegendCounts = counts || lastLegendCounts || {};
  if (!legendEl) return;
  legendEl.querySelectorAll(".row").forEach(row => {
    const phase = row.dataset.phase;
    const n = lastLegendCounts[phase] || 0;
    const span = row.querySelector(".count");
    if (span) span.textContent = `(${n})`;
  });
}

function addLegendControl() {
  legendEl = buildLegendContainer();
  legendEl.querySelectorAll(".row").forEach(row => {
    const phase = row.dataset.phase;
    row.style.cursor = "pointer";
    // Initial opacity reflects persisted state
    row.style.opacity = enabledPhases.has(phase) ? 1 : 0.45;
    row.addEventListener("click", () => {
      if (enabledPhases.has(phase)) {
        enabledPhases.delete(phase);
        row.style.opacity = 0.45;
      } else {
        enabledPhases.add(phase);
        row.style.opacity = 1;
      }
      applyFilters();
      savePhasePrefs();
    });
  });
  updateLegendCounts(lastLegendCounts);
}

////////////////////////////////////////////////////////////////////////////////
// Geocoding cache (localStorage with memory fallback)
////////////////////////////////////////////////////////////////////////////////
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function cacheKeyFor(addr) { return `geo::${hash32(addr)}`; }
const geoCacheMem = new Map();
function safeGet(addr) {
  const k = cacheKeyFor(addr);
  const v = localStorage.getItem(k);
  if (v != null) {
    try { return JSON.parse(v); } catch {}
  }
  if (geoCacheMem.has(k)) return geoCacheMem.get(k);
  return null;
}
function safeSet(addr, obj) {
  const k = cacheKeyFor(addr);
  try { localStorage.setItem(k, JSON.stringify(obj)); }
  catch (e) { geoCacheMem.set(k, obj); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function geocodeAddress(addr, attempt = 0) {
  const cached = safeGet(addr);
  if (cached) return cached;

  try {
    const resp = await geocoder.geocode({ address: addr });
    const results = Array.isArray(resp) ? resp : (resp?.results || resp);
    const first = Array.isArray(results) ? results[0] : (results && results[0]);
    const loc = first?.geometry?.location;
    if (loc && typeof loc.lat === "function" && typeof loc.lng === "function") {
      const coords = { lat: loc.lat(), lng: loc.lng() };
      safeSet(addr, coords);
      return coords;
    }
    return null;
  } catch (e) {
    if (attempt < 2) {
      await sleep(500 * (attempt + 1));
      return geocodeAddress(addr, attempt + 1);
    }
    return null;
  }
}

////////////////////////////////////////////////////////////////////////////////
// Rendering & data
////////////////////////////////////////////////////////////////////////////////
function countByPhaseFromRecords(records) {
  const counts = {};
  for (const r of records) {
    const p = normalizePhase(r.phase);
    counts[p] = (counts[p] || 0) + 1;
  }
  for (const key of [...PHASE_ORDER, "Other"]) {
    if (counts[key] == null) counts[key] = 0;
  }
  return counts;
}

async function renderRecordsProgressively(records) {
  const idSet = new Set();
  const have = [], need = [];

  for (const r of records) {
    if (r.lat != null && r.lng != null) have.push(r);
    else if (r.address) need.push(r);
  }

  // Render known coordinates immediately
  for (const r of have) {
    createOrUpdateMarker(r);
    idSet.add(r.id);
  }
  applyFilters();
  fitBoundsIfNeeded();
  setStatus(`Loaded ${idSet.size} projects (coords)`);

  // Geocode the rest with limited concurrency for faster initial load
  let done = 0, total = need.length;
  let idx = 0;
  const worker = async () => {
    while (idx < need.length) {
      const r = need[idx++];
      const coords = await geocodeAddress(r.address);
      if (GEOCODE_DELAY_MS > 0) await sleep(GEOCODE_DELAY_MS);
      done++;
      if (coords) {
        createOrUpdateMarker({ ...r, lat: coords.lat, lng: coords.lng });
        idSet.add(r.id);
      }
      if (done % 50 === 0) setStatus(`Geocoding ${done}/${total}…`);
    }
  };
  const workers = Array.from({ length: Math.min(GEOCODE_CONCURRENCY, need.length) }, () => worker());
  await Promise.all(workers);

  // Remove markers no longer in view
  removeMarkersNotIn(idSet);
  applyFilters();
  setStatus(`Loaded ${idSet.size} projects`);
}

// Loading overlay helpers (unused)
// const loadingOverlay = () => document.getElementById('loadingOverlay');
// function showLoading() { const el = loadingOverlay(); if (el) el.style.display = 'flex'; }
// function hideLoading() { const el = loadingOverlay(); if (el) el.style.display = 'none'; }

async function fetchProjects(opts = {}) {
  const query = [];
  if (opts.force) query.push("force=1");
  if (opts.full)  query.push("full=1");
  const qs = query.length ? `?${query.join("&")}` : "";

  setStatus(opts.force ? "Refreshing…" : "Loading…");
  try {
    const res = await fetch(`/api/projects${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    updateLegendCounts(countByPhaseFromRecords(json.records || []));
    if (!opts.force) firstFitDone = false;

    await renderRecordsProgressively(json.records || []);
  } catch (e) {
    console.error(e);
    showOverlayError(e && e.message ? e.message : "Error loading data");
    setStatus("Error loading data");
  }
}

////////////////////////////////////////////////////////////////////////////////
// Controls & scaling
////////////////////////////////////////////////////////////////////////////////
function initUI() {
  document.querySelectorAll('input[type="checkbox"][data-phase]').forEach(cb => {
    const phase = cb.getAttribute('data-phase');
    cb.checked = enabledPhases.has(phase);
    cb.addEventListener("change", (e) => {
      const phase = e.target.getAttribute("data-phase");
      if (e.target.checked) enabledPhases.add(phase);
      else enabledPhases.delete(phase);
      applyFilters();
      savePhasePrefs();
    });
  });

  const sb = document.getElementById("searchBox");
  if (sb) sb.addEventListener("input", (e) => {
    currentFilterText = e.target.value || "";
    applyFilters();
  });

  const btn = document.getElementById("refreshBtn");
  if (btn) btn.addEventListener("click", () => fetchProjects({ force: true, full: true }));
}

function installZoomScaler() {
  map.addListener("zoom_changed", () => {
    const z = map.getZoom() || 4;
    const scaled = Math.max(DOT_MIN, Math.min(DOT_MAX, DOT_SCALE + (z - 4) * 0.7));
    for (const mk of markersById.values()) {
      const icon = mk.getIcon();
      const color = icon?.fillColor || "#43a047";
      mk.setIcon(markerIcon(color, scaled));
    }
  });
}

////////////////////////////////////////////////////////////////////////////////
// Google Maps loader — robust (importLibrary)
////////////////////////////////////////////////////////////////////////////////
function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve();
    const key = window.GMAPS_API_KEY;
    if (!key) {
      showOverlayError("Missing Google Maps API key. Open public/config.js and set window.GMAPS_API_KEY.");
      return reject(new Error("Missing window.GMAPS_API_KEY"));
    }
    // Use a callback so we know Maps core is ready (works on all versions)
    window.__gmapsOnLoad = () => resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__gmapsOnLoad`;
    s.async = true;
    s.defer = true;
    s.onerror = () => {
      showOverlayError("Failed to load Google Maps JS API. Check your key.");
      reject(new Error("Failed to load Google Maps JS API"));
    };
    document.head.appendChild(s);
  });
}


function startPolling() { if (!pollTimer) pollTimer = setInterval(fetchProjects, REFRESH_MS); }
function stopPolling()  { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

////////////////////////////////////////////////////////////////////////////////
// Boot
////////////////////////////////////////////////////////////////////////////////
async function initMapAndRun() {
  try {
    await loadGoogleMaps();

    // If available, use importLibrary; otherwise skip (older versions)
    if (google.maps.importLibrary) {
      await Promise.all([
        google.maps.importLibrary("maps"),
        google.maps.importLibrary("geocoding"),
      ]);
    }

    if (!google?.maps?.Map) {
      showOverlayError("Google Maps API not ready (maps library missing).");
      return;
    }

    map = new google.maps.Map(document.getElementById("map"), {
      center: { lat: 39.8283, lng: -98.5795 },
      zoom: 4,
      mapTypeControl: false,
      streetViewControl: false,
    });

    geocoder = new google.maps.Geocoder();
    // ... (rest of your function unchanged)


    addLegendControl();
    installZoomScaler();
    initUI();

    await fetchProjects();
    startPolling();

    // Hot updates when server resyncs
    try {
      const ev = new EventSource("/api/stream");
      ev.addEventListener("projects-updated", () => {
        fetchProjects({ force: true });
      });
    } catch {}

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopPolling();
      else { fetchProjects(); startPolling(); }
    });
  } catch (e) {
    console.error(e);
    showOverlayError(e.message || "Initialization error");
  }
}

// Expose initMapAndRun globally for config.js
window.initMapAndRun = initMapAndRun;
// initMapAndRun() is now called from config.js after the API key is set.
