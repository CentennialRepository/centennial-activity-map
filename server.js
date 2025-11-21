// server.js — Centennial Activity Map (Electron-packaged safe)
// - PAT-first (CSV optional)
// - NeDB cache in a writable user folder
// - SSE push updates
// - Robust .env loading (dev + packaged)
// - Static UI resolution (inside/outside asar)
// - Error-aware server start (fails fast instead of timing out)

import express from "express";
import path from "path";
import compression from "compression";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import Datastore from "@seald-io/nedb";
import { fetchAllRecords } from "./airtable.js";
import fs from "fs";
import os from "os";
import { EventEmitter } from "events";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- .env loading (works in dev + packaged) --------------------
dotenv.config();

// -------------------- Express setup --------------------
const app = express();
app.use(compression());

const PORT = Number(process.env.PORT || 5174);

// -------------------- Config --------------------
const AIRTABLE_BASE_ID   = process.env.AIRTABLE_BASE_ID   || "";
const AIRTABLE_TABLE_NAME= process.env.AIRTABLE_TABLE_NAME|| "MIPP";
const AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN || "";
const AIRTABLE_VIEW_NAME = process.env.AIRTABLE_VIEW_NAME || "";
const AIRTABLE_FIELDS    = (process.env.AIRTABLE_FIELDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// If CSV URL is blank → PAT mode; if set → CSV (no PAT) mode
const CSV_URL = (process.env.AIRTABLE_SHARED_CSV_URL || "").trim();

const SYNC_TTL_MS        = Number(process.env.SYNC_TTL_MS || 10 * 60 * 1000); // default 10 min
const FULL_RESYNC_HOURS  = Number(process.env.FULL_RESYNC_HOURS || 24);

// -------------------- Writable data directory (never in app.asar) --------------------
const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

// -------------------- Datastores --------------------
const projectsDb = new Datastore({ filename: path.join(dataDir, "projects.db"), autoload: true, timestampData: true });
const metaDb     = new Datastore({ filename: path.join(dataDir, "meta.db"),     autoload: true, timestampData: true });

await new Promise((res, rej) =>
  projectsDb.ensureIndex({ fieldName: "id", unique: true }, e => e ? rej(e) : res())
);
await new Promise((res, rej) =>
  projectsDb.ensureIndex({ fieldName: "name" }, e => e ? rej(e) : res())
);

// -------------------- Helpers --------------------
const notifier = new EventEmitter();
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

function parseCSV(text) {
  // minimal robust CSV parser (handles quoted fields, commas, CRLF)
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (ch === "\r") { /* ignore */ }
      else cell += ch;
    }
  }
  row.push(cell); rows.push(row);

  const header = rows.shift() || [];
  const H = header.map(h => (h || "").trim());
  return rows
    .filter(r => r.length && r.some(v => (v || "").trim() !== ""))
    .map(r => {
      const o = {};
      for (let i = 0; i < H.length; i++) o[H[i]] = (r[i] ?? "").trim();
      return o;
    });
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
    const nk = Object.keys(obj).find(x => x.toLowerCase().trim() === k.toLowerCase().trim());
    if (nk) return obj[nk];
  }
  return undefined;
}

function normalizeAirtable(records) {
  const out = [];
  for (const r of records) {
    const f = r.fields || {};
    const name = pick(f, ["Project Name","Name","Project"]);
    const phase = pick(f, ["Phase","Project Phase"]);
    const address = pick(f, ["Address","Site Address","Project Address","Location","Street Address"]);
    const lat = pick(f, ["Latitude","Lat","LAT","Y","Y (lat)"]);
    const lng = pick(f, ["Longitude","Lng","LONG","X","X (lng)"]);
    const lastMod = pick(f, ["Last Modified","Last modified","LastModified","Last Modified Time"]);
    out.push({
      id: r.id,
      name: name || "",
      phase: phase || "",
      address: address || "",
      lat: lat ?? null,
      lng: lng ?? null,
      lastModified: lastMod || null,
    });
  }
  return out;
}

function normalizeCSV(text) {
  const rows = parseCSV(text);
  const out = [];
  const COL = { NAME: "Project Name", PHASE: "Phase", ADDRESS: "Address", LAT: "Latitude", LNG: "Longitude", LASTMOD: "Last Modified", RID: "Record ID" };
  for (const r of rows) {
    const name = r[COL.NAME] || r["Name"] || "";
    const phase = r[COL.PHASE] || "";
    const address = r[COL.ADDRESS] || "";
    const lat = r[COL.LAT] ? Number(r[COL.LAT]) : null;
    const lng = r[COL.LNG] ? Number(r[COL.LNG]) : null;
    const lastModified = r[COL.LASTMOD] || null;
    const recId = r[COL.RID] || "";
    const id = recId ? `rec_${recId}` : `csv_${sha1(name + "|" + address)}`;
    out.push({ id, name, phase, address, lat, lng, lastModified });
  }
  return out;
}

async function getMeta(key)      { return new Promise((res, rej) => metaDb.findOne({ key }, (e, d) => e ? rej(e) : res(d))); }
async function setMeta(key, val) { return new Promise((res, rej) => metaDb.update({ key }, { key, value: val, updatedAt: new Date() }, { upsert: true }, e => e ? rej(e) : res())); }
async function upsertMany(list)  { for (const rec of list) await new Promise((res, rej) => projectsDb.update({ id: rec.id }, { $set: rec }, { upsert: true }, e => e ? rej(e) : res())); }
async function replaceAll(list)  { await new Promise((res, rej) => projectsDb.remove({}, { multi: true }, e => e ? rej(e) : res())); await upsertMany(list); }

const viewFingerprint = (list, viewName) => {
  const ids = list.map(r => r.id).sort();
  return sha1((viewName || "") + ";" + ids.join(","));
};

const buildSinceFormula = (sinceIso) =>
  `IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('${sinceIso}', 'YYYY-MM-DDTHH:mm:ss.SSS[Z]'))`;

// -------------------- Sync engine --------------------
async function syncIfStale({ forceFull = false, forceSync = false } = {}) {
  const now = Date.now();
  const patMode = CSV_URL === ""; // blank => PAT, set => CSV
  const lastSyncTs = (await getMeta("lastSync"))?.value || 0;
  const lastFullTs = (await getMeta("lastFullResync"))?.value || 0;
  const lastHash   = (await getMeta("viewHash"))?.value || null;

  const ttlExpired  = forceSync || (now - lastSyncTs) > SYNC_TTL_MS;
  const fullExpired = (now - lastFullTs) > FULL_RESYNC_HOURS * 3600 * 1000;

  let doFull = forceFull || !lastSyncTs || !patMode || fullExpired; // CSV => always full
  if (!ttlExpired && !doFull) return { synced: false, reason: "fresh", mode: patMode ? "airtable" : "csv" };

  try {
    let records = [];

    if (!patMode) {
      // CSV (no PAT) mode
      const resp = await fetch(CSV_URL);
      if (!resp.ok) throw new Error(`CSV fetch failed: ${resp.status}`);
      const text = await resp.text();
      records = normalizeCSV(text);
      doFull = true; // always full replace for CSV
    } else {
      // Airtable PAT mode
      if (doFull) {
        const recs = await fetchAllRecords({
          baseId: AIRTABLE_BASE_ID,
          tableName: AIRTABLE_TABLE_NAME,
          apiKey: AIRTABLE_API_TOKEN,
          viewName: AIRTABLE_VIEW_NAME,
          fields: AIRTABLE_FIELDS
        });
        records = normalizeAirtable(recs);
      } else {
        // incremental by last modified time
        const sinceIso = new Date(lastSyncTs).toISOString();
        const filterByFormula = buildSinceFormula(sinceIso);
        const recs = await fetchAllRecords({
          baseId: AIRTABLE_BASE_ID,
          tableName: AIRTABLE_TABLE_NAME,
          apiKey: AIRTABLE_API_TOKEN,
          viewName: AIRTABLE_VIEW_NAME,
          fields: AIRTABLE_FIELDS,
          extraParams: { filterByFormula }
        });
        records = normalizeAirtable(recs);
      }
    }

    if (doFull) {
      const fp = viewFingerprint(records, AIRTABLE_VIEW_NAME);
      await replaceAll(records);                 // prune + reload
      await setMeta("viewHash", fp);
      await setMeta("lastFullResync", now);
      await setMeta("lastSync", now);
      notifier.emit("projects-updated");
      return { synced: true, mode: patMode ? "airtable" : "csv", full: true, changed: records.length, fingerprint: fp };
    } else {
      await upsertMany(records);                 // incremental upsert only
      await setMeta("lastSync", now);
      notifier.emit("projects-updated");
      return { synced: true, mode: "airtable", full: false, changed: records.length };
    }
  } catch (e) {
    return { synced: false, mode: (CSV_URL==="" ? "airtable" : "csv"), error: e.message };
  }
}

// -------------------- Static UI resolution --------------------
const PUBLIC_DIR = path.join(process.cwd(), "public");
if (fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) {
  console.log("Serving static from:", PUBLIC_DIR);
  app.use(express.static(PUBLIC_DIR));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
} else {
  console.warn("WARNING: public/ bundle not found. Static UI will not load.");
  app.get(/^(?!\/api).*/, (_req, res) => res.status(500).send("Static bundle missing"));
}

// -------------------- API --------------------
app.get("/api/health", async (_req, res) => {
  const lastSync = (await getMeta("lastSync"))?.value || null;
  const lastFull = (await getMeta("lastFullResync"))?.value || null;
  const viewHash = (await getMeta("viewHash"))?.value || null;
  res.json({ ok: true, mode: CSV_URL === "" ? "airtable" : "csv", lastSync, lastFull, viewHash, now: Date.now() });
});

app.get("/api/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  const send = () => res.write(`event: projects-updated\ndata: {}\n\n`);
  notifier.on("projects-updated", send);
  req.on("close", () => notifier.off("projects-updated", send));
});

app.get("/api/projects", async (req, res) => {
  const info = await syncIfStale({ forceFull: req.query?.full === "1", forceSync: req.query?.force === "1" });

  const docs = await new Promise((resolve, reject) =>
    projectsDb.find({}).sort({ name: 1 }).exec((e, d) => e ? reject(e) : resolve(d))
  );

  res.set("X-Mode", CSV_URL === "" ? "AIRTABLE" : "CSV");
  res.set("X-Sync", info.synced ? (info.full ? "FULL" : "INCR") : "HIT");
  res.json({ source: "nedb", count: docs.length, records: docs });
});

// -------------------- Start server (fail fast on error) --------------------
await new Promise((resolve, reject) => {
  const srv = app.listen(PORT, () => {
    console.log(`Centennial Activity Map running on http://localhost:${PORT} (mode=${CSV_URL === "" ? "AIRTABLE" : "CSV"})`);
    resolve(srv);
  });
  srv.on("error", (err) => {
    console.error("Failed to start server:", err);
    reject(err);
  });
});
