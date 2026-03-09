<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# migrations

## Purpose
SQLite database migration files managed by sqlx. Applied automatically at startup.

## Key Files

| File | Description |
|------|-------------|
| `001_initial.sql` | Core schema: users, tracks, play_history, playlists, playlist_tracks, favorites, lyrics_cache |
| `002_app_config.sql` | App configuration KV table for setup wizard |
| `003_user_preferences.sql` | User preferences table (theme, volume) |
| `004_volume_refactor.sql` | Volume column refactoring |
| `005_dedup_play_history.sql` | Deduplicate play history entries |
| `006_queue_persistence.sql` | Queue state persistence table |
| `007_history_embed.sql` | Add embed metadata to history |
| `008_upload_ownership.sql` | Track upload ownership |
| `009_admin_role.sql` | Admin role flag on users |
| `010_drop_favorites.sql` | Drop favorites table |
| `011_listened_ms.sql` | Add listened_ms column to history |
| `012_backfill_listened_ms.sql` | Backfill listened_ms data |
| `013_played_at_index.sql` | Index on played_at for performance |
| `014_theme_modes.sql` | Theme mode preferences |
| `015_multi_queue_playlists.sql` | Multi-queue and playlist support |
| `016_drop_playlists.sql` | Drop playlists tables |
| `017_user_locale.sql` | User locale preference column |

## For AI Agents

### Working In This Directory
- Migrations are numbered sequentially (`NNN_name.sql`)
- Applied via `sqlx::migrate!("../../migrations")` in `azuki-db`
- After adding a migration, run `SQLX_OFFLINE=true cargo check --workspace` to verify
- **Never modify or delete existing migrations** — sqlx validates checksums. Create new ones for schema changes.
- `sqlx::migrate!` is a compile-time macro — run `cargo clean -p azuki-db` after migration file changes
- TEXT NOT NULL columns require `as "col!"` suffix in sqlx query macros

<!-- MANUAL: -->
