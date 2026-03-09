<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# stores

## Purpose

Zustand state management stores for client-side application state.

## Key Files

| File               | Description                                                                      |
| ------------------ | -------------------------------------------------------------------------------- |
| `playerStore.ts`   | Player state: current track, queue, playback status, volume, loop mode, position |
| `authStore.ts`     | Auth state: current user, login status                                           |
| `downloadStore.ts` | Download progress tracking for media files                                       |

## For AI Agents

### Working In This Directory

- Stores are updated by WebSocket events dispatched from `useWebSocket` hook
- `playerStore` is the primary state source for all player UI components
- Use Zustand selectors to minimize re-renders

<!-- MANUAL: -->
