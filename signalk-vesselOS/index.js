'use strict';

const tunnel = require('./tunnel');
const { PositionLogger } = require('./positionLogger');

module.exports = function(app) {
  const plugin = {};
  plugin.id = 'signalk-vesseloss';
  plugin.name = 'VesselOS Remote Access';
  plugin.description = 'Securely connects your vessel to the VesselOS platform';

  let positionLogger = null;

  plugin.start = function(options) {
    if (tunnel.getStoredToken()) {
      app.setPluginStatus('Remote access enabled');
    } else {
      app.setPluginStatus('Awaiting activation');
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
