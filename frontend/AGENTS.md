<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# frontend

## Purpose

React SPA web dashboard for azuki. Spotify-style player UI with queue, search, file uploads, stats, and bilingual support (Korean/English).

## Key Files

| File                 | Description                                         |
| -------------------- | --------------------------------------------------- |
| `package.json`       | Dependencies and scripts                            |
| `vite.config.ts`     | Vite config with dev proxy to backend               |
| `tsconfig.json`      | TypeScript configuration                            |
| `index.html`         | SPA entry HTML                                      |
| `DESIGN_SYSTEM.md`   | Design system reference — colors, spacing, patterns |

## Subdirectories

| Directory | Purpose                                  |
| --------- | ---------------------------------------- |
| `public/` | Static assets                            |
| `src/`    | Application source (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Stack: React 19 + Vite 7 + TypeScript + Tailwind CSS v4 + Zustand + lucide-react + clsx
- Build: `npm run build` → `dist/`
- Dev: `npm run dev` (proxies /api, /auth, /ws to localhost:3000)
- React 19: `useRef` requires initial value (e.g., `useRef<T>(null)`)
- Color theme: CSS custom properties in `src/index.css` (@theme block)
- SPA served by axum via `STATIC_DIR` env var
- **Always consult `DESIGN_SYSTEM.md` before any UI/design work**
- i18n: `src/locales/` with `useLocale` hook — see root AGENTS.md i18n section

<!-- MANUAL: -->
