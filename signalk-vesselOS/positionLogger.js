'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BUFFER_PATH = '/data/vesselOS/positions.json';
const LOG_INTERVAL_MS = 30000;
const SPEED_THRESHOLD_KTS = 0.5;
const TRIP_START_READINGS = 10;
const TRIP_END_READINGS = 20;
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

  async _tick() {
    try {
      const pos = await this._fetchPosition();
      if (!pos) return;

      this.lastLat = pos.latitude;
      this.lastLng = pos.longitude;

      const sog = await this._fetchValue('navigation/speedOverGround');
      const cog = await this._fetchValue('navigation/courseOverGroundTrue');

      this.lastSog = sog != null ? Math.round(sog * 1.94384 * 10) / 10 : 0;
      this.lastCog = cog != null ? Math.round((cog * 180) / Math.PI) : 0;

      this._updateTripState(this.lastSog);
    } catch (err) {
      console.error('[VesselOS] Position fetch error:', err.message);
      return;
    }

    const row = {
      t: Math.floor(Date.now() / 1000),
      la: Math.round(this.lastLat * 1e6) / 1e6,
      lo: Math.round(this.lastLng * 1e6) / 1e6,
      sog: this.lastSog,
      cog: this.lastCog,
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

  _fetchPosition() {
    return new Promise((resolve) => {
      const req = require('http').get(
        'http://localhost:3000/signalk/v1/api/vessels/self/navigation/position',
        (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.value || null);
            } catch { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
  }

  _fetchValue(path) {
    return new Promise((resolve) => {
      const req = require('http').get(
        `http://localhost:3000/signalk/v1/api/vessels/self/${path}`,
        (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.value != null ? json.value : null);
            } catch { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
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
