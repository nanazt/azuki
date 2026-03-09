<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# azuki-db

## Purpose
Database layer for SQLite via sqlx. Provides connection pool, migrations, models, queries, and app config CRUD.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | DB dependencies (sqlx, serde, chrono) |
| `src/lib.rs` | `create_pool()`, `run_migrations()`, `DbError`/`DbResult` types |
| `src/config.rs` | App config CRUD: `load_config`, `save_config`, `is_configured`, `REQUIRED_KEYS` |
| `src/models.rs` | Data models (User, Track, PlayHistory, LyricsCache, UserPreferences, QueueItem) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/queries/` | SQL query modules per entity (see below) |

### src/queries/

| File | Description |
|------|-------------|
| `mod.rs` | Re-exports all query modules |
| `users.rs` | User upsert, lookup, admin role management |
| `tracks.rs` | Track insert, lookup, search, stats aggregation |
| `history.rs` | Play history recording, retrieval, listened_ms tracking |
| `preferences.rs` | User preferences CRUD (theme, locale, volume) |
| `queue.rs` | Queue persistence: save/load queue state to DB |

## For AI Agents

### Working In This Directory
- `SQLX_OFFLINE=true` required for cargo check (no live DB during CI)
- TEXT NOT NULL columns need `as "col!"` suffix in sqlx queries
- COUNT queries need `as "count!: i64"`
- `"col?"` / `"col!"` suffixes are for `query!`/`query_as!` macros only — do NOT use with non-macro `query_as::<_, T>()`
- `create_pool()` sets file permissions 0600 on Unix for secret protection
- `config::REQUIRED_KEYS` defines the 6 mandatory config entries

<!-- MANUAL: -->
