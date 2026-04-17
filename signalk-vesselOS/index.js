'use strict';

const tunnel = require('./tunnel');
const { PositionLogger } = require('./positionLogger');

function getOrCreateDeviceId(app) {
  var fs = require('fs');
  var deviceIdFile = '/data/vesselOS/device-id';

  try {
    var existing = fs.readFileSync(deviceIdFile, 'utf8').trim();
    if (existing && existing.startsWith('VSOS-')) {
      app.debug('[VesselOS] Using existing device ID: ' + existing);
      return existing;
    }
  } catch(e) {}

  var mac = null;
  var interfaces = ['eth0', 'wlan0', 'wifi0', 'ap0'];
  for (var i = 0; i < interfaces.length; i++) {
    try {
      var addr = fs.readFileSync('/sys/class/net/' + interfaces[i] + '/address', 'utf8').trim();
      if (addr && addr !== '00:00:00:00:00:00' && addr !== '') {
        mac = addr.replace(/:/g, '');
        app.debug('[VesselOS] Using MAC from ' + interfaces[i] + ': ' + mac);
        break;
      }
    } catch(e) {}
  }

  if (!mac) {
    mac = require('crypto').randomBytes(6).toString('hex');
    app.debug('[VesselOS] No MAC found, using random: ' + mac);
  }

  var deviceId = 'VSOS-' + mac;

  try {
    fs.writeFileSync(deviceIdFile, deviceId);
    app.debug('[VesselOS] Generated device ID: ' + deviceId);
  } catch(e) {
    app.debug('[VesselOS] Could not write device ID: ' + e.message);
  }

  return deviceId;
}

function registerDevice(app, deviceId, serial) {
  if (!deviceId || !serial) return;
  var https = require('https');
  var body = JSON.stringify({ device_id: deviceId, serial: serial });
  var options = {
    hostname: 'api.vessel-os.com',
    path: '/api/vessels/register',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  var req = https.request(options, function(res) {
    var data = '';
    res.on('data', function(chunk) { data += chunk; });
    res.on('end', function() {
      try {
        var parsed = JSON.parse(data);
        app.debug('[VesselOS] Register result: ' + JSON.stringify(parsed));
      } catch(e) {}
    });
  });
  req.on('error', function(e) {
    app.debug('[VesselOS] Register error: ' + e.message);
  });
  req.write(body);
  req.end();
}

module.exports = function(app) {
  const plugin = {};
  plugin.id = 'signalk-vesseloss';
  plugin.name = 'VesselOS Remote Access';
  plugin.description = 'Securely connects your vessel to the VesselOS platform';

  let positionLogger = null;

  function pollForToken(serial) {
    var fs = require('fs');
    var tokenFile = '/data/vesselOS/tunnel-token';
    var currentToken = '';
    try { currentToken = fs.readFileSync(tokenFile, 'utf8').trim(); } catch(e) {}

    var https = require('https');
    var url = 'https://api.vessel-os.com/api/vessels/token/' + encodeURIComponent(serial);
    app.debug('[VesselOS] Polling token: ' + url);

    https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          if (parsed.tunnelToken && parsed.tunnelToken !== currentToken) {
            app.debug('[VesselOS] New token received — applying');
            fs.writeFileSync(tokenFile, parsed.tunnelToken);
            tunnel.restartTunnel(function(m) { app.debug(m); });
            app.setPluginStatus('Remote access enabled');
          }
        } catch(e) { app.debug('[VesselOS] Poll parse error: ' + e.message); }
      });
    }).on('error', function(e) { app.debug('[VesselOS] Poll error: ' + e.message); });
  }

  plugin.start = function(options) {
    var cerboSerial = getOrCreateDeviceId(app);

    var hostapdConf = '';
    try { hostapdConf = require('fs').readFileSync('/run/hostapd.conf', 'utf8'); } catch(e) {}
    var ssidMatch = hostapdConf.match(/^ssid=venus-(.+)$/m);
    var hardwareSerial = ssidMatch ? ssidMatch[1] : null;

    registerDevice(app, cerboSerial, hardwareSerial);

    if (tunnel.getStoredToken()) {
      app.setPluginStatus('Remote access enabled');
    } else {
      app.setPluginStatus('Awaiting activation');
    }

    if (cerboSerial) {
      var pollCount = 0;
      var fastPollLimit = 24;

      function schedulePoll() {
        pollForToken(cerboSerial);
        pollCount++;
        if (pollCount < fastPollLimit) {
          setTimeout(schedulePoll, 5000);
        } else {
          setInterval(function() { pollForToken(cerboSerial); }, 60000);
        }
      }

      schedulePoll();
    }

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
      positionLogger.start();
    } else {
      app.debug('[VesselOS] Position logger disabled — no Supabase config');
    }
  };

  plugin.stop = function() {
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
