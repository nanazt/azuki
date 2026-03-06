<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# migrations

## Purpose
SQLite database migration files managed by sqlx. Applied automatically at startup.

## Key Files

| File | Description |
|------|-------------|
| `001_initial.sql` | Core schema: users, tracks, play_history, playlists, playlist_tracks, favorites, lyrics_cache |
| `002_app_config.sql` | App configuration KV table for setup wizard |

## For AI Agents

### Working In This Directory
- Migrations are numbered sequentially (`NNN_name.sql`)
- Applied via `sqlx::migrate!("../../migrations")` in `azuki-db`
- After adding a migration, run `SQLX_OFFLINE=true cargo check --workspace` to verify
- Never modify existing migrations — create new ones for schema changes
- TEXT NOT NULL columns require `as "col!"` suffix in sqlx query macros

<!-- MANUAL: -->
