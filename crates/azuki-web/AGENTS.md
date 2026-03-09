<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# azuki-web

## Purpose
Axum web server providing REST API, Discord OAuth2 authentication, WebSocket hub for real-time player sync, and admin endpoints.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Web dependencies (axum, tower-http, jsonwebtoken, reqwest) |
| `src/lib.rs` | `WebState` struct, `ApiError`, `start_web()` function |
| `src/auth.rs` | Discord OAuth2 flow + JWT cookie-based sessions |
| `src/ws.rs` | WebSocket hub for broadcasting player events |
| `src/events.rs` | Server-sent event types shared between WS and routes |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/routes/` | API route handlers (see below) |
| `tests/` | Integration tests (81 tests, tower::oneshot pattern) |

### src/routes/

| File | Description |
|------|-------------|
| `mod.rs` | Router assembly, route registration |
| `player.rs` | Player control endpoints (play, pause, skip, seek, volume, loop mode) |
| `content.rs` | Track search, YouTube resolve, file upload |
| `queues.rs` | Queue management endpoints (add, remove, reorder, clear) |
| `stats.rs` | Play statistics, charts, top tracks/artists |
| `preferences.rs` | User preferences CRUD (theme, locale, volume) |
| `admin.rs` | Admin endpoints: bot-locale, user management, app config |

## For AI Agents

### Working In This Directory
- `WebState` is passed as axum `State` — contains all shared resources
- Auth uses cookie-based JWT (not Bearer header)
- CORS configured via `allowed_origins` in WebState
- Static files served via `STATIC_DIR` env var (tower-http ServeDir + SPA fallback)
- WebSocket connects at `/ws` for real-time player state sync
- `azuki_web` has no dependency on `azuki_bot` — locale↔u8 conversion is inline in admin.rs
- Admin endpoints require `is_admin` flag on User model

<!-- MANUAL: -->
