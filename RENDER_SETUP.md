# Render Deployment Checklist

## Required Environment Variables

In your Render dashboard, go to your service → Environment and add:

### Authentication (Required)
```
SITE_PASSWORD=your_secure_password
SESSION_SECRET=a_long_random_string_at_least_32_chars
```

### Google Maps (Required)
```
GMAPS_API_KEY=your_google_maps_api_key
```

### Airtable (Required)
```
AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
AIRTABLE_TABLE_NAME=MIPP
AIRTABLE_API_TOKEN=pat_xxxxxxxxxxxxxxxx
AIRTABLE_VIEW_NAME=MAP
AIRTABLE_FIELDS=Project Name, Address, Phase
```

### Optional Settings
```
PORT=5174
SYNC_TTL_MS=600000
FULL_RESYNC_HOURS=24
SESSION_TTL_MS=604800000
```

## Important Notes

1. **Do NOT commit `.env` to Git** - It contains secrets and is already in `.gitignore`
2. **Session Persistence** - The app uses MemoryStore by default, which works but sessions won't persist across restarts. For production with multiple instances, add Redis:
   ```
   REDIS_URL=redis://your-redis-url
   ```
3. **Cookie Settings** - The app auto-detects Render and sets secure cookies. If you have issues, you can manually override:
   ```
   COOKIE_SECURE=true
   COOKIE_SAMESITE=none
   ```

## Troubleshooting

### Login page doesn't show
- Check Render logs for errors during startup
- Ensure `public/login.html` is deployed

### Login always fails
- Verify `SITE_PASSWORD` is set correctly in Render environment (no extra spaces)
- Check Render logs for "Password incorrect" or "Password correct" messages
- Ensure `SESSION_SECRET` is set

### Map loads without login
- This shouldn't happen if env vars are set. Check logs for "Auth check" messages
- Verify the correct `server.js` is deployed (should have `requireAuth` middleware)

### Sessions don't persist
- Add `REDIS_URL` to use Redis session store instead of memory
- Without Redis, sessions are lost when the server restarts

## Testing

After deployment:
1. Visit your Render URL - you should see the login page
2. Enter the password from `SITE_PASSWORD`
3. You should be redirected to the map
4. Refresh the page - you should stay logged in (unless server restarted without Redis)

## Logs to Check

In Render dashboard → Logs, look for:
- "Auth config: ..." - shows if env vars are detected
- "Login attempt - ..." - shows login attempts
- "Auth check for / - authenticated: ..." - shows if routes are protected
