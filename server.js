/**
 * ResourceInn Auto Check-in/out Server
 *
 * SETUP STEPS:
 * 1. cp config.example.json config.json  — fill in your shift details
 * 2. cp .env.example .env               — fill in credentials & schedule
 * 3. npm install
 * 4. npm start
 * 5. Open http://localhost:3000 and test manual check-in before relying on cron
 */

require('dotenv').config();
const fs = require('fs');

// Load user config (shift data, URLs, subdomain, version headers)
const userConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  credentials: {
    email:    process.env.RI_EMAIL    || '',
    password: process.env.RI_PASSWORD || '',
  },

  urls: {
    loginUrl:      userConfig.urls.login,
    attendanceUrl: userConfig.urls.attendance,
  },

  schedule: {
    checkinTime:  process.env.CHECKIN_TIME  || '09:00',
    checkoutTime: process.env.CHECKOUT_TIME || '18:00',
    timezone:     process.env.TZ            || 'Asia/Karachi',
  },

  office: {
    lat:    parseFloat(process.env.OFFICE_LAT    || '0.0'),
    lng:    parseFloat(process.env.OFFICE_LNG    || '0.0'),
    radius: parseFloat(process.env.OFFICE_RADIUS || '200'),
  },

  features: {
    requireLocation:   process.env.REQUIRE_LOCATION === 'true',
    locationTimeoutMs: parseInt(process.env.LOCATION_TIMEOUT_MS || '300000'),
  },

  // Base request headers — version info comes from config.json
  commonHeaders: {
    'accept':           'application/json, text/plain, */*',
    'accept-language':  'en-US,en;q=0.9',
    'origin':           `https://${userConfig.subdomain}.resourceinn.com`,
    'priority':         'u=1, i',
    'referer':          `https://${userConfig.subdomain}.resourceinn.com/`,
    'sec-ch-ua':        '"Not:A-Brand";v="99", "Chromium";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-dest':   'empty',
    'sec-fetch-mode':   'cors',
    'sec-fetch-site':   'same-origin',
    'user-agent':       'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'version-code':     userConfig.headers['version-code'],
    'version-no':       userConfig.headers['version-no'],
    'x-subdomain':      userConfig.subdomain,
  },
};
// ─────────────────────────────────────────────

// ── State ──────────────────────────────────────
let state = {
  sessionToken:      null,
  sessionCookies:    null,
  sessionExpiry:     null,
  lastCheckin:       null,
  lastCheckout:      null,
  lastLocation:      null,  // { lat, lng, accuracy, timestamp }
  locationConfirmed: false,
  log:               [],
};

// ── Utilities ──────────────────────────────────

function log(level, message, data = null) {
  const entry = { time: new Date().toISOString(), level, message, data };
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${message}`, data || '');
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isInOfficePerimeter(lat, lng) {
  const dist = haversineDistance(lat, lng, CONFIG.office.lat, CONFIG.office.lng);
  return { inPerimeter: dist <= CONFIG.office.radius, distance: Math.round(dist) };
}

function parseCronTime(timeStr) {
  const [hour, minute] = timeStr.split(':').map(Number);
  return `${minute} ${hour} * * 1-5`;
}

// ── Auth ────────────────────────────────────────

async function login() {
  try {
    log('info', 'Attempting login...');

    const formData = new URLSearchParams();
    formData.append('email', CONFIG.credentials.email);
    formData.append('password', CONFIG.credentials.password);

    const response = await axios.post(
      CONFIG.urls.loginUrl,
      formData.toString(),
      {
        headers: {
          ...CONFIG.commonHeaders,
          'content-type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const token = response.data?.data?.access_token;
    const cookies = response.headers['set-cookie'];

    if (!token) throw new Error('No access_token in login response.');

    state.sessionToken  = token;
    state.sessionCookies = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : null;
    state.sessionExpiry  = Date.now() + 6 * 24 * 60 * 60 * 1000; // 6 days

    log('success', 'Login successful', { hasToken: true, hasCookies: !!cookies });
    return true;
  } catch (err) {
    log('error', 'Login failed', { message: err.message, status: err.response?.status, data: err.response?.data });
    return false;
  }
}

async function ensureSession() {
  if (!state.sessionToken && !state.sessionCookies) return login();
  if (state.sessionExpiry && Date.now() > state.sessionExpiry - 300000) return login();
  return true;
}

function buildAuthHeaders(contentType = 'application/json') {
  const headers = { ...CONFIG.commonHeaders, 'content-type': contentType };
  if (state.sessionToken)  headers['authorization'] = state.sessionToken;
  if (state.sessionCookies) headers['cookie']       = state.sessionCookies;
  return headers;
}

// ── Attendance payload ──────────────────────────

function getBaseAttendancePayload() {
  return {
    breaks: [
      { id: 1, name: 'Default',       start: 'Break Out',         end: 'Break In',         description: null, created_at: '2020-06-09 12:52:50', updated_at: '2020-06-09 12:52:50', deleted_at: null, icon: null, start_color: null, end_color: null },
      { id: 2, name: 'Personal',      start: 'Personal Out',      end: 'Personal In',      description: null, created_at: '2020-06-09 12:52:50', updated_at: '2020-06-09 12:52:50', deleted_at: null, icon: null, start_color: null, end_color: null },
      { id: 3, name: 'Tea/Smoking',   start: 'Tea/Smoking Out',   end: 'Tea/Smoking In',   description: null, created_at: '2020-06-09 12:52:50', updated_at: '2020-06-09 12:52:50', deleted_at: null, icon: null, start_color: null, end_color: null },
      { id: 4, name: 'Official Work', start: 'Official Work Out', end: 'Official Work In', description: null, created_at: '2020-06-09 12:52:50', updated_at: '2020-06-09 12:52:50', deleted_at: null, icon: null, start_color: null, end_color: null },
      { id: 5, name: 'Lunch',         start: 'Lunch Out',         end: 'Lunch In',         description: null, created_at: '2020-06-09 12:52:50', updated_at: '2020-06-09 12:52:50', deleted_at: null, icon: null, start_color: null, end_color: null },
      { id: 6, name: 'Prayer',        start: 'Prayer Out',        end: 'Prayer In',        description: null, created_at: '2020-06-09 12:52:50', updated_at: '2020-06-09 12:52:50', deleted_at: null, icon: null, start_color: null, end_color: null },
      { id: 7, name: 'Other',         start: 'Other Out',         end: 'Other In',         description: null, created_at: '2020-06-09 12:52:50', updated_at: '2020-06-09 12:52:50', deleted_at: null, icon: null, start_color: null, end_color: null },
    ],
    is_checkin_time:                  false,
    checkin_time:                     '',
    checkin_address:                  '',
    is_checkout_time:                 false,
    checkout_time:                    '',
    checkout_address:                 '',
    break_id:                         null,
    is_break:                         false,
    break_time:                       '',
    use_location_for_mark_attendance: false,
    is_pic_required:                  false,
    is_mark_attendance_allowed:       true,
    shift:                            userConfig.shift,  // loaded from config.json
    geo_fences:                       [],
    mark_checkin:                     false,
  };
}

function postAttendance(payload) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2, 18);
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="mark_attendance"\r\n\r\n` +
    `${JSON.stringify(payload)}\r\n` +
    `--${boundary}--\r\n`;

  return axios.post(
    CONFIG.urls.attendanceUrl,
    body,
    { headers: buildAuthHeaders(`multipart/form-data; boundary=${boundary}`) }
  );
}

// ── Check-in / Check-out ────────────────────────

async function performCheckin(triggeredBy = 'cron') {
  if (!(await ensureSession())) {
    log('error', 'Check-in aborted — could not establish session');
    return { success: false, reason: 'auth_failed' };
  }

  const todayStr = new Date().toDateString();
  if (state.lastCheckin && new Date(state.lastCheckin).toDateString() === todayStr) {
    log('warn', 'Check-in skipped — already checked in today');
    return { success: false, reason: 'already_checked_in' };
  }

  try {
    log('info', `Performing check-in (triggered by: ${triggeredBy})...`);

    const payload = getBaseAttendancePayload();
    payload.mark_checkin = true;

    const response = await postAttendance(payload);

    state.lastCheckin = new Date().toISOString();
    log('success', 'Check-in successful', { status: response.status, data: response.data });
    return { success: true, time: state.lastCheckin, data: response.data };
  } catch (err) {
    log('error', 'Check-in failed', { message: err.message, status: err.response?.status, data: err.response?.data });
    return { success: false, reason: err.message };
  }
}

async function performCheckout(triggeredBy = 'cron') {
  if (!(await ensureSession())) {
    log('error', 'Check-out aborted — could not establish session');
    return { success: false, reason: 'auth_failed' };
  }

  const todayStr = new Date().toDateString();
  if (state.lastCheckout && new Date(state.lastCheckout).toDateString() === todayStr) {
    log('warn', 'Check-out skipped — already checked out today');
    return { success: false, reason: 'already_checked_out' };
  }

  try {
    log('info', `Performing check-out (triggered by: ${triggeredBy})...`);

    const payload = getBaseAttendancePayload();
    payload.is_checkin_time = true;
    payload.checkin_time    = state.lastCheckin
      ? state.lastCheckin.replace('T', ' ').substring(0, 19)
      : new Date().toISOString().replace('T', ' ').substring(0, 19);
    payload.mark_checkout   = true;

    const response = await postAttendance(payload);

    state.lastCheckout = new Date().toISOString();
    log('success', 'Check-out successful', { status: response.status, data: response.data });
    return { success: true, time: state.lastCheckout, data: response.data };
  } catch (err) {
    log('error', 'Check-out failed', { message: err.message, status: err.response?.status, data: err.response?.data });
    return { success: false, reason: err.message };
  }
}

// ── Location-gated logic ────────────────────────

async function handleLocationTriggeredCheckin(lat, lng) {
  const { inPerimeter, distance } = isInOfficePerimeter(lat, lng);
  log('info', `Location received — ${distance}m from office, in perimeter: ${inPerimeter}`, { lat, lng });

  state.lastLocation    = { lat, lng, timestamp: new Date().toISOString(), distance };
  state.locationConfirmed = inPerimeter;

  if (!inPerimeter) {
    return { triggered: false, reason: `Outside perimeter (${distance}m away, max: ${CONFIG.office.radius}m)` };
  }

  const now = new Date();
  const [ciH, ciM] = CONFIG.schedule.checkinTime.split(':').map(Number);
  const windowStart = new Date(now); windowStart.setHours(ciH, ciM - 30, 0, 0);
  const windowEnd   = new Date(now); windowEnd.setHours(ciH, ciM + 60, 0, 0);

  if (now >= windowStart && now <= windowEnd) {
    const result = await performCheckin('location_ping');
    return { triggered: true, action: 'checkin', distance, ...result };
  }

  return { triggered: false, reason: 'In perimeter but outside check-in time window', distance };
}

// ── Cron Jobs ──────────────────────────────────

function scheduleCrons() {
  const tz = CONFIG.schedule.timezone;

  cron.schedule(parseCronTime(CONFIG.schedule.checkinTime), async () => {
    log('info', `[CRON] Check-in triggered at ${CONFIG.schedule.checkinTime}`);
    if (CONFIG.features.requireLocation) {
      const locationAge = state.lastLocation
        ? Date.now() - new Date(state.lastLocation.timestamp).getTime()
        : Infinity;
      if (state.locationConfirmed && locationAge < CONFIG.features.locationTimeoutMs) {
        await performCheckin('cron+location');
      } else {
        log('warn', '[CRON] Check-in skipped — no recent in-perimeter location ping', {
          locationAge: Math.round(locationAge / 1000) + 's',
          confirmed: state.locationConfirmed,
        });
      }
    } else {
      await performCheckin('cron');
    }
  }, { timezone: tz });

  cron.schedule(parseCronTime(CONFIG.schedule.checkoutTime), async () => {
    log('info', `[CRON] Check-out triggered at ${CONFIG.schedule.checkoutTime}`);
    await performCheckout('cron');
  }, { timezone: tz });

  log('info', `Crons scheduled — check-in: ${CONFIG.schedule.checkinTime}, check-out: ${CONFIG.schedule.checkoutTime} [${tz}]`);
}

// ── API Routes ─────────────────────────────────

app.post('/api/location-ping', async (req, res) => {
  const { lat, lng } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  const result = await handleLocationTriggeredCheckin(parseFloat(lat), parseFloat(lng));
  res.json(result);
});

app.get('/api/status', (req, res) => {
  const { inPerimeter, distance } = state.lastLocation
    ? isInOfficePerimeter(state.lastLocation.lat, state.lastLocation.lng)
    : { inPerimeter: false, distance: null };

  res.json({
    lastCheckin:      state.lastCheckin,
    lastCheckout:     state.lastCheckout,
    lastLocation:     state.lastLocation,
    locationConfirmed: state.locationConfirmed,
    inPerimeter,
    distanceToOffice: distance,
    hasSession:       !!(state.sessionToken || state.sessionCookies),
    sessionExpiry:    state.sessionExpiry,
    config: {
      checkinTime:      CONFIG.schedule.checkinTime,
      checkoutTime:     CONFIG.schedule.checkoutTime,
      timezone:         CONFIG.schedule.timezone,
      requireLocation:  CONFIG.features.requireLocation,
      officeRadius:     CONFIG.office.radius,
    },
    log: state.log.slice(0, 20),
  });
});

app.post('/api/manual/checkin',  async (req, res) => res.json(await performCheckin('manual')));
app.post('/api/manual/checkout', async (req, res) => res.json(await performCheckout('manual')));
app.post('/api/manual/login',    async (req, res) => res.json({ success: await login() }));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Boot ───────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log('info', `Server running on port ${PORT}`);
  scheduleCrons();
  await login();
});
