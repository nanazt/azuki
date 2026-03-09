<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# hooks

## Purpose

Custom React hooks for player controls, WebSocket communication, keyboard shortcuts, i18n, theming, and UI utilities.

## Key Files

| File                      | Description                                                  |
| ------------------------- | ------------------------------------------------------------ |
| `usePlayer.ts`            | Optimistic player controls (play, pause, skip, seek, volume) |
| `useWebSocket.ts`         | WebSocket auto-reconnect + event dispatch to stores          |
| `useKeyboardShortcuts.ts` | Global keyboard shortcuts (space=play/pause, arrows, etc.)   |
| `useToast.tsx`            | Toast notification system for success/error messages         |
| `useLocale.ts`            | i18n hook — exports `useLocale()`, `setLocale()`, `t()`     |
| `useTheme.ts`             | Theme switching (light/dark/system) with localStorage        |
| `useFileDrop.ts`          | Drag-and-drop file upload detection                          |
| `usePasteDetection.ts`    | Clipboard paste detection for URL/file input                 |
| `useInfiniteScroll.ts`    | Intersection Observer-based infinite scroll pagination       |

<!-- MANUAL: -->
