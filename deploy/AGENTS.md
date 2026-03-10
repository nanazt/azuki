<!-- Generated: 2026-03-10 -->

# deploy/

## Purpose

Deployment configuration for AWS Lightsail. nginx reverse proxy + Cloudflare SSL + UFW firewall setup.

## Key Files

| File                                  | Description                                          |
| ------------------------------------- | ---------------------------------------------------- |
| `setup.sh`                            | Idempotent deploy script (`sudo ./setup.sh <domain>`) |
| `update.sh`                           | Quick image update (`sudo ./update.sh <domain>`)     |
| `nginx/nginx.conf`                    | Main nginx config (gzip, rate limiting, proxy)       |
| `nginx/conf.d/azuki.conf`            | Server blocks (HTTPS, WebSocket, upload, SPA)        |
| `nginx/snippets/cloudflare-realip.conf` | Cloudflare IP ranges for real IP restoration        |
| `nginx/update-cloudflare-ips.sh`     | Daily cron job for Cloudflare IP refresh             |

## For AI Agents

### Working In This Directory

- Docker images are pulled from ghcr.io (no local build)
- Initial deploy: `sudo ./setup.sh <domain>` (nginx, UFW, SSL, Docker — full setup)
- Image update only: `sudo ./update.sh <domain>` (pull + restart)
- ghcr.io auth: `docker login ghcr.io` required once (PAT with `read:packages` scope)
- `AZUKI_DOMAIN` in `azuki.conf` is a placeholder replaced by `setup.sh` at deploy time
- `cloudflare-realip.conf` is a fallback — `setup.sh` fetches fresh IPs on deploy
- nginx configs use `conf.d/` only (no `sites-enabled/`)
- Security headers (CSP, X-Frame-Options) are set by axum, not nginx
- Upload limit is 100MB (Cloudflare Free plan constraint)
- Docker port is localhost-only (`127.0.0.1:3000`) — nginx is the sole entry point

### Architecture

```
Internet → Cloudflare (edge SSL) → Lightsail UFW (Cloudflare IPs only)
  → nginx (Origin SSL, reverse proxy) → Docker 127.0.0.1:3000 (azuki)
```

### Origin Protection Layers

1. Lightsail firewall: ports 22/80/443 only
2. UFW: 80/443 restricted to Cloudflare IP ranges (IPv4+IPv6)
3. nginx `default_server` returns 444 for unknown Host headers
4. Docker binds to localhost only
