<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# azuki-db

## Purpose
Database layer for SQLite via sqlx. Provides connection pool, migrations, models, queries, and app config CRUD.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | DB dependencies (sqlx, serde, chrono) |
| `src/lib.rs` | `create_pool()`, `run_migrations()`, `DbError`/`DbResult` types |
| `src/config.rs` | App config CRUD: `load_config`, `save_config`, `is_configured`, `REQUIRED_KEYS` |
| `src/models.rs` | Data models (User, Track, PlayHistory, Playlist, Favorite, LyricsCache) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/queries/` | SQL query modules per entity (see below) |

### src/queries/

| File | Description |
|------|-------------|
| `mod.rs` | Re-exports all query modules |
| `users.rs` | User upsert and lookup |
| `tracks.rs` | Track insert, lookup, search |
| `history.rs` | Play history recording and retrieval |
| `playlists.rs` | Playlist CRUD and track management |
| `favorites.rs` | Favorite toggle and listing |
| `lyrics.rs` | Lyrics cache read/write |

## For AI Agents

### Working In This Directory
- `SQLX_OFFLINE=true` required for cargo check (no live DB during CI)
- TEXT NOT NULL columns need `as "col!"` suffix in sqlx queries
- COUNT queries need `as "count!: i64"`
- `create_pool()` sets file permissions 0600 on Unix for secret protection
- `config::REQUIRED_KEYS` defines the 6 mandatory config entries

<!-- MANUAL: -->
