<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-10 | Updated: 2026-03-10 -->

# locales

## Purpose

i18n translation files for the frontend. Korean (default) and English, using plain TypeScript constant objects (no framework).

## Key Files

| File       | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `ko.ts`    | Korean translations — source-of-truth, defines `Translations` type |
| `en.ts`    | English translations — must satisfy `Translations` type            |
| `index.ts` | Barrel export, locale registry, type re-exports                    |

## For AI Agents

### Working In This Directory

- Korean (`ko.ts`) is the source of truth — add new keys here first
- `en.ts` must satisfy the `Translations` type from `ko.ts` — missing keys cause tsc compile errors
- Access via `useLocale` hook: `const s = t(); s.nav.home`
- Never cache `t()` at module scope — it must be called inside components/hooks
- localStorage key: `azuki-locale`

<!-- MANUAL: -->
