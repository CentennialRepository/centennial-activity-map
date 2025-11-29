
# Centennial Activity Map — v2.2 (PAT-first)

This build defaults to **Airtable PAT mode** (CSV mode is off). It includes:
- Electron packaged import (no ENOTDIR)
- SSE live updates + fast NeDB cache (SWR)
- Async Google Maps loader
- Dev spawn, packaged in-process server

## Setup
1) Copy `.env.example` → `.env` and fill:
```
AIRTABLE_BASE_ID=appYOURBASE
AIRTABLE_TABLE_NAME=MIPP
AIRTABLE_API_TOKEN=pat_your_token
AIRTABLE_VIEW_NAME=
AIRTABLE_FIELDS=
AIRTABLE_SHARED_CSV_URL=
```
2) Add your Google Maps key in `.env` as `GMAPS_API_KEY=...` (the frontend fetches it from `/api/config`).
3) (Optional but recommended) Protect access with a password by setting in `.env`:
```
SITE_PASSWORD=your_shared_password
SESSION_SECRET=some_random_long_secret
```
4) Launch desktop:
   - macOS: `run-mac.command`
   - Windows: `run-windows.bat`
5) Check:
   - `http://localhost:5174/api/health` → mode `airtable`
   - `http://localhost:5174/api/projects` → JSON with `records`

## Build installers
```
npm install
npm run dist
```
`electron-builder.yml` includes `.env` so your packaged app can read the PAT.

## Refresh/Prune
- Click **Refresh** in the UI → forces a full reload.
- Daily full resync keeps cache aligned; incremental updates apply in between.
