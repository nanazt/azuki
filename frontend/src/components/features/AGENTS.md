<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-10 | Updated: 2026-03-10 -->

# features

## Purpose

Feature-specific component groups. Each subdirectory contains components for a single feature domain.

## Feature Areas

| Directory     | Key Components              | Description                                        |
| ------------- | --------------------------- | -------------------------------------------------- |
| `player/`     | `PlayerBar.tsx`, `index.ts` | Spotify-style bottom player bar with controls       |
| `queue/`      | `QueuePanel.tsx`, `QueueItem.tsx`, `index.ts` | Queue sidebar panel with drag-reorder   |
| `search/`     | `SearchPage.tsx`, `SearchResult.tsx`, `index.ts` | URL/keyword search with results     |
| `upload/`     | `UploadMetadataModal.tsx`   | File upload metadata editing modal                 |
| `uploads/`    | `UploadsPage.tsx`           | User uploaded files management page                |
| `video/`      | `VideoPlayer.tsx`, `index.ts` | YouTube video embed player                       |
| `onboarding/` | `WelcomeModal.tsx`          | First-time user welcome/onboarding modal           |

## For AI Agents

### Working In This Directory

- Each feature directory has an `index.ts` barrel export (where applicable)
- Feature components import shared UI primitives from `../ui/`
- Player controls use `usePlayer` hook for optimistic updates
- Queue panel receives state from `playerStore`

<!-- MANUAL: -->
