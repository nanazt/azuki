<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# azuki-web

## Purpose
Axum web server providing REST API, Discord OAuth2 authentication, and WebSocket hub for real-time player sync.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Web dependencies (axum, tower-http, jsonwebtoken, reqwest) |
| `src/lib.rs` | `WebState` struct, `ApiError`, `start_web()` function |
| `src/auth.rs` | Discord OAuth2 flow + JWT cookie-based sessions |
| `src/ws.rs` | WebSocket hub for broadcasting player events |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/routes/` | API route handlers (see below) |

### src/routes/

| File | Description |
|------|-------------|
| `mod.rs` | Router assembly, route registration |
| `player.rs` | Player control endpoints (play, pause, skip, seek, volume) |
| `content.rs` | Track search, YouTube resolve, file upload |
| `playlists.rs` | Playlist CRUD endpoints |
| `favorites.rs` | Favorite toggle and listing |
| `stats.rs` | Play statistics and charts |

## For AI Agents

### Working In This Directory
- `WebState` is passed as axum `State` — contains all shared resources
- Auth uses cookie-based JWT (not Bearer header)
- CORS configured via `allowed_origins` in WebState
- Static files served via `STATIC_DIR` env var (tower-http ServeDir + SPA fallback)
- WebSocket connects at `/ws` for real-time player state sync

<!-- MANUAL: -->
