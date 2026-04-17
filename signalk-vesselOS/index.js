'use strict';

const tunnel = require('./tunnel');
const { PositionLogger } = require('./positionLogger');

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
            tunnel.startTunnel(function(m) { app.debug(m); });
            app.setPluginStatus('Remote access enabled');
          }
        } catch(e) { app.debug('[VesselOS] Poll parse error: ' + e.message); }
      });
    }).on('error', function(e) { app.debug('[VesselOS] Poll error: ' + e.message); });
  }

  plugin.start = function(options) {
    // Read Cerbo serial from hostapd config
    var hostapdConf = '';
    try { hostapdConf = require('fs').readFileSync('/run/hostapd.conf', 'utf8'); } catch(e) {}
    var ssidMatch = hostapdConf.match(/^ssid=venus-(.+)$/m);
    var cerboSerial = ssidMatch ? ssidMatch[1] : null;

    if (tunnel.getStoredToken()) {
      app.setPluginStatus('Remote access enabled');
    } else {
      app.setPluginStatus('Awaiting activation');
    }

    // Poll for tunnel token immediately and every 60 seconds
    if (cerboSerial) {
      pollForToken(cerboSerial);
      setInterval(function() { pollForToken(cerboSerial); }, 60000);
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
