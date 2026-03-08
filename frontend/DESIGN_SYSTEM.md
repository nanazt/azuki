# azuki Design System

## Color Palette (Dark-only)

### Background Elevation (dark → light)
| Token | Value | Usage |
|-------|-------|-------|
| --color-bg | #0f0f0f | Page background, AppShell base |
| --color-bg-secondary | #1a1a1a | Sidebar, cards, section blocks |
| --color-bg-tertiary | #252525 | Icon backgrounds, button backgrounds |
| --color-bg-hover | #2a2a2a | List row/button hover |

### Text (light → dark)
| Token | Value | Usage |
|-------|-------|-------|
| --color-text | #e5e5e5 | Titles, body text |
| --color-text-secondary | #999 | Subtitles, artist names |
| --color-text-tertiary | #666 | Hints, timestamps, meta info |

### Accent & Semantic
| Token | Value | Usage |
|-------|-------|-------|
| --color-accent | #7c5cff | Active tab, CTA, emphasis |
| --color-accent-hover | #6a4de6 | Accent hover state |
| --color-border | #333 | Dividers, card borders |
| --color-danger | #e53e3e | Delete, error |
| --color-success | #38a169 | Connection status, success |

## Typography

- **Font**: System stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`)
- **Page title**: `text-lg font-semibold` or `text-xl font-bold`
- **Section title**: `text-sm font-semibold`
- **Body**: `text-sm` (14px)
- **Meta/hint**: `text-xs` (12px)
- **Micro**: `text-[10px]` (heatmap labels, tab bar labels)

## Layout

### AppShell (3-column)
- Sidebar: `w-60`, `bg-secondary`, visible `md+`
- Main content: `flex-1`, inherits `bg` (no extra background)
- Queue panel: `w-[340px]`, visible `lg+`
- PlayerBar: fixed bottom, `z-30`
- MobileTabBar: `md` 미만, `bottom-[60px]`, `z-30`

### Page padding
- Header: `px-4 pt-4 pb-3`
- List area: `py-2 px-1`
- Mobile bottom: `pb-32 md:pb-0`

## Elevation

Pages use `--color-bg` as base. Cards/panels float above with `--color-bg-secondary`.

```
Level 0: --color-bg          → page background
Level 1: --color-bg-secondary → sidebar, cards, panels
Level 2: --color-bg-tertiary  → elements inside cards
Level 3: --color-bg-hover     → interactive hover state
```

**Do NOT apply `bg-secondary` to entire pages** — it flattens the elevation hierarchy.

## Component Patterns

### Card
```
rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]
```

### List row
```
px-3 py-2 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors group
```
- Action buttons: `opacity-0 group-hover:opacity-100`
- Mobile: `[@media(hover:none)]:opacity-100`

### Buttons
- **Primary**: `bg-[var(--color-accent)] text-white hover:opacity-90`
- **Ghost**: `text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`
- **Danger**: `text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`

### Border radius
| Size | Usage |
|------|-------|
| rounded-md | Buttons, list rows |
| rounded-lg | Inputs, medium cards |
| rounded-xl | Cards, section blocks |
| rounded-2xl | Modals, login card |
| rounded-full | Chips, avatars |

## Touch & Accessibility

- Touch targets: `min-h-[44px] touch-manipulation`
- iOS zoom prevention: inputs use `text-[16px]` minimum

## Animation

- Hover: `transition-colors duration-100`
- Opacity: `transition-opacity`
- Loading spinner: `animate-spin` (Loader2 icon)
- Equalizer: custom `eq-bounce` keyframes

## Scrollbar

Custom webkit: 6px width, `--color-border` thumb, transparent track
