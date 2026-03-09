<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# azuki-bot

## Purpose
Discord bot integration using serenity. Handles slash commands, voice channel operations, event handling, and bilingual bot messages (i18n).

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Bot dependencies (serenity, songbird) |
| `src/lib.rs` | `BotState` struct (with `locale: Arc<AtomicU8>`), `start_bot()` function |
| `src/handler.rs` | Serenity `EventHandler` impl, guild command registration |
| `src/commands.rs` | All 12 slash commands (play, skip, pause, resume, stop, queue, etc.) |
| `src/voice.rs` | Songbird voice channel join/leave/play operations |
| `src/embed.rs` | Discord embed builders for track info display |
| `src/messages.rs` | i18n bot message constants — `Messages` struct, `KO`/`EN` statics, `get(&AtomicU8)` |

## For AI Agents

### Working In This Directory
- `BotState` holds player, ytdlp (Arc<YtDlp>), db pool, guild_id, songbird mutex, locale
- serenity `CacheRef` is `!Send` — extract voice channel info BEFORE any `.await`
- songbird uses DAVE fork: `beerpsi-forks/songbird` branch `davey`
- YtDlp doesn't impl Clone — wrapped in `Arc<YtDlp>`
- Bot locale: `Arc<AtomicU8>` shared with `WebState` (0=ko, 1=en), changed via admin API
- `messages::Messages::get(&AtomicU8)` returns `&'static Messages` for current locale
- `embed.rs` builds rich embeds for now-playing, queue display, etc.

<!-- MANUAL: -->
