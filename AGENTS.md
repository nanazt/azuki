<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# azuki

## Purpose

Discord music bot with web dashboard. Rust workspace backend (6 crates) + React frontend. Supports YouTube playback, queue management, file uploads, and real-time WebSocket sync. Bilingual UI (Korean/English).

## Key Files

| File         | Description                                        |
| ------------ | -------------------------------------------------- |
| `Cargo.toml` | Workspace manifest with all dependency versions    |
| `justfile`   | Task runner commands (dev, build, check, test)     |
| `.gitignore` | Ignore rules for Rust, Node, OS, and project files |

## Subdirectories

| Directory     | Purpose                                             |
| ------------- | --------------------------------------------------- |
| `crates/`     | Rust workspace crates (see `crates/AGENTS.md`)      |
| `frontend/`   | React SPA web dashboard (see `frontend/AGENTS.md`)  |
| `migrations/` | SQLite migration files (see `migrations/AGENTS.md`) |
| `deploy/`     | nginx config + deployment scripts for Lightsail      |

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
- `SQLX_OFFLINE=true cargo test --workspace` — all tests must pass
- Frontend: `cd frontend && npx tsc --noEmit && npm run build` (type-check first, then build)

### API Integration Testing

- API tests live in `crates/azuki-web/tests/` — test HTTP contracts + DB side effects, NOT player logic
- Use `tower::ServiceExt::oneshot` pattern — no live servers, tests hit the Router directly
- Each test creates a fresh in-memory SQLite via `TestApp::new()` — parallel-safe, no `#[serial]` needed
- Auth: `azuki_web::auth::create_jwt()` for JWT cookies, `azuki_db::queries::users::upsert_user()` for seeding users
- Test negative paths (401/403/400) for each endpoint category
- Admin endpoints: test non-admin 403 for EVERY admin endpoint individually (prevent privilege escalation regression)
- Success responses: assert response body shape, not just status code
- WebSocket: `WebSocketUpgrade` extractor requires real upgradeable connections, so oneshot can only verify non-WS requests are rejected

### Architecture Overview

- Dependency flow: azuki-db → azuki-player, azuki-media → azuki-bot, azuki-web → azuki (binary)
- PlayerController uses actor pattern with mpsc command channel (actor.rs separated from controller.rs)
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
