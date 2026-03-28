const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// /data/ persists across Venus OS firmware updates
// NOTE: /data/vesselOS/ must be created manually as root before first use:
//   mkdir -p /data/vesselOS && chmod 777 /data/vesselOS
const INSTALL_DIR = '/data/vesselOS';
const BINARY_PATH = path.join(INSTALL_DIR, 'cloudflared');
const TOKEN_PATH = path.join(INSTALL_DIR, 'tunnel-token');

// Venus OS uses /service/ for runit services (not /etc/sv/)
const RUNIT_DIR = '/service/vesselOS-tunnel';
const RUNIT_LOG_DIR = '/service/vesselOS-tunnel/log';

function getArchitecture() {
  try {
    const arch = execSync('uname -m').toString().trim();
    if (arch === 'aarch64') return 'arm64';
    if (arch.startsWith('arm')) return 'arm';
    if (arch === 'x86_64') return 'amd64';
    return 'arm';
  } catch {
    return 'arm';
  }
}

function getDownloadUrl() {
  const arch = getArchitecture();
  const version = '2024.2.1';
  return `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-${arch}`;
}

async function downloadBinary(log) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(INSTALL_DIR)) {
      try {
        fs.mkdirSync(INSTALL_DIR, { recursive: true });
      } catch (err) {
        log(`Warning: could not create ${INSTALL_DIR}: ${err.message}`);
        log('Run as root: mkdir -p /data/vesselOS && chmod 777 /data/vesselOS');
      }
    }

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
      https.get(
        { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search },
        (res) => {
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
        }
      ).on('error', (err) => {
        if (fs.existsSync(BINARY_PATH)) {
          fs.unlinkSync(BINARY_PATH);
        }
        reject(err);
      });
    };

    download(url);
  });
}

function createRunitService(log) {
  log('Creating/recreating runit service definition');

  if (!fs.existsSync(RUNIT_DIR)) {
    fs.mkdirSync(RUNIT_DIR, { recursive: true });
  }
  if (!fs.existsSync(RUNIT_LOG_DIR)) {
    fs.mkdirSync(RUNIT_LOG_DIR, { recursive: true });
  }

  if (!fs.existsSync(TOKEN_PATH)) {
    log('No tunnel token stored — skipping runit service creation');
    return false;
  }

  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();

  const runScript = `#!/bin/sh
exec ${BINARY_PATH} tunnel --no-autoupdate run --token ${token} 2>&1
`;
  fs.writeFileSync(path.join(RUNIT_DIR, 'run'), runScript);
  fs.chmodSync(path.join(RUNIT_DIR, 'run'), '755');

  const logScript = `#!/bin/sh
exec svlogd -tt /var/log/vesselOS-tunnel
`;
  fs.writeFileSync(path.join(RUNIT_LOG_DIR, 'run'), logScript);
  fs.chmodSync(path.join(RUNIT_LOG_DIR, 'run'), '755');

  log('Runit service created at ' + RUNIT_DIR);
  return true;
}

function startTunnel(log) {
  try {
    try {
      execSync('sv start vesselOS-tunnel', { stdio: 'pipe' });
      log('Tunnel started via sv');
    } catch {
      log('sv start attempted (may already be running)');
    }

    return true;
  } catch (err) {
    log('Error starting tunnel: ' + err.message);
    return false;
  }
}

function stopTunnel(log) {
  try {
    execSync('sv stop vesselOS-tunnel', { stdio: 'pipe' });
    log('Tunnel stopped');
  } catch {
  }
}

function isTunnelRunning() {
  try {
    const result = execSync(
      'sv status vesselOS-tunnel 2>/dev/null || echo "down"',
      { stdio: 'pipe' }
    )
      .toString()
      .trim();
    return result.startsWith('run:');
  } catch {
    return false;
  }
}

function storeToken(token, log) {
  // /data/vesselOS/ must already exist (created as root before first use)
  // Signal K runs as a non-root user and cannot create /data/ subdirectories
  if (!fs.existsSync(INSTALL_DIR)) {
    try {
      fs.mkdirSync(INSTALL_DIR, { recursive: true });
    } catch (err) {
      log(`Warning: could not create ${INSTALL_DIR}: ${err.message}`);
      log('Run as root: mkdir -p /data/vesselOS && chmod 777 /data/vesselOS');
      // Do not throw — attempt to write token anyway in case dir appears later
    }
  }
  fs.writeFileSync(TOKEN_PATH, token, 'utf8');
  fs.chmodSync(TOKEN_PATH, '600');
  log('Tunnel token stored to ' + TOKEN_PATH);
}

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
