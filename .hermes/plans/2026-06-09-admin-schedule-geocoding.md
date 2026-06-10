# Admin Area + Scheduled Nets + MapQuest Geocoding

> **Goal:** Three upgrades: (1) Super admin user management, (2) Scheduled recurring nets with auto-email, (3) Replace Azure Maps with MapQuest/Nominatim geocoding.

## Task 1: MapQuest Geocoding

**Objective:** Replace Azure Maps `resolveLocation()` with MapQuest API (with Nominatim fallback when no key).

**Files:**
- Modify: `server/dist/lib/serverUtils.js:301-325`
- Modify: `server/dist/commonConfig.yaml:24-25`
- Modify: `server/dist/lib/configLib.js:45`
- Modify: `.env.example` (tracked in git)

**Details:**
1. Change `geo_endpoint` in commonConfig.yaml to MapQuest format
2. Add `mapquest_api_key: process.env.MAPQUEST_API_KEY` to configLib.js
3. Update `resolveLocation()` to try MapQuest with key, fall back to Nominatim (no key needed)

MapQuest endpoint: `https://www.mapquestapi.com/geocoding/v1/reverse?key=${key}&location=${lat},${lon}`
Nominatim fallback: `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`

## Task 2: Super Admin Area

**Objective:** Admin panel at `/views/admin` for user management with IP tracking.

**Files:**
- Modify: `server/dist/models/userProfile.js` — add `lastIp` field
- Modify: `server/dist/routes/authRoutes.js` — capture IP on login
- Create: `server/dist/middleware/superAdminCheck.js` — middleware
- Create: `server/dist/views/admin.ejs` — admin page
- Create: `server/dist/controllers/adminController.js` — API handlers
- Create: `server/dist/routes/adminRoutes.js` — admin API routes
- Modify: `server/dist/routes/viewRoutes.js` — add GET /views/admin
- Modify: `server/dist/server.js` — mount admin routes

**Admin page features:**
- Table of users: email, callsign, displayName, location, lastIp, locked, createdAt, lastLogin
- Actions per row: Edit (modal), Lock/Unlock, Delete
- IP-based banning: blocklist in config or DB
- Bulk actions

## Task 3: Scheduled Nets

**Objective:** NCS can schedule recurring nets — system auto-starts them and sends email reminders.

**Files:**
- Modify: `server/dist/models/netProfile.js` — add `schedule` field
- Create: `server/dist/lib/backgroundTasks/scheduledNetStarter.js` — PluginBase task
- Modify: `server/dist/routes/dataNetProfileRoutes.js` — add schedule endpoints
- Modify: `server/dist/lib/sharedNetOps.js` — expose schedule-aware start
- Modify: `server/dist/devConfig.yaml` — register new background task
- Modify: `server/dist/views/myNets.ejs` — schedule UI on net edit page

**Schedule model (embedded in NetProfile):**
```
schedule: {
  enabled: Boolean,
  dayOfWeek: Number (0=Sun..6=Sat),
  hour: Number (0-23),
  minute: Number (0-59),
  timezone: String (e.g., 'America/Denver'),
  notifyBeforeMinutes: Number (default 30),
  notifyBeforeEnabled: Boolean
}
```

**Background task runs every 60s:**
1. Queries NetProfiles with `schedule.enabled=true`
2. Checks if current time matches the schedule (within a 60s window)
3. If match and no active LiveNet for that profile:
   a. Creates a LiveNet with countdownTimer = notifyBeforeMinutes
   b. Sets ncs auto-wait mode
   c. Sends email to followers