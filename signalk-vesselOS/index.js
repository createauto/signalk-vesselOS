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
  plugin.registerWithRouter = function(router) {
    router.get('/status', function(req, res) {
      var hasToken = !!tunnel.getStoredToken();
      var running = tunnel.isTunnelRunning();
      res.json({ hasToken: hasToken, tunnelRunning: running, status: running ? 'active' : hasToken ? 'starting' : 'pending' });
    });
    // POST /plugins/signalk-vesseloss/activate
    // Receives the tunnel token from VesselOS backend and starts the tunnel.
    // Note: /config is reserved by Signal K for plugin configuration — use /activate instead.
    router.post('/activate', function(req, res) {
      var tunnelToken = req.body && req.body.tunnelToken;
      if (!tunnelToken) return res.status(400).json({ error: 'tunnelToken required' });
      tunnel.storeToken(tunnelToken, function(m) { app.debug(m); });
      tunnel.downloadBinary(function(m) { app.debug(m); })
        .then(function() {
          tunnel.createRunitService(function(m) { app.debug(m); });
          tunnel.startTunnel(function(m) { app.debug(m); });
          app.setPluginStatus('VesselOS tunnel active');
        })
        .catch(function(err) { app.debug(err.message); });
      res.json({ success: true });
    });
  };
  plugin.schema = { title: 'VesselOS', type: 'object', properties: {} };
  return plugin;
};
