# OphyCare ResourceInn Auto Check-in/out

Automated attendance for OphyCare ResourceInn — works by replicating the exact HTTP requests your browser makes, with optional GPS perimeter verification.

---

## How It Works

### The Core Idea
This system:
1. Logs in to OphyCare ResourceInn using your credentials
2. Captures the session token (JWT Bearer token)
3. Automatically marks attendance at scheduled times using the same API endpoints as the web interface
4. Optionally verifies your location is within office perimeter before checking in

### Two Modes

| Feature | Time-only Mode | Location Mode |
|---|---|---|
| How check-in fires | Cron job at scheduled time | Phone pings GPS → server verifies perimeter → then checks in at cron time |
| `REQUIRE_LOCATION` | `false` | `true` |
| Need phone interaction? | No | Yes (or automated with shortcuts) |
| Best for | Fully hands-off | Transparency / accountability |

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your credentials and schedule
```

**Important settings in `.env`:**
- `RI_EMAIL`: Your OphyCare email (e.g., `m.awais@ophycare.com`)
- `RI_PASSWORD`: Your OphyCare password
- `CHECKIN_TIME`: Check-in time in UTC (default `11:00` = 6:00 AM PKT)
- `CHECKOUT_TIME`: Check-out time in UTC (default `20:00` = 3:00 PM PKT)
- `OFFICE_LAT` / `OFFICE_LNG`: Office coordinates
- `OFFICE_RADIUS`: Perimeter radius in meters (default 200m)
- `REQUIRE_LOCATION`: Set to `true` to enable location verification

### 3. Find Your Office Coordinates
1. Go to [Google Maps](https://maps.google.com)
2. Right-click your office location → "What's here?"
3. Copy the latitude and longitude to `.env`

### 4. Test Locally
```bash
npm start
# Server will start on http://localhost:3000
```

Open the dashboard in your browser and test manual check-in/check-out buttons to verify everything works.

---

## API Implementation Details

The system uses these OphyCare ResourceInn endpoints:

### Login
```
POST https://ophycare.resourceinn.com/api/v1/oauth/webLogin
Content-Type: application/x-www-form-urlencoded

email=your.email@ophycare.com&password=your_password

Response:
{
  "data": {
    "access_token": "Bearer eyJ0eXAiOiJKV1QiLCJhbGc...",
    ...
  }
}
```

### Check-in / Check-out
```
POST https://ophycare.resourceinn.com/api/v1/directives/markAttendance
Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGc...
Content-Type: multipart/form-data

mark_attendance={
  "mark_checkin": true,  // for check-in
  OR
  "is_checkin_time": true,
  "checkin_time": "2026-02-17 11:35:13",
  "mark_checkout": true,  // for check-out
  ...
}
```

Both check-in and check-out use the **same endpoint** with different payload flags.

---

## Deployment

### Option A — Railway (Recommended)
```bash
npm install -g @railway/cli

railway login
railway init
railway up

# Set environment variables
railway variables set RI_EMAIL=your.email@ophycare.com
railway variables set RI_PASSWORD=your_password
railway variables set CHECKIN_TIME=11:00
railway variables set CHECKOUT_TIME=20:00
```

Railway provides a permanent HTTPS URL like `https://autocheckin-production.up.railway.app`

### Option B — Render
1. Push to GitHub
2. Create new Web Service on [render.com](https://render.com)
3. Connect your repository
4. Add environment variables in dashboard
5. Note: Free tier sleeps after 15min inactivity — use [UptimeRobot](https://uptimerobot.com) to ping `/health` every 5 minutes

### Option C — Local Server (24/7 machine)
If you have a home server or VPS:
```bash
# Install PM2 for process management
npm install -g pm2

# Start the service
pm2 start server.js --name "ophycare-checkin"

# Enable auto-start on system boot
pm2 startup
pm2 save
```

---

## Location Mode Setup

When `REQUIRE_LOCATION=true`, the server waits for a location confirmation before checking in.

### Flow:
```
1. Your phone sends GPS coordinates to server
2. Server calculates distance to office
3. If within OFFICE_RADIUS meters → marks locationConfirmed
4. At scheduled CHECKIN_TIME, cron checks if locationConfirmed is recent (< 5 min)
5. If yes → performs check-in
```

### Automation Options:

#### iOS Shortcuts
1. Create a new Automation in Shortcuts app
2. Trigger: "When I arrive" at office location
3. Action: Get contents of `https://your-server.com/api/location-ping` (POST)
4. Body: `{"lat": YOUR_LAT, "lng": YOUR_LNG}`

#### Android Tasker
1. Profile: Location → Near office (radius 200m)
2. Task: HTTP Request
   - Method: POST
   - URL: `https://your-server.com/api/location-ping`
   - Body: `{"lat": %LOC_LAT, "lng": %LOC_LNG}`

#### Manual (Simplest)
Just bookmark the dashboard URL and open it when you arrive at office. The page auto-pings your location.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Dashboard UI |
| GET | `/api/status` | Status JSON (last check-in/out, location, etc.) |
| POST | `/api/location-ping` | `{"lat": 24.86, "lng": 67.00}` |
| POST | `/api/manual/checkin` | Force check-in now |
| POST | `/api/manual/checkout` | Force check-out now |
| POST | `/api/manual/login` | Re-authenticate |
| GET | `/health` | Health check |

---

## Timezone & Scheduling

The server uses **Asia/Karachi** timezone by default. Cron jobs run **Monday-Friday only**.

Times in `.env` are in **UTC format**, which is 5 hours behind Pakistan Time:
- `CHECKIN_TIME=11:00` → 6:00 AM PKT
- `CHECKOUT_TIME=20:00` → 3:00 PM PKT (1:00 AM next day UTC)

Adjust according to your actual shift timings.

---

## Failsafe Behavior

- **Already checked in today?** → Skips silently
- **Already checked out today?** → Skips silently
- **Session expired?** → Auto re-authenticates before each action
- **Login fails?** → Logs error, retries on next cron cycle
- **Location mode + no recent ping?** → Skips check-in, logs warning
- **Check-out** is always time-based (doesn't require location)

---

## Security Notes

- Store credentials in environment variables only — never commit `.env` to git
- Add `.env` to `.gitignore`
- Consider adding basic HTTP authentication for the dashboard if exposing publicly
- JWT tokens expire after ~6 days but are auto-refreshed on each action
- For team deployments, each person should have their own server instance with their own credentials

---

## Troubleshooting

### Check-in/out not working?
1. Check server logs for errors
2. Verify credentials in `.env`
3. Test manual check-in via dashboard
4. Ensure server is not sleeping (if using free hosting)

### Location not detected?
1. Enable browser location permissions
2. Check `OFFICE_LAT` / `OFFICE_LNG` / `OFFICE_RADIUS` in `.env`
3. Test by manually pinging `/api/location-ping` with your coordinates
4. Check `/api/status` to see last location and distance

### Cron not firing?
1. Verify timezone is correct (`TZ=Asia/Karachi`)
2. Check that it's a weekday (Monday-Friday only)
3. Verify server hasn't crashed or been put to sleep
4. Check server logs for cron trigger messages

---

## License

MIT — Use at your own risk. This is for personal automation purposes only.
