<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# azuki

## Purpose

Discord music bot with web dashboard. Rust workspace backend (6 crates) + React frontend. Supports YouTube playback, queue management, playlists, favorites, lyrics, and real-time WebSocket sync.

## Key Files

| File         | Description                                        |
| ------------ | -------------------------------------------------- |
| `Cargo.toml` | Workspace manifest with all dependency versions    |
| `.gitignore` | Ignore rules for Rust, Node, OS, and project files |

## Subdirectories

| Directory     | Purpose                                             |
| ------------- | --------------------------------------------------- |
| `crates/`     | Rust workspace crates (see `crates/AGENTS.md`)      |
| `frontend/`   | React SPA web dashboard (see `frontend/AGENTS.md`)  |
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
- Frontend: `cd frontend && npx tsc --noEmit && npm run build` (type-check first, then build)

### Architecture Overview

- Dependency flow: azuki-db → azuki-player, azuki-media → azuki-bot, azuki-web → azuki (binary)
- PlayerController uses actor pattern with mpsc command channel
- Web uses axum + cookie-based JWT auth + WebSocket hub
- songbird DAVE fork: `beerpsi-forks/songbird` branch `davey`
- Config stored in SQLite `app_config` table (DB-based, not .env)
- Setup wizard runs on first launch if no config exists

### i18n (Localization)

- **Supported locales**: `"ko"` (default) and `"en"` only. Always validate with allowlist.
- **No frameworks** — pure TS/Rust constant objects. No react-i18next, no rust-i18n.
- **Korean is the source of truth**: Write Korean strings first, then translate to English. Key structure and wording are designed around Korean.

**Frontend:**
- Translation files: `frontend/src/locales/ko.ts` (source-of-truth type), `en.ts`, `index.ts`
- Hook: `frontend/src/hooks/useLocale.ts` — exports `useLocale()`, `setLocale()`, `t()`
- Usage in components: `const s = t();` then `s.nav.home`. Never cache `t()` at module scope.
- Storage: localStorage `azuki-locale` for instant init, background sync with `GET /api/preferences`
- Adding strings: add key to `ko.ts` + `en.ts` (missing key = tsc compile error via `Translations` type)

**Backend (bot):**
- Bot messages: `crates/azuki-bot/src/messages.rs` — `Messages` struct, `KO`/`EN` statics, `get(&AtomicU8)`
- Bot locale: `Arc<AtomicU8>` shared between `BotState` and `WebState` (0=ko, 1=en)
- Admin API: `GET/PUT /api/admin/bot-locale` (server-wide bot language)

**User locale:**
- DB: `user_preferences.locale` column (`CHECK (locale IN ('ko', 'en'))`)
- API: `GET/PUT /api/preferences` includes `locale` field
- Backend validation: `matches!(locale, "ko" | "en")` in preferences.rs

<!-- MANUAL: -->
