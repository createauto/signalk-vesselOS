# Replit Prompt — Position Logger in signalk-vesseloss
**Target project:** SignalK Vessel
**Files:** index.js (modify) + positionLogger.js (create new)
**Language:** Plain JavaScript, CommonJS
**Date:** April 2026

---

## Actual current index.js structure

```javascript
const tunnel = require('./tunnel');
module.exports = function(app) {
  const plugin = {};
  plugin.id = 'signalk-vesseloss';
  plugin.name = 'VesselOS Remote Access';
  plugin.description = 'Manages Cloudflare tunnel';
  plugin.start = function(options) {
    app.setPluginStatus('Waiting for tunnel token');
  };
  plugin.stop = function() {};
  plugin.registerWithRouter = function(router) { /* /status and /activate routes */ };
  plugin.schema = { title: 'VesselOS', type: 'object', properties: {} };
  return plugin;
};
```

`tunnel.isTunnelRunning()` already exists — use this for connectivity detection.

---

## Step 1 — Create positionLogger.js (new file in root)

```javascript
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BUFFER_PATH = '/data/vesselOS/positions.json';
const LOG_INTERVAL_MS = 30000;
const SPEED_THRESHOLD_KTS = 0.5;
const TRIP_START_READINGS = 10;  // 10 × 30s = 5 min moving → trip start
const TRIP_END_READINGS = 20;    // 20 × 30s = 10 min still → trip end
const MAX_BUFFER_DAYS = 7;

class PositionLogger {
  constructor(supabaseUrl, supabaseKey, vesselId, isTunnelActive) {
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.vesselId = vesselId;
    this.isTunnelActive = isTunnelActive;

    this.intervalHandle = null;
    this.lastLat = null;
    this.lastLng = null;
    this.lastSog = 0;
    this.lastCog = 0;
    this.movingCount = 0;
    this.stationaryCount = 0;
    this.currentTripId = null;

    this._ensureBufferFile();
  }

  onPosition(lat, lng, sog, cog) {
    this.lastLat = lat;
    this.lastLng = lng;
    this.lastSog = sog || 0;
    this.lastCog = cog || 0;
    this._updateTripState(this.lastSog);
  }

  start() {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => this._tick(), LOG_INTERVAL_MS);
    console.log('[VesselOS] Position logger started');
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    console.log('[VesselOS] Position logger stopped');
  }

  _tick() {
    if (this.lastLat === null) return;

    const row = {
      t: Math.floor(Date.now() / 1000),
      la: Math.round(this.lastLat * 1e6) / 1e6,
      lo: Math.round(this.lastLng * 1e6) / 1e6,
      sog: Math.round(this.lastSog * 10) / 10,
      cog: Math.round(this.lastCog),
      syn: false,
    };

    try { this._appendToBuffer(row); }
    catch (err) { console.error('[VesselOS] Buffer write error:', err.message); }

    if (this.isTunnelActive()) {
      this._flushToSupabase().catch(err =>
        console.error('[VesselOS] Flush error:', err.message)
      );
    }

    this._trimBuffer();
  }

  _updateTripState(sog) {
    if (sog >= SPEED_THRESHOLD_KTS) {
      this.movingCount++;
      this.stationaryCount = 0;
      if (!this.currentTripId && this.movingCount >= TRIP_START_READINGS) {
        this.currentTripId = 'trip_' + Date.now();
        console.log('[VesselOS] Trip started:', this.currentTripId);
      }
    } else {
      this.stationaryCount++;
      this.movingCount = 0;
      if (this.currentTripId && this.stationaryCount >= TRIP_END_READINGS) {
        const ended = this.currentTripId;
        this.currentTripId = null;
        console.log('[VesselOS] Trip ended:', ended);
        if (this.isTunnelActive()) {
          this._closeTrip(ended).catch(err =>
            console.error('[VesselOS] Trip close error:', err.message)
          );
        }
      }
    }
  }

  _ensureBufferFile() {
    try {
      const dir = path.dirname(BUFFER_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(BUFFER_PATH)) fs.writeFileSync(BUFFER_PATH, '');
    } catch (err) {
      console.warn('[VesselOS] Could not create buffer file:', err.message);
    }
  }

  _appendToBuffer(row) {
    fs.appendFileSync(BUFFER_PATH, JSON.stringify(row) + '\n');
  }

  _readBuffer() {
    if (!fs.existsSync(BUFFER_PATH)) return [];
    return fs.readFileSync(BUFFER_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  _writeBuffer(rows) {
    fs.writeFileSync(
      BUFFER_PATH,
      rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    );
  }

  _trimBuffer() {
    try {
      const rows = this._readBuffer();
      const cutoff = Math.floor(Date.now() / 1000) - (MAX_BUFFER_DAYS * 86400);
      const trimmed = rows.filter(r => !r.syn || r.t > cutoff);
      if (trimmed.length < rows.length) this._writeBuffer(trimmed);
    } catch (err) {
      console.warn('[VesselOS] Trim error:', err.message);
    }
  }

  async _flushToSupabase() {
    const rows = this._readBuffer();
    const unsynced = rows.filter(r => !r.syn);
    if (unsynced.length === 0) return;

    const payload = unsynced.map(r => ({
      vessel_id: this.vesselId,
      recorded_at: new Date(r.t * 1000).toISOString(),
      lat: r.la,
      lon: r.lo,
      sog_kts: r.sog,
      cog_deg: r.cog,
      trip_id: null,
    }));

    const res = await this._supabaseFetch(
      '/rest/v1/vessel_positions', 'POST', payload
    );

    if (res.ok) {
      const synced = new Set(unsynced.map(r => r.t));
      this._writeBuffer(rows.map(r =>
        synced.has(r.t) ? Object.assign({}, r, { syn: true }) : r
      ));
      console.log('[VesselOS] Flushed', unsynced.length, 'positions to Supabase');
    } else {
      console.error('[VesselOS] Supabase flush failed:', res.status, res.body);
    }
  }

  async _closeTrip(tripId) {
    await this._supabaseFetch('/rest/v1/trips', 'POST', [{
      id: tripId,
      vessel_id: this.vesselId,
      ended_at: new Date().toISOString(),
    }]);
  }

  _supabaseFetch(endpoint, method, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const url = new URL(this.supabaseUrl + endpoint);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'apikey': this.supabaseKey,
          'Authorization': 'Bearer ' + this.supabaseKey,
          'Prefer': 'return=minimal',
        },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body,
        }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

module.exports = { PositionLogger };
```

---

## Step 2 — Update index.js

Replace the entire file with this updated version:

```javascript
'use strict';

const tunnel = require('./tunnel');
const { PositionLogger } = require('./positionLogger');

module.exports = function(app) {
  const plugin = {};
  plugin.id = 'signalk-vesseloss';
  plugin.name = 'VesselOS Remote Access';
  plugin.description = 'Securely connects your vessel to the VesselOS platform';

  // Track Signal K unsubscribe functions
  const unsubscribes = [];
  let positionLogger = null;

  plugin.start = function(options) {
    // Existing tunnel status
    if (tunnel.getStoredToken()) {
      app.setPluginStatus('Remote access enabled');
    } else {
      app.setPluginStatus('Awaiting activation');
    }

    // Position logger
    const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
    const supabaseKey = options.supabaseKey || process.env.SUPABASE_ANON_KEY;
    const vesselId    = options.vesselId    || 'boatholic';

    if (supabaseUrl && supabaseKey) {
      positionLogger = new PositionLogger(
        supabaseUrl,
        supabaseKey,
        vesselId,
        function() { return tunnel.isTunnelRunning(); }
      );

      // Position — streambundle is the correct Signal K plugin subscription API
      unsubscribes.push(
        app.streambundle.getSelfBus('navigation.position')
          .onValue(function(val) {
            if (val && val.latitude != null && val.longitude != null) {
              positionLogger.onPosition(
                val.latitude,
                val.longitude,
                positionLogger.lastSog,
                positionLogger.lastCog
              );
            }
          })
      );

      unsubscribes.push(
        app.streambundle.getSelfBus('navigation.speedOverGround')
          .onValue(function(val) {
            if (val != null) {
              // Signal K speed is in m/s — convert to knots
              positionLogger.lastSog = val * 1.94384;
            }
          })
      );

      unsubscribes.push(
        app.streambundle.getSelfBus('navigation.courseOverGroundTrue')
          .onValue(function(val) {
            if (val != null) {
              // Signal K course is in radians — convert to degrees
              positionLogger.lastCog = (val * 180) / Math.PI;
            }
          })
      );

      positionLogger.start();
    } else {
      app.debug('[VesselOS] Position logger disabled — no Supabase config in plugin settings');
    }
  };

  plugin.stop = function() {
    // Unsubscribe all Signal K path subscriptions
    unsubscribes.forEach(function(unsub) {
      if (typeof unsub === 'function') unsub();
    });
    unsubscribes.length = 0;

    // Stop position logger
    if (positionLogger) {
      positionLogger.stop();
      positionLogger = null;
    }
  };

  plugin.registerWithRouter = function(router) {
    router.get('/status', function(req, res) {
      var hasToken = !!tunnel.getStoredToken();
      var running  = tunnel.isTunnelRunning();
      res.json({
        hasToken: hasToken,
        tunnelRunning: running,
        status: running ? 'active' : hasToken ? 'starting' : 'pending',
      });
    });

    // POST /plugins/signalk-vesseloss/activate
    // Receives tunnel token from VesselOS backend and starts the tunnel.
    // Note: /config is reserved by Signal K — use /activate instead.
    router.post('/activate', function(req, res) {
      var tunnelToken = req.body && req.body.tunnelToken;
      if (!tunnelToken) return res.status(400).json({ error: 'tunnelToken required' });

      tunnel.storeToken(tunnelToken, function(m) { app.debug(m); });
      tunnel.downloadBinary(function(m) { app.debug(m); })
        .then(function() {
          tunnel.createRunitService(function(m) { app.debug(m); });
          tunnel.startTunnel(function(m) { app.debug(m); });
          app.setPluginStatus('Remote access enabled');
        })
        .catch(function(err) { app.debug(err.message); });

      res.json({ success: true });
    });
  };

  plugin.schema = {
    title: 'VesselOS',
    type: 'object',
    properties: {
      supabaseUrl: {
        type: 'string',
        title: 'Supabase URL',
        description: 'VesselOS database URL (from Supabase project settings)',
        default: '',
      },
      supabaseKey: {
        type: 'string',
        title: 'Supabase Anon Key',
        description: 'VesselOS database anon key',
        default: '',
      },
      vesselId: {
        type: 'string',
        title: 'Vessel ID',
        description: 'Your vessel slug from VesselOS (e.g. boatholic)',
        default: '',
      },
    },
  };

  return plugin;
};
```

---

## Step 3 — Create Supabase tables

Run this SQL in your Supabase dashboard (SQL Editor) before restarting the plugin:

```sql
create table if not exists vessel_positions (
  id uuid primary key default gen_random_uuid(),
  vessel_id text not null,
  trip_id text,
  recorded_at timestamptz not null,
  lat float8 not null,
  lon float8 not null,
  sog_kts float4,
  cog_deg float4,
  created_at timestamptz default now()
);

create index if not exists vessel_positions_vessel_time
  on vessel_positions (vessel_id, recorded_at desc);

create table if not exists trips (
  id text primary key,
  vessel_id text not null,
  started_at timestamptz,
  ended_at timestamptz,
  distance_nm float4,
  max_sog_kts float4,
  avg_sog_kts float4,
  name text,
  created_at timestamptz default now()
);
```

---

## Do not change

- tunnel.js — entirely unchanged
- The /activate and /status route logic — preserved exactly as before
- plugin.id, plugin.name — unchanged

---

## After deploying to Cerbo GX

1. Signal K admin → Plugin Config → VesselOS → fill in Supabase URL, Anon Key,
   Vessel ID (`boatholic`) → Save → Restart plugin
2. SSH to Cerbo: `tail -f /data/vesselOS/positions.json`
   — should see a new row every 30 seconds
3. Check Supabase vessel_positions table — rows appear within 30s when
   tunnel is active (boatholic.vessel-os.com reachable)
4. Offline test: `svc -d /service/vesselOS-tunnel/` → wait 2 min →
   `svc -u /service/vesselOS-tunnel/` → buffer should flush automatically
