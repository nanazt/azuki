<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# azuki-bot

## Purpose
Discord bot integration using serenity. Handles slash commands, voice channel operations, and event handling.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Bot dependencies (serenity, songbird) |
| `src/lib.rs` | `BotState` struct, `start_bot()` function |
| `src/handler.rs` | Serenity `EventHandler` impl, guild command registration |
| `src/commands.rs` | All 12 slash commands (play, skip, pause, resume, stop, queue, etc.) |
| `src/voice.rs` | Songbird voice channel join/leave/play operations |

## For AI Agents

### Working In This Directory
- `BotState` holds player, ytdlp (Arc<YtDlp>), db pool, guild_id, songbird mutex
- serenity `CacheRef` is `!Send` — extract voice channel info BEFORE any `.await`
- songbird uses DAVE fork: `beerpsi-forks/songbird` branch `davey`
- YtDlp doesn't impl Clone — wrapped in `Arc<YtDlp>`

<!-- MANUAL: -->
