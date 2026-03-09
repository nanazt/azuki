<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# components

## Purpose

Reusable React components organized by feature domains, layout structure, and generic UI primitives.

## Subdirectories

| Directory   | Purpose                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `features/` | Feature-specific components: player, queue, search, upload, uploads, video, onboarding (see `features/AGENTS.md`) |
| `layout/`   | App layout: AppShell (3-column responsive), Sidebar, MobileTabBar (see `layout/AGENTS.md`)                     |
| `ui/`       | Generic UI primitives: Button, Slider, Avatar, Modal, Toast, Tooltip, Skeleton, etc. (see `ui/AGENTS.md`)      |

## For AI Agents

### Working In This Directory

- Each subdirectory has an `index.ts` barrel export
- Feature components go in `features/<feature-name>/`
- Shared UI primitives go in `ui/`
- 44px minimum touch targets for mobile
- Bottom padding `pb-32` for mobile player bar clearance

<!-- MANUAL: -->
