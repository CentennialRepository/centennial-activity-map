// server.js — Centennial Activity Map (fixed routing + session handling + auto-open)
// Supports: local dev (Electron), and Render web service (HTTPS)
// Protects: everything except /login and /api/*
// Session TTL controlled via SESSION_TTL_MS (default = 7 days)

import express from "express";
import path from "path";
import compression from "compression";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import Datastore from "@seald-io/nedb";
import { fetchAllRecords } from "./airtable.js";
import fs from "fs";
import { EventEmitter } from "events";
import crypto from "crypto";
import session from "express-session";
import open from "open";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load env
dotenv.config();

// -------------------- Basic app setup --------------------
const app = express();
app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // in case front-end needs JSON

// detect environment for cookie policy
const RUNNING_ON_RENDER = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
if (RUNNING_ON_RENDER) {
  // trust proxy so secure cookies and req.protocol work correctly behind Render's proxy
  app.set("trust proxy", 1);
}

// -------------------- Session store --------------------
let sessionStore;

if (process.env.REDIS_URL) {
  // Redis store for production
  const connectRedis = (await import("connect-redis")).default;
  const Redis = (await import("ioredis")).default;

  const RedisStore = connectRedis(session);
  const redisClient = new Redis(process.env.REDIS_URL);

  sessionStore = new RedisStore({ client: redisClient });
} else {
  // fallback to memory store for local dev
  sessionStore = undefined; // express-session defaults to MemoryStore
}

// -------------------- Session config --------------------
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 604800000); // default 7 days
const SESSION_SECRET = process.env.SESSION_SECRET || "centennial_secret_key";

const cookieOpts = {
  maxAge: SESSION_TTL_MS,
  httpOnly: true,
  secure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : !!process.env.REDIS_URL, // secure only on production
  sameSite: process.env.COOKIE_SAMESITE || (process.env.REDIS_URL ? "none" : "lax"),
};

app.use(
  session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: cookieOpts,
  })
);

// -------------------- Password & Port --------------------
const SITE_PASSWORD = process.env.SITE_PASSWORD || "changeme";
const PORT = Number(process.env.PORT || 5174);

// -------------------- Config --------------------
const AIRTABLE_BASE_ID    = process.env.AIRTABLE_BASE_ID    || "";
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "MIPP";
const AIRTABLE_API_TOKEN  = process.env.AIRTABLE_API_TOKEN  || "";
const AIRTABLE_VIEW_NAME  = process.env.AIRTABLE_VIEW_NAME || "";
const AIRTABLE_FIELDS     = (process.env.AIRTABLE_FIELDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const CSV_URL = (process.env.AIRTABLE_SHARED_CSV_URL || "").trim();
const SYNC_TTL_MS       = Number(process.env.SYNC_TTL_MS || 10 * 60 * 1000);
const FULL_RESYNC_HOURS = Number(process.env.FULL_RESYNC_HOURS || 24);

// -------------------- Writable data directory --------------------
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

// CSV parsing, Airtable normalization, etc.
// ... (reuse all your helper functions: parseCSV, pick, normalizeAirtable, normalizeCSV, getMeta, setMeta, upsertMany, replaceAll, viewFingerprint, buildSinceFormula)


// -------------------- Sync engine --------------------
// ... (reuse your syncIfStale function)


// -------------------- Static UI & Auth --------------------
const PUBLIC_DIR = path.join(process.cwd(), "public");

// requireAuth: allow /login and /api/*; protect everything else
function requireAuth(req, res, next) {
  const publicPaths = ["/login", "/login.html"];

  // Allow public pages
  if (publicPaths.includes(req.path)) {
    return next();
  }

  // Allow API routes WITHOUT auth
  if (req.path.startsWith("/api")) {
    return next();
  }

  // Require login for everything else
  if (req.session && req.session.authenticated) {
    return next();
  }

  // Redirect to login
  return res.redirect("/login");
}

// ensure login route available BEFORE static middleware
app.get("/login", (_req, res) => {
  const loginPath = path.join(PUBLIC_DIR, "login.html");
  if (fs.existsSync(loginPath)) return res.sendFile(loginPath);
  return res.status(404).send("login.html missing");
});

// handle login POST
app.post("/login", (req, res) => {
  const { password } = req.body || {};
  if (password === SITE_PASSWORD) {
    req.session.authenticated = true;
    req.session.save(err => {
      if (err) console.warn("session save error:", err);
      return res.redirect("/");
    });
    return;
  }
  const loginPath = path.join(PUBLIC_DIR, "login.html");
  if (fs.existsSync(loginPath)) return res.status(401).sendFile(loginPath);
  return res.status(403).send("Invalid password");
});

// serve static assets
app.use(express.static(PUBLIC_DIR));

// index + fallback routes (protected)
if (fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) {
  console.log("Serving static from:", PUBLIC_DIR);

  app.get("/", requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
  app.get(/^(?!\/api).*/, requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
} else {
  console.warn("WARNING: public/ bundle not found. Static UI will not load.");
  app.get(/^(?!\/api).*/, (_req, res) => res.status(500).send("Static bundle missing"));
}

// -------------------- API --------------------
// ... (reuse your /api routes: health, config, stream, projects)


// -------------------- Start server --------------------
await new Promise((resolve, reject) => {
  const srv = app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}/login`;
    console.log(`Centennial Activity Map running on ${url} (mode=${CSV_URL === "" ? "AIRTABLE" : "CSV"})`);

    try {
      if (process.env.NODE_ENV !== "production") {
        await open(url);
      }
    } catch (err) {
      console.warn("Could not open browser automatically:", err);
    }

    resolve(srv);
  });

  srv.on("error", (err) => {
    console.error("Failed to start server:", err);
    reject(err);
  });
});
