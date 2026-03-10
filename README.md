# azuki

A Discord music bot with a web dashboard.

## Features

- Music playback via YouTube search, direct URLs, and file upload
- Web dashboard with drag-and-drop queue management
- Real-time sync between Discord and web via WebSocket
- Discord OAuth2 login with guild membership verification
- i18n support (Korean default + English)
- Dark/light theme

## Development

### Prerequisites

- Rust (edition 2024)
- Node.js
- libopus — `brew install opus pkg-config`
- [just](https://github.com/casey/just)

### Setup

The justfile uses `set dotenv-load`. Create a `.env` in the project root:

```
WEB_ORIGIN=http://localhost:3000
```

### Commands

| Command | Description |
| --- | --- |
| `just run` | Build frontend + cargo run |
| `just frontend-dev` | Vite dev server (hot reload) |
| `just check` | Clippy with SQLX_OFFLINE |
| `just test` | Run workspace tests |

### First Run

On first launch, a setup wizard opens at http://127.0.0.1:3000. Enter your Discord bot token, OAuth2 credentials, JWT secret, and optionally a YouTube API key through the wizard. All credentials are stored in SQLite — no environment variables needed.

## Deployment

### Architecture

```
Internet → Cloudflare (SSL, DDoS) → UFW (Cloudflare IPs only) → nginx (Origin SSL) → Docker (localhost:3000)
```

### Prerequisites

1. AWS Lightsail instance (Ubuntu, 2 vCPU / 1 GB RAM+)
2. Docker + Docker Compose
3. nginx
4. Domain with Cloudflare DNS (A record → server IP, SSL mode: Full Strict)
5. Cloudflare Origin Certificate placed at `/etc/nginx/ssl/origin.pem` and `/etc/nginx/ssl/origin-key.pem`

### Setup

```bash
git clone <repo> /opt/azuki-repo && cd /opt/azuki-repo
sudo ./deploy/setup.sh <domain>
```

Then open `https://<domain>` to complete the setup wizard (Discord bot token, OAuth credentials, JWT secret, optional YouTube API key).

### Updating

```bash
sudo ./deploy/update.sh <domain>
```

## Environment Variables

Infrastructure-only — all Discord/OAuth credentials are configured through the web setup wizard.

These are docker-compose defaults. Local dev defaults may differ.

| Variable | Default | Description |
| --- | --- | --- |
| `WEB_ORIGIN` | `http://localhost:3000` | Public URL (set by deploy scripts) |
| `MAX_UPLOAD_SIZE_MB` | `100` | Max file upload size |
| `MAX_CACHE_SIZE_GB` | `30` | Media cache size limit |
| `RUST_LOG` | `azuki=info,...` | Log level filter |
