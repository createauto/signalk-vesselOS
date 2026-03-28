# VesselOS Signal K Plugin — Build Prompt

Paste this into Replit AI or any coding assistant to build the complete
Signal K plugin that manages the Cloudflare tunnel on the Cerbo GX.

---

## Overview

Build a Signal K plugin called `signalk-vesselOS` that runs on the Cerbo GX
(Venus OS Large) and manages the Cloudflare tunnel daemon (`cloudflared`).

The plugin:
1. Receives a tunnel token from the VesselOS backend via Signal K REST API
2. Downloads the correct `cloudflared` binary for the platform (ARM for Venus OS)
3. Installs it to `/data/vesselOS/` (persistent storage — survives firmware updates)
4. Creates a runit service definition so the tunnel starts automatically on boot
5. Recreates the runit service on every plugin startup (handles firmware update resilience)
6. Reports tunnel status back via Signal K paths
7. Exposes a REST endpoint for the VesselOS frontend to push the tunnel token

---

## Platform Context

Venus OS uses runit (not systemd) for service management. The root filesystem
is reflashed on firmware updates — only `/data/` persists. The plugin must:
- Store all binaries and config in `/data/vesselOS/`
- Recreate `/etc/sv/vesselOS-tunnel/` on every startup
- Never assume the runit service survived a firmware update

Signal K plugins on Venus OS run as Node.js processes managed by Signal K itself.

---

## Project Structure

```
signalk-vesselOS/
├── index.js          — Main plugin entry point
├── tunnel.js         — Cloudflared lifecycle management
├── package.json      — Plugin manifest
└── README.md
```

---

## package.json

```json
{
  "name": "signalk-vesselOS",
  "version": "1.0.0",
  "description": "VesselOS remote access tunnel manager for Signal K",
  "keywords": ["signalk-node-server-plugin"],
  "signalk-plugin-id": "signalk-vesselOS",
  "signalk-plugin-name": "VesselOS Remote Access",
  "signalk-plugin-description": "Manages Cloudflare tunnel for VesselOS remote access",
  "main": "index.js",
  "scripts": {
    "test": "echo \"No tests\" && exit 0"
  },
  "dependencies": {},
  "license": "Apache-2.0"
}
```

---

## tunnel.js — Cloudflared Lifecycle Manager

```javascript
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const INSTALL_DIR = '/data/vesselOS';
const BINARY_PATH = path.join(INSTALL_DIR, 'cloudflared');
const TOKEN_PATH = path.join(INSTALL_DIR, 'tunnel-token');
const RUNIT_DIR = '/etc/sv/vesselOS-tunnel';
const RUNIT_LOG_DIR = '/etc/sv/vesselOS-tunnel/log';

// Platform detection — Venus OS on Cerbo GX is ARM
function getArchitecture() {
  try {
    const arch = execSync('uname -m').toString().trim();
    if (arch === 'aarch64') return 'arm64';
    if (arch.startsWith('arm')) return 'arm';
    if (arch === 'x86_64') return 'amd64';
    return 'arm'; // default for Venus OS
  } catch {
    return 'arm';
  }
}

// Cloudflared download URL for the detected architecture
function getDownloadUrl() {
  const arch = getArchitecture();
  // Using a pinned stable release for reliability
  const version = '2024.2.1';
  return `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-${arch}`;
}

// Download cloudflared binary
async function downloadBinary(log) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(INSTALL_DIR)) {
      fs.mkdirSync(INSTALL_DIR, { recursive: true });
    }

    // Check if binary already exists and is executable
    if (fs.existsSync(BINARY_PATH)) {
      try {
        execSync(`${BINARY_PATH} --version`, { stdio: 'pipe' });
        log('cloudflared binary already present and working');
        resolve();
        return;
      } catch {
        log('Existing binary not working — redownloading');
        fs.unlinkSync(BINARY_PATH);
      }
    }

    const url = getDownloadUrl();
    log(`Downloading cloudflared from ${url}`);

    const file = fs.createWriteStream(BINARY_PATH);

    const download = (downloadUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const urlObj = new URL(downloadUrl);
      https.get({ hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          download(res.headers.location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(BINARY_PATH, '755');
          log('cloudflared downloaded and made executable');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlinkSync(BINARY_PATH);
        reject(err);
      });
    };

    download(url);
  });
}

// Create runit service definition
// This is called on EVERY plugin startup — intentionally
// Venus OS firmware updates wipe /etc/sv/ so we always recreate
function createRunitService(log) {
  log('Creating/recreating runit service definition');

  // Create service directory
  if (!fs.existsSync(RUNIT_DIR)) {
    fs.mkdirSync(RUNIT_DIR, { recursive: true });
  }
  if (!fs.existsSync(RUNIT_LOG_DIR)) {
    fs.mkdirSync(RUNIT_LOG_DIR, { recursive: true });
  }

  // Read stored token
  if (!fs.existsSync(TOKEN_PATH)) {
    log('No tunnel token stored — skipping runit service creation');
    return false;
  }

  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();

  // Write run script
  const runScript = `#!/bin/sh
exec ${BINARY_PATH} tunnel --no-autoupdate run --token ${token} 2>&1
`;
  fs.writeFileSync(path.join(RUNIT_DIR, 'run'), runScript);
  fs.chmodSync(path.join(RUNIT_DIR, 'run'), '755');

  // Write log run script
  const logScript = `#!/bin/sh
exec svlogd -tt /var/log/vesselOS-tunnel
`;
  fs.writeFileSync(path.join(RUNIT_LOG_DIR, 'run'), logScript);
  fs.chmodSync(path.join(RUNIT_LOG_DIR, 'run'), '755');

  log('Runit service created at ' + RUNIT_DIR);
  return true;
}

// Start or restart the tunnel via runit
function startTunnel(log) {
  try {
    // Enable the service (create symlink in /etc/runit/runsvdir/current)
    const currentDir = '/etc/runit/runsvdir/current';
    const symlink = path.join(currentDir, 'vesselOS-tunnel');

    if (fs.existsSync(currentDir) && !fs.existsSync(symlink)) {
      fs.symlinkSync(RUNIT_DIR, symlink);
      log('Enabled vesselOS-tunnel in runit');
    }

    // Start via sv
    try {
      execSync('sv start vesselOS-tunnel', { stdio: 'pipe' });
      log('Tunnel started via sv');
    } catch {
      // sv may not be available or service may already be running
      log('sv start attempted (may already be running)');
    }

    return true;
  } catch (err) {
    log('Error starting tunnel: ' + err.message);
    return false;
  }
}

// Stop the tunnel
function stopTunnel(log) {
  try {
    execSync('sv stop vesselOS-tunnel', { stdio: 'pipe' });
    log('Tunnel stopped');
  } catch {
    // Already stopped or sv not available
  }
}

// Check if tunnel is running
function isTunnelRunning() {
  try {
    const result = execSync('sv status vesselOS-tunnel 2>/dev/null || echo "down"', {
      stdio: 'pipe'
    }).toString().trim();
    return result.startsWith('run:');
  } catch {
    return false;
  }
}

// Store tunnel token to disk
function storeToken(token, log) {
  if (!fs.existsSync(INSTALL_DIR)) {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
  }
  fs.writeFileSync(TOKEN_PATH, token, 'utf8');
  fs.chmodSync(TOKEN_PATH, '600'); // readable by root only
  log('Tunnel token stored to ' + TOKEN_PATH);
}

// Get stored token
function getStoredToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

module.exports = {
  downloadBinary,
  createRunitService,
  startTunnel,
  stopTunnel,
  isTunnelRunning,
  storeToken,
  getStoredToken,
};
```

---

## index.js — Main Plugin Entry Point

```javascript
const tunnel = require('./tunnel');
const fs = require('fs');

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
      // Step 1: Always recreate runit service on startup
      // This handles the case where a firmware update wiped /etc/sv/
      const hasToken = tunnel.createRunitService(log);

      if (!hasToken) {
        app.setPluginStatus('Waiting for tunnel token — complete remote access setup in VesselOS');
        log('No tunnel token found. Plugin ready to receive token via REST API.');
      } else {
        // Step 2: Download cloudflared if not present
        app.setPluginStatus('Downloading cloudflared...');
        await tunnel.downloadBinary(log);

        // Step 3: Recreate runit service with binary path confirmed
        tunnel.createRunitService(log);

        // Step 4: Start tunnel
        app.setPluginStatus('Starting Cloudflare tunnel...');
        tunnel.startTunnel(log);

        app.setPluginStatus('VesselOS tunnel active');
      }

      // Step 5: Register Signal K data paths
      app.handleMessage(plugin.id, {
        updates: [{
          source: { label: plugin.id },
          values: [
            {
              path: 'electrical.vesselOS.tunnel.status',
              value: hasToken ? 'active' : 'pending'
            },
            {
              path: 'electrical.vesselOS.tunnel.hasToken',
              value: hasToken
            }
          ]
        }]
      });

      // Step 6: Poll tunnel status every 30 seconds
      statusInterval = setInterval(() => {
        const running = tunnel.isTunnelRunning();
        app.handleMessage(plugin.id, {
          updates: [{
            source: { label: plugin.id },
            values: [{
              path: 'electrical.vesselOS.tunnel.status',
              value: running ? 'active' : 'inactive'
            }]
          }]
        });
      }, 30000);

      // Step 7: Register REST endpoint for VesselOS frontend to push tunnel token
      // POST /plugins/signalk-vesselOS/config
      // Body: { "tunnelToken": "eyJ..." }
      app.post('/plugins/signalk-vesselOS/config', (req, res) => {
        const { tunnelToken } = req.body;

        if (!tunnelToken) {
          return res.status(400).json({ error: 'tunnelToken required' });
        }

        log('Received tunnel token from VesselOS');

        // Store token
        tunnel.storeToken(tunnelToken, log);

        // Download binary and start tunnel async
        tunnel.downloadBinary(log)
          .then(() => {
            tunnel.createRunitService(log);
            tunnel.startTunnel(log);
            app.setPluginStatus('VesselOS tunnel active');
            log('Tunnel started successfully after token received');
          })
          .catch((err) => {
            log('Error starting tunnel after token received: ' + err.message);
          });

        // Respond immediately — tunnel starts in background
        res.json({
          success: true,
          message: 'Token received — tunnel starting in background'
        });
      });

      // GET /plugins/signalk-vesselOS/status — health check for VesselOS frontend
      app.get('/plugins/signalk-vesselOS/status', (req, res) => {
        const hasToken = !!tunnel.getStoredToken();
        const running = tunnel.isTunnelRunning();
        res.json({
          hasToken,
          tunnelRunning: running,
          status: running ? 'active' : hasToken ? 'starting' : 'pending'
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
    // Do NOT stop the tunnel on plugin stop — it should keep running
    // The runit service manages the tunnel independently of the plugin
    app.debug('[VesselOS] Plugin stopped — tunnel continues running via runit');
  };

  plugin.schema = {
    title: 'VesselOS Remote Access',
    type: 'object',
    properties: {
      vesselOSUrl: {
        type: 'string',
        title: 'VesselOS Backend URL',
        description: 'URL of the VesselOS backend API',
        default: 'https://api.vessel-os.com'
      }
    }
  };

  return plugin;
};
```

---

## README.md

```markdown
# signalk-vesselOS

Signal K plugin for VesselOS remote access management.

## What This Does

This plugin manages the Cloudflare tunnel that enables VesselOS
remote access from anywhere in the world. It runs on your Cerbo GX
and handles the full lifecycle of the tunnel daemon (cloudflared).

## Installation

Install via the Signal K App Store in your Signal K admin interface,
or manually:

```
cd ~/.signalk/node_modules
git clone https://github.com/createauto/signalk-vesselOS
cd signalk-vesselOS
npm install
```

Restart Signal K after installation.

## How It Works

1. After installing a VesselOS Solo subscription, the VesselOS app
   pushes a tunnel token to this plugin via the Signal K REST API.
2. The plugin downloads the cloudflared daemon to `/data/vesselOS/`
   (persistent storage that survives Venus OS firmware updates).
3. A runit service is created so the tunnel starts automatically
   on every boot.
4. The plugin recreates the runit service on every startup to handle
   the case where a firmware update wiped the service definition.

## Storage Locations

- Binary: `/data/vesselOS/cloudflared` (survives firmware updates)
- Token: `/data/vesselOS/tunnel-token` (survives firmware updates)
- Runit service: `/etc/sv/vesselOS-tunnel/` (recreated on each startup)

## REST Endpoints

The plugin exposes two endpoints via Signal K:

**POST** `/plugins/signalk-vesselOS/config`
Receives tunnel token from VesselOS backend after subscription.
Body: `{ "tunnelToken": "eyJ..." }`

**GET** `/plugins/signalk-vesselOS/status`  
Returns current tunnel status.
Response: `{ "hasToken": true, "tunnelRunning": true, "status": "active" }`

## Signal K Paths

- `electrical.vesselOS.tunnel.status` — "active" | "inactive" | "pending"
- `electrical.vesselOS.tunnel.hasToken` — boolean

## Firmware Update Resilience

Venus OS firmware updates reflash the root filesystem, which removes
runit service definitions from `/etc/sv/`. The binary and token in
`/data/` are preserved. On the next boot, Signal K starts this plugin,
which immediately recreates the runit service and starts the tunnel.
Typical recovery time after a firmware update: under 60 seconds.
```

---

## Deployment to Boatholic (Cerbo GX)

Once the plugin is built, deploy it to the Cerbo GX running at
`192.168.1.155` (or via the Cloudflare tunnel once active):

```bash
# SSH into the Cerbo GX
ssh root@192.168.1.155

# Navigate to Signal K plugin directory
cd ~/.signalk/node_modules

# Clone the plugin (or copy files)
git clone https://github.com/createauto/signalk-vesselOS
cd signalk-vesselOS
npm install

# Restart Signal K to load the plugin
systemctl restart signalk   # or via Venus OS: svc -t /service/signalk
```

Alternatively, the plugin can be installed via the Signal K App Store
once published, giving customers a one-tap install.

---

## Testing the Plugin

Once installed on the Cerbo GX, test the REST endpoints:

```bash
# Check status (no token yet)
curl http://192.168.1.155:3000/plugins/signalk-vesselOS/status

# Push a tunnel token (triggers cloudflared download and tunnel start)
curl -X POST http://192.168.1.155:3000/plugins/signalk-vesselOS/config \
  -H "Content-Type: application/json" \
  -d '{"tunnelToken":"YOUR_CLOUDFLARE_TUNNEL_TOKEN"}'

# Check status again (should show tunnelRunning: true within ~30 seconds)
curl http://192.168.1.155:3000/plugins/signalk-vesselOS/status
```

---

## End-to-End Remote Access Test Flow

Once the plugin is on Boatholic's Cerbo GX:

```
1. Frontend calls POST /v1/tunnels/boatholic/provision
   → Backend creates Cloudflare tunnel
   → Returns { tunnelToken, tunnelUrl: "wss://boatholic.vessel-os.com" }

2. Frontend pushes token to Cerbo plugin:
   POST http://192.168.1.155:3000/plugins/signalk-vesselOS/config
   { "tunnelToken": "..." }

3. Plugin downloads cloudflared to /data/vesselOS/
   Plugin creates runit service
   Plugin starts tunnel

4. Frontend polls GET /v1/tunnels/boatholic/status every 5 seconds
   Backend checks Cloudflare API → returns "active" when tunnel is up

5. Frontend shows: "Remote access confirmed ✓"
   wss://boatholic.vessel-os.com is live

6. Test from 4G (away from boat WiFi):
   Connect VesselOS dashboard to wss://boatholic.vessel-os.com
   Live vessel data confirms tunnel is working end to end
```

---

## Publishing to Signal K App Store

Once tested on Boatholic, publish to the Signal K App Store:

1. Create GitHub repo: `github.com/createauto/signalk-vesselOS`
2. Ensure `package.json` has `"keywords": ["signalk-node-server-plugin"]`
3. Submit to Signal K App Store via pull request to:
   `https://github.com/SignalK/signalk-server/blob/master/src/modules.ts`

Publishing as open source builds community trust and makes installation
one-tap from the Signal K admin interface for all customers.
