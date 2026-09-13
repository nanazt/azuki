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
- [mise](https://mise.jdx.dev/)

### Setup

After reviewing the repository configuration, trust it to enable mise tasks:

```bash
mise trust
```

Tasks use the Rust and Node.js installations already available on `PATH`; toolchain provisioning and Docker versions are unchanged.
An optional `.env` in the project root supplies development environment variables:

```
WEB_ORIGIN=http://localhost:3000
```

Unlike the previous just tasks, mise lets `.env` values override already-exported shell variables with the same name.
Task-specific settings still take precedence, including `SQLX_OFFLINE=true` for `check` and `test`.

### Commands

| Command | Description |
| --- | --- |
| `mise run dev` | Build frontend + cargo run |
| `mise run build` | Build frontend + cargo build |
| `mise run cargo-run` | Cargo run without rebuilding the frontend |
| `mise run frontend-dev` | Vite dev server (hot reload) |
| `mise run check` | Clippy with SQLX_OFFLINE |
| `mise run test` | Run workspace tests |

`default` aliases `dev`.
Pass Cargo arguments after the task name, for example `mise run test -- -p azuki-web`.

### Releases

The project [release skill](.agents/skills/release/SKILL.md) guides version selection, English release notes, two approval checkpoints, and publication.
Start OMP in this repository and invoke `/skill:release`, optionally followed by a version.
Writing or reviewing the skill does not authorize a release.

GitHub CLI calls use a task-local token from the stored `nanazt` account:

```bash
mise run gh-nanazt -- api user --jq .login
```

GitHub CLI must already have credentials stored for `nanazt` on `github.com`.
The task retrieves the token at execution time without storing it in project configuration or exporting it to unrelated tasks.
Git pushes use the remote's own transport credentials; `GH_TOKEN` does not select an SSH account.

Pushing a `v*` tag intentionally builds and publishes the GHCR image, including `latest`.
This does not deploy the running server.

### First Run

On first launch, a setup wizard opens at http://127.0.0.1:3000. Enter your Discord bot token, OAuth2 credentials, JWT secret, and optionally a YouTube API key through the wizard. All credentials are stored in SQLite — no environment variables needed.

## Deployment

### Prerequisites

1. Docker + Docker Compose
2. Reverse proxy (nginx, Caddy, etc.) — configured separately

### Setup

```bash
git clone https://github.com/nanazt/azuki.git  && cd azuki

# Create host directories for volume mounts
# The container runs as UID 10001 — directories must be writable by that user
sudo mkdir -p /opt/azuki/data /opt/azuki/media
sudo chown 10001:10001 /opt/azuki/data /opt/azuki/media

cp .env.example .env
# Edit .env — set WEB_ORIGIN to your public URL
docker compose up -d
```

Then open your configured URL to complete the setup wizard (Discord bot token, OAuth credentials, JWT secret, optional YouTube API key).

### Updating

```bash
docker compose pull
docker compose stop --timeout 30
docker compose up -d --pull never
```

Stop the old container before starting its replacement; overlapping a server that uses the previous authentication contract is unsupported.

### Login persistence

Browser logins expire after seven days without a successful renewal and never last longer than 90 days from the original Discord sign-in.
A visible dashboard renews automatically every five minutes and when it becomes visible or comes back online; hidden-tab traffic does not renew the login.
Logging out revokes that account's login in every browser and device, including existing WebSocket connections.

When upgrading from the previous login format, existing dashboard tabs must be reloaded and users must sign in with Discord once.
Do not roll back to a binary that lacks the new session-lifetime and WebSocket-revocation checks; rollback builds must preserve the same authentication policy.
The [authentication specification](docs/specs/persistent-login.md) documents the API and transition contract.

## Environment Variables

Infrastructure-only — all Discord/OAuth credentials are configured through the web setup wizard.

See `.env.example` for a template. These are docker-compose defaults; local dev defaults may differ.

| Variable             | Default                 | Description                        |
| -------------------- | ----------------------- | ---------------------------------- |
| `WEB_ORIGIN`         | `http://localhost:3000` | Public URL (set by deploy scripts) |
| `MAX_UPLOAD_SIZE_MB` | `100`                   | Max file upload size               |
| `MAX_CACHE_SIZE_GB`  | `30`                    | Media cache size limit             |
| `RUST_LOG`           | `azuki=info,...`        | Log level filter                   |
