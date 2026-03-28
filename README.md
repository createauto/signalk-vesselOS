# signalk-vesselOS

Signal K plugin for VesselOS remote access management.

## What This Does

This plugin manages the Cloudflare tunnel that enables VesselOS
remote access from anywhere in the world. It runs on your Cerbo GX
and handles the full lifecycle of the tunnel daemon (cloudflared).

## Installation

Install via the Signal K App Store in your Signal K admin interface,
or manually:

```bash
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

| Path | Purpose | Survives firmware update? |
|------|---------|--------------------------|
| `/data/vesselOS/cloudflared` | Binary | Yes |
| `/data/vesselOS/tunnel-token` | Tunnel token | Yes |
| `/etc/sv/vesselOS-tunnel/` | Runit service definition | No — recreated on each startup |

## REST Endpoints

**POST** `/plugins/signalk-vesselOS/config`

Receives tunnel token from VesselOS backend after subscription.

```json
{ "tunnelToken": "eyJ..." }
```

Response:
```json
{ "success": true, "message": "Token received — tunnel starting in background" }
```

---

**GET** `/plugins/signalk-vesselOS/status`

Returns current tunnel status.

```json
{ "hasToken": true, "tunnelRunning": true, "status": "active" }
```

Status values:
- `"active"` — tunnel is running
- `"starting"` — token received but tunnel not yet confirmed running
- `"pending"` — no token stored yet

## Signal K Paths

| Path | Type | Description |
|------|------|-------------|
| `electrical.vesselOS.tunnel.status` | string | `"active"` \| `"inactive"` \| `"pending"` |
| `electrical.vesselOS.tunnel.hasToken` | boolean | Whether a tunnel token is stored |

## Firmware Update Resilience

Venus OS firmware updates reflash the root filesystem, which removes
runit service definitions from `/etc/sv/`. The binary and token in
`/data/` are preserved. On the next boot, Signal K starts this plugin,
which immediately recreates the runit service and restarts the tunnel.

Typical recovery time after a firmware update: under 60 seconds.

## Testing

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

## End-to-End Remote Access Test Flow

```
1. Frontend calls POST /v1/tunnels/<vessel>/provision
   → Backend creates Cloudflare tunnel
   → Returns { tunnelToken, tunnelUrl: "wss://<vessel>.vessel-os.com" }

2. Frontend pushes token to Cerbo plugin:
   POST http://192.168.1.155:3000/plugins/signalk-vesselOS/config
   { "tunnelToken": "..." }

3. Plugin downloads cloudflared to /data/vesselOS/
   Plugin creates runit service
   Plugin starts tunnel

4. Frontend polls GET /v1/tunnels/<vessel>/status every 5 seconds
   Backend checks Cloudflare API → returns "active" when tunnel is up

5. Frontend shows: "Remote access confirmed"
   wss://<vessel>.vessel-os.com is live
```

## Publishing to Signal K App Store

Once tested, publish to the Signal K App Store:

1. Create GitHub repo: `github.com/createauto/signalk-vesselOS`
2. Ensure `package.json` has `"keywords": ["signalk-node-server-plugin"]`
3. Submit to Signal K App Store via pull request to:
   `https://github.com/SignalK/signalk-server/blob/master/src/modules.ts`

Publishing as open source builds community trust and makes installation
one-tap from the Signal K admin interface for all customers.

## License

Apache-2.0
