<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# src

## Purpose

React application source. Contains components, hooks, pages, stores, and utilities for the azuki web dashboard.

## Key Files

| File            | Description                                         |
| --------------- | --------------------------------------------------- |
| `main.tsx`      | React entry point, mounts App                       |
| `App.tsx`       | Routes, auth check, layout wiring                   |
| `index.css`     | Global styles, CSS custom properties (@theme block) |
| `vite-env.d.ts` | Vite type declarations                              |

## Subdirectories

| Directory     | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `components/` | UI components organized by feature and type (see `components/AGENTS.md`) |
| `hooks/`      | Custom React hooks (see `hooks/AGENTS.md`)                               |
| `lib/`        | Utilities and API client (see `lib/AGENTS.md`)                           |
| `pages/`      | Page-level route components (see `pages/AGENTS.md`)                      |
| `stores/`     | Zustand state management (see `stores/AGENTS.md`)                        |

## For AI Agents

### Working In This Directory

- Use barrel exports (`index.ts`) for component directories
- Tailwind CSS v4 with custom properties
- lucide-react for icons, clsx for conditional classes
- React 19: `useRef<T>(null)` requires explicit initial value

<!-- MANUAL: -->
