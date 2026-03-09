<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# crates

## Purpose
Rust workspace containing 6 crates that form the azuki Discord music bot backend.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `azuki/` | Binary entry point — startup, config loading, setup wizard (see `azuki/AGENTS.md`) |
| `azuki-bot/` | Discord bot — serenity EventHandler, slash commands, voice, i18n messages (see `azuki-bot/AGENTS.md`) |
| `azuki-db/` | Database layer — SQLite via sqlx, models, queries, config (see `azuki-db/AGENTS.md`) |
| `azuki-media/` | Media services — yt-dlp, YouTube resolver, file store, metadata, uploads (see `azuki-media/AGENTS.md`) |
| `azuki-player/` | Playback engine — actor-pattern controller (actor.rs), queue, WebSocket events (see `azuki-player/AGENTS.md`) |
| `azuki-web/` | Web server — axum REST API, Discord OAuth, WebSocket hub, admin (see `azuki-web/AGENTS.md`) |

## For AI Agents

### Dependency Flow
```
azuki-db → azuki-player, azuki-media → azuki-bot, azuki-web → azuki (binary)
```
Changes to lower crates affect all dependents. Edit `azuki-db` with care.

### Working In This Directory
- Each crate has its own `Cargo.toml` referencing workspace dependencies
- Shared deps are defined in root `Cargo.toml` `[workspace.dependencies]`

<!-- MANUAL: -->
