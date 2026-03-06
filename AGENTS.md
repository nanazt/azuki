<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# azuki

## Purpose
Discord music bot with web dashboard. Rust workspace backend (6 crates) + React frontend. Supports YouTube playback, queue management, playlists, favorites, lyrics, and real-time WebSocket sync.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Workspace manifest with all dependency versions |
| `.gitignore` | Ignore rules for Rust, Node, OS, and project files |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `crates/` | Rust workspace crates (see `crates/AGENTS.md`) |
| `frontend/` | React SPA web dashboard (see `frontend/AGENTS.md`) |
| `migrations/` | SQLite migration files (see `migrations/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Workspace-level `Cargo.toml` defines all shared dependencies — add new deps here first
- Build check: `SQLX_OFFLINE=true cargo clippy --workspace --all-targets -- -D warnings`
- Edition 2024, resolver 3
- All TEXT NOT NULL columns need `as "col!"` suffix in sqlx queries
- COUNT queries need `as "count!: i64"` and `ORDER BY 4 DESC` (not `ORDER BY count`)
- System libopus required: `brew install opus pkg-config`

### Testing Requirements
- `SQLX_OFFLINE=true cargo clippy --workspace --all-targets -- -D warnings` must pass clean
- Frontend: `cd frontend && npm run build`

### Architecture Overview
- Dependency flow: azuki-db → azuki-player, azuki-media → azuki-bot, azuki-web → azuki (binary)
- PlayerController uses actor pattern with mpsc command channel
- Web uses axum + cookie-based JWT auth + WebSocket hub
- songbird DAVE fork: `beerpsi-forks/songbird` branch `davey`
- Config stored in SQLite `app_config` table (DB-based, not .env)
- Setup wizard runs on first launch if no config exists

<!-- MANUAL: -->
