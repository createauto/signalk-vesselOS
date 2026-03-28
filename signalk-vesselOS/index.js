const tunnel = require('./tunnel');

module.exports = function (app) {
  const plugin = {};

  plugin.id = 'signalk-vesselOS';
  plugin.name = 'VesselOS Remote Access';
  plugin.description = 'Manages Cloudflare tunnel for VesselOS remote access';

  let statusInterval = null;

  plugin.start = async function (options) {
    const log = (msg) => app.debug(`[VesselOS] ${msg}`);
    app.setPluginStatus('Starting VesselOS tunnel manager');

    try {
      const hasToken = tunnel.createRunitService(log);

      if (!hasToken) {
        app.setPluginStatus(
          'Waiting for tunnel token — complete remote access setup in VesselOS'
        );
        log('No tunnel token found. Plugin ready to receive token via REST API.');
      } else {
        app.setPluginStatus('Downloading cloudflared...');
        await tunnel.downloadBinary(log);

        tunnel.createRunitService(log);

        app.setPluginStatus('Starting Cloudflare tunnel...');
        tunnel.startTunnel(log);

        app.setPluginStatus('VesselOS tunnel active');
      }

      app.handleMessage(plugin.id, {
        updates: [
          {
            source: { label: plugin.id },
            values: [
              {
                path: 'electrical.vesselOS.tunnel.status',
                value: hasToken ? 'active' : 'pending',
              },
              {
                path: 'electrical.vesselOS.tunnel.hasToken',
                value: hasToken,
              },
            ],
          },
        ],
      });

      statusInterval = setInterval(() => {
        const running = tunnel.isTunnelRunning();
        app.handleMessage(plugin.id, {
          updates: [
            {
              source: { label: plugin.id },
              values: [
                {
                  path: 'electrical.vesselOS.tunnel.status',
                  value: running ? 'active' : 'inactive',
                },
              ],
            },
          ],
        });
      }, 30000);

      app.post('/plugins/signalk-vesselOS/config', (req, res) => {
        const { tunnelToken } = req.body;

        if (!tunnelToken) {
          return res.status(400).json({ error: 'tunnelToken required' });
        }

        log('Received tunnel token from VesselOS');

        tunnel.storeToken(tunnelToken, log);

        tunnel
          .downloadBinary(log)
          .then(() => {
            tunnel.createRunitService(log);
            tunnel.startTunnel(log);
            app.setPluginStatus('VesselOS tunnel active');
            log('Tunnel started successfully after token received');
          })
          .catch((err) => {
            log('Error starting tunnel after token received: ' + err.message);
          });

        res.json({
          success: true,
          message: 'Token received — tunnel starting in background',
        });
      });

      app.get('/plugins/signalk-vesselOS/status', (req, res) => {
        const hasToken = !!tunnel.getStoredToken();
        const running = tunnel.isTunnelRunning();
        res.json({
          hasToken,
          tunnelRunning: running,
          status: running ? 'active' : hasToken ? 'starting' : 'pending',
        });
      });
    } catch (err) {
      app.setPluginError('VesselOS tunnel error: ' + err.message);
      log('Plugin startup error: ' + err.message);
    }
  };

  plugin.stop = function () {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
    app.debug(
      '[VesselOS] Plugin stopped — tunnel continues running via runit'
    );
  };

  plugin.schema = {
    title: 'VesselOS Remote Access',
    type: 'object',
    properties: {
      vesselOSUrl: {
        type: 'string',
        title: 'VesselOS Backend URL',
        description: 'URL of the VesselOS backend API',
        default: 'https://api.vessel-os.com',
      },
    },
  };

  return plugin;
};
