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
let availableFields = []; // All fields from AIRTABLE_FIELDS in order
let visibleFields = new Set(); // User-selected fields to display
const FIELD_STORE_KEY = 'cam_visible_fields_v2'; // Changed version to force reset
let hasSavedVisibleFields = false;
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
  const lines = [];
  const allFields = r.allFields || {};
  
  // Build popup content based on visible fields
  // Iterate through available fields in order, but only show if selected
  for (const field of availableFields) {
    if (!visibleFields.has(field)) continue;
    let value = '';
    let label = field;
    
    // Handle core fields
    if (field === 'name') {
      value = r.name || "(no name)";
      label = 'Name';
      if (value) lines.push(`<div class="popup-field"><strong>${value}</strong></div>`);
    } else if (field === 'phase') {
      value = normalizePhase(r.phase);
      label = 'Phase';
      if (value) lines.push(`<div class="popup-field"><em>${value}</em></div>`);
    } else if (field === 'address') {
      value = r.address || '';
      label = 'Address';
      if (value) lines.push(`<div class="popup-field">${value}</div>`);
    } else if (field === 'lastModified') {
      value = r.lastModified || '';
      label = 'Last Modified';
      if (value) lines.push(`<div class="popup-field"><span class="field-label">Modified:</span> ${value}</div>`);
    } else if (allFields[field] != null) {
      // Handle dynamic Airtable fields
      value = allFields[field];
      
      // Check if this is an Airtable attachment field (array of objects with url property)
      if (Array.isArray(value) && value.length > 0 && value[0]?.url) {
        // Render attachments as clickable links
        const attachmentLinks = value.map((att, idx) => {
          const filename = att.filename || `Attachment ${idx + 1}`;
          const url = att.url;
          const icon = getAttachmentIcon(att.type || att.filename);
          return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="attachment-link">${icon} ${filename}</a>`;
        }).join('');
        lines.push(`<div class="popup-field"><span class="field-label">${field}:</span><div class="attachment-list">${attachmentLinks}</div></div>`);
      } else if (Array.isArray(value)) {
        // Regular array (not attachments)
        value = value.join(', ');
        if (value) lines.push(`<div class="popup-field"><span class="field-label">${field}:</span> ${value}</div>`);
      } else if (typeof value === 'object') {
        value = JSON.stringify(value);
        if (value) lines.push(`<div class="popup-field"><span class="field-label">${field}:</span> ${value}</div>`);
      } else {
        if (value) lines.push(`<div class="popup-field"><span class="field-label">${field}:</span> ${value}</div>`);
      }
    }
  }
  
  return `<div class="popup-content">${lines.join('')}</div>`;
}

function getAttachmentIcon(typeOrFilename) {
  const type = (typeOrFilename || '').toLowerCase();
  
  if (type.includes('pdf')) return '📄';
  if (type.includes('image') || type.includes('jpg') || type.includes('png') || type.includes('gif')) return '🖼️';
  if (type.includes('video') || type.includes('mp4') || type.includes('mov')) return '🎥';
  if (type.includes('word') || type.includes('doc')) return '📝';
  if (type.includes('excel') || type.includes('xls') || type.includes('csv')) return '📊';
  if (type.includes('powerpoint') || type.includes('ppt')) return '📽️';
  if (type.includes('zip') || type.includes('rar')) return '📦';
  
  return '📎'; // Default attachment icon
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
  
  const header = document.createElement("div");
  header.className = "legend-header";
  header.innerHTML = `
    <div class="title">Legend</div>
    <button class="toggle-btn" aria-label="Toggle legend">−</button>
  `;
  el.appendChild(header);
  
  const content = document.createElement("div");
  content.className = "legend-content";

  for (const phase of PHASE_ORDER) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.phase = phase;
    row.innerHTML = `
      <div class="phase-header">
        <span class="dot" style="background:${PHASE_COLORS[phase]}"></span>
        <span class="label">${phase}</span>
        <span class="count" style="margin-left:6px;color:#475569;"></span>
      </div>
      <div class="project-list" style="display:none;"></div>
    `;
    content.appendChild(row);
  }

  if (!PHASE_ORDER.includes("Other")) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.phase = "Other";
    row.innerHTML = `
      <div class="phase-header">
        <span class="dot" style="background:${PHASE_COLORS["Other"]}"></span>
        <span class="label">Other</span>
        <span class="count" style="margin-left:6px;color:#475569;"></span>
      </div>
      <div class="project-list" style="display:none;"></div>
    `;
    content.appendChild(row);
  }
  
  el.appendChild(content);
  
  // Toggle handler
  const toggleBtn = header.querySelector('.toggle-btn');
  toggleBtn.addEventListener('click', () => {
    const isCollapsed = content.style.display === 'none';
    content.style.display = isCollapsed ? 'block' : 'none';
    toggleBtn.textContent = isCollapsed ? '−' : '+';
    toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
  });

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
    const header = row.querySelector('.phase-header');
    const projectList = row.querySelector('.project-list');
    
    header.style.cursor = "pointer";
    // Initial opacity reflects persisted state
    row.style.opacity = enabledPhases.has(phase) ? 1 : 0.45;
    
    header.addEventListener("click", (e) => {
      // Toggle project list
      const isExpanded = projectList.style.display === 'block';
      
      if (isExpanded) {
        // Collapse list
        projectList.style.display = 'none';
      } else {
        // Expand list and populate with projects
        populateProjectList(phase, projectList);
        projectList.style.display = 'block';
      }
    });
    
    // Right-click or Ctrl+click to toggle phase filter
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      togglePhaseFilter(phase, row);
    });
  });
  updateLegendCounts(lastLegendCounts);
}

function togglePhaseFilter(phase, row) {
  if (enabledPhases.has(phase)) {
    enabledPhases.delete(phase);
    row.style.opacity = 0.45;
  } else {
    enabledPhases.add(phase);
    row.style.opacity = 1;
  }
  applyFilters();
  savePhasePrefs();
  // Sync with dropdown checkbox
  const cb = document.querySelector(`input[data-phase="${phase}"]`);
  if (cb) cb.checked = enabledPhases.has(phase);
}

function populateProjectList(phase, container) {
  const projects = [];
  
  // Collect all projects in this phase
  for (const marker of markersById.values()) {
    const title = marker.getTitle();
    const markerPhase = marker.__phase || 'Other';
    
    if (normalizePhase(markerPhase) === phase) {
      projects.push({
        name: title,
        marker: marker
      });
    }
  }
  
  // Sort alphabetically
  projects.sort((a, b) => a.name.localeCompare(b.name));
  
  // Render project list
  container.innerHTML = projects.map(p => `
    <div class="project-item" data-name="${p.name}">${p.name}</div>
  `).join('');
  
  // Add click handlers
  container.querySelectorAll('.project-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = item.getAttribute('data-name');
      
      // Find and focus on marker
      for (const m of markersById.values()) {
        if (m.getTitle() === name) {
          map.setCenter(m.getPosition());
          map.setZoom(15);
          google.maps.event.trigger(m, 'click');
          break;
        }
      }
    });
  });
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

async function renderRecordsProgressively(records, fieldOrder = []) {
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
  
  // Update field selector with available fields
  updateFieldSelector(records, fieldOrder);
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

    await renderRecordsProgressively(json.records || [], json.fields || []);
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
  // Phase filter dropdown toggle
  const phaseBtn = document.getElementById('phaseFilterBtn');
  const phaseDropdown = document.getElementById('phaseDropdown');
  
  if (phaseBtn && phaseDropdown) {
    phaseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = phaseDropdown.style.display === 'block';
      phaseDropdown.style.display = isVisible ? 'none' : 'block';
    });
    
    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.phase-filter-selector')) {
        phaseDropdown.style.display = 'none';
      }
    });
  }
  
  // Phase checkboxes
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
  const dropdown = document.getElementById("autocompleteDropdown");
  
  if (sb && dropdown) {
    sb.addEventListener("input", (e) => {
      const query = (e.target.value || "").trim().toLowerCase();
      currentFilterText = query;
      
      // Show autocomplete suggestions
      if (query.length > 0) {
        const matches = Array.from(markersById.values())
          .filter(m => m.__name.includes(query))
          .map(m => m.getTitle())
          .filter((v, i, a) => a.indexOf(v) === i) // unique
          .slice(0, 8); // limit to 8 results
        
        if (matches.length > 0) {
          dropdown.innerHTML = matches.map(name => 
            `<div class="autocomplete-item" data-name="${name.replace(/"/g, '&quot;')}">${name}</div>`
          ).join('');
          dropdown.style.display = 'block';
        } else {
          dropdown.style.display = 'none';
        }
      } else {
        dropdown.style.display = 'none';
      }
      
      applyFilters();
    });
    
    // Handle autocomplete item clicks
    dropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.autocomplete-item');
      if (item) {
        const name = item.getAttribute('data-name');
        sb.value = name;
        currentFilterText = name.toLowerCase();
        dropdown.style.display = 'none';
        applyFilters();
        
        // Find and focus on the selected marker
        for (const m of markersById.values()) {
          if (m.getTitle() === name) {
            map.setCenter(m.getPosition());
            map.setZoom(12);
            google.maps.event.trigger(m, 'click');
            break;
          }
        }
      }
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!sb.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
  }

  const btn = document.getElementById("refreshBtn");
  if (btn) btn.addEventListener("click", () => fetchProjects({ force: true, full: true }));
  
  // Field selector (dropdown for selecting which fields to display)
  initFieldSelector();
}

function initFieldSelector() {
  const btn = document.getElementById('fieldSelectorBtn');
  const dropdown = document.getElementById('fieldDropdown');
  
  if (!btn || !dropdown) return;
  
  // Load saved preferences
  try {
    const saved = localStorage.getItem(FIELD_STORE_KEY);
    if (saved) {
      visibleFields = new Set(JSON.parse(saved));
      hasSavedVisibleFields = true;
    }
  } catch {}
  
  // Toggle dropdown
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';
  });
  
  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.field-selector')) {
      dropdown.style.display = 'none';
    }
  });
}

function updateFieldSelector(records, fieldOrder = []) {
  if (!records || records.length === 0) return;

  let orderedFields = Array.isArray(fieldOrder) ? fieldOrder.filter(Boolean) : [];

  if (!orderedFields.length) {
    const fieldSet = new Set();
    for (const rec of records) {
      if (!rec?.allFields) continue;
      for (const key of Object.keys(rec.allFields)) {
        if (!fieldSet.has(key)) fieldSet.add(key);
      }
    }
    orderedFields = Array.from(fieldSet);
  }

  if (!orderedFields.length) return;

  availableFields = orderedFields.slice();

  if (!hasSavedVisibleFields) {
    visibleFields = new Set(availableFields);
  } else {
    const prevVisible = new Set(visibleFields);
    visibleFields = new Set(availableFields.filter(field => prevVisible.has(field)));
    if (visibleFields.size === 0) {
      visibleFields = new Set(availableFields);
    }
  }

  renderFieldSelector();
}

function renderFieldSelector() {
  const dropdown = document.getElementById('fieldDropdown');
  if (!dropdown) return;
  
  // Render fields in the order from AIRTABLE_FIELDS (preserved in availableFields)
  dropdown.innerHTML = availableFields.map(field => {
    const checked = visibleFields.has(field) ? 'checked' : '';
    const displayName = field.charAt(0).toUpperCase() + field.slice(1).replace(/([A-Z])/g, ' $1');
    return `
      <label class="field-option">
        <input type="checkbox" value="${field}" ${checked}>
        <span>${displayName}</span>
      </label>
    `;
  }).join('');
  
  // Add change listeners
  dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const field = e.target.value;
      if (e.target.checked) {
        visibleFields.add(field);
      } else {
        visibleFields.delete(field);
      }
      // Save preferences
      try {
        localStorage.setItem(FIELD_STORE_KEY, JSON.stringify(Array.from(visibleFields)));
      } catch {}
      // Update all marker info windows
      updateAllMarkerInfoWindows();
    });
  });
}

function updateAllMarkerInfoWindows() {
  // Mark all markers to refresh content on next click
  for (const marker of markersById.values()) {
    marker.__needsUpdate = true;
  }
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
      mapTypeControl: true,
      mapTypeControlOptions: {
        style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
        position: google.maps.ControlPosition.TOP_RIGHT,
        mapTypeIds: ['roadmap', 'satellite', 'hybrid', 'terrain']
      },
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
