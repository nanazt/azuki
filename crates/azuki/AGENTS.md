<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# azuki

## Purpose
Binary crate — application entry point. Handles startup wiring, DB-based config loading, setup wizard, and service orchestration.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Binary dependencies |
| `src/main.rs` | Entry point: DB init, config load, setup/normal branch, service spawning |
| `src/setup.rs` | Zero-config setup wizard: inline HTML form, token auth, DB config save, hot reload |

## For AI Agents

### Working In This Directory
- `Config::load(pool)` reads required keys from `app_config` DB table, optional values from env vars
- `run_normal()` contains all service startup logic (bot, web, media, player, cache cleanup)
- `setup::run_setup()` starts a temporary axum server on 127.0.0.1 with one-time token auth
- Setup wizard uses inline HTML (no React/npm dependency)
- `from_env()` was removed — all required config comes from DB

### Startup Flow
```
main() → DB connect → migrations → is_configured()?
  → yes: Config::load() → run_normal()
  → no:  setup wizard → Config saved to DB → run_normal()
```

<!-- MANUAL: -->
