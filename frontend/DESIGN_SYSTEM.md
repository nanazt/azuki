# azuki Design System

## Theme System

azuki supports **Dark**, **Light**, and **System** (auto) themes.

### Mechanism

- CSS variables defined in `@theme` block (dark defaults) + `.light` class overrides in `index.css`
- FOUC prevention: inline `<script>` in `index.html` reads `localStorage('azuki-theme')` before paint
- `useTheme()` hook: manages state, OS media query listener, localStorage + server sync
- All components use `bg-[var(--color-…)]` / `text-[var(--color-…)]` patterns — **never** hardcode Tailwind color classes for themed elements

### Rule

New colors must be defined in **both** themes. Use `var(--color-…)` CSS variables exclusively.

---

## Color Palette

### Accent (both modes identical)

| Token                | Value   | Usage                                   |
| -------------------- | ------- | --------------------------------------- |
| --color-accent       | #FFB7C9 | Sakura pink — buttons, sliders, borders |
| --color-accent-hover | #FF9DB5 | Slightly deeper on hover                |

**Pink = surface only** — accent is used for backgrounds, borders, and decorative elements. Never use pink as a text color. Use `text-[var(--color-text)]` or `text-[var(--color-text-secondary)]` for text on any background.

**Text on accent backgrounds**: Always use `text-[#1a1a1a]` (dark text) for readable contrast on pastel pink.

### Dark Mode (default)

#### Background Elevation (dark → light)

| Token                | Value   | Usage                                |
| -------------------- | ------- | ------------------------------------ |
| --color-bg           | #0f0f0f | Page background, AppShell base       |
| --color-bg-secondary | #1a1a1a | Sidebar, cards, section blocks       |
| --color-bg-tertiary  | #252525 | Icon backgrounds, button backgrounds |
| --color-bg-hover     | #2a2a2a | List row/button hover                |

#### Text (light → dark)

| Token                  | Value   | Usage                        |
| ---------------------- | ------- | ---------------------------- |
| --color-text           | #e5e5e5 | Titles, body text            |
| --color-text-secondary | #999    | Subtitles, artist names      |
| --color-text-tertiary  | #666    | Hints, timestamps, meta info |

#### Semantic

| Token           | Value   | Usage                      |
| --------------- | ------- | -------------------------- |
| --color-border  | #333    | Dividers, card borders     |
| --color-danger  | #e53e3e | Delete, error              |
| --color-success | #38a169 | Connection status, success |

### Light Mode

#### Background Elevation

| Token                | Value   | Usage            |
| -------------------- | ------- | ---------------- |
| --color-bg           | #fafafa | Page background  |
| --color-bg-secondary | #f2f2f2 | Sidebar, cards   |
| --color-bg-tertiary  | #e8e8e8 | Icon backgrounds |
| --color-bg-hover     | #e0e0e0 | Hover state      |

#### Text

| Token                  | Value   | Usage             |
| ---------------------- | ------- | ----------------- |
| --color-text           | #111111 | Titles, body text |
| --color-text-secondary | #555555 | Subtitles         |
| --color-text-tertiary  | #888888 | Hints, meta info  |

#### Semantic

| Token           | Value   | Usage                  |
| --------------- | ------- | ---------------------- |
| --color-border  | #d4d4d4 | Dividers, card borders |
| --color-danger  | #c53030 | Delete, error          |
| --color-success | #276749 | Success                |

---

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

- **Primary**: `bg-[var(--color-accent)] text-[#1a1a1a] hover:opacity-90` (dark text on pastel accent)
- **Ghost**: `text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`
- **Danger**: `text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`

### Active state (toggle buttons, tabs)

Use background tint instead of text color:

```
bg-[var(--color-accent)]/20 rounded-lg text-[var(--color-text)]
```

Never use `text-[var(--color-accent)]` for active states.

### Border radius

| Size         | Usage                 |
| ------------ | --------------------- |
| rounded-md   | Buttons, list rows    |
| rounded-lg   | Inputs, medium cards  |
| rounded-xl   | Cards, section blocks |
| rounded-2xl  | Modals, login card    |
| rounded-full | Chips, avatars        |

## Heatmap Palette

6-step gradient (both modes identical, `empty` = `--color-bg-tertiary`):

| Level | Color                    | Meaning     |
| ----- | ------------------------ | ----------- |
| 0     | var(--color-bg-tertiary) | No activity |
| 1     | #FFD4E0                  | Low         |
| 2     | #FFB7C9                  | Medium      |
| 3     | #FF9DB5                  | High        |
| 4     | #FF82A0                  | Very high   |
| 5     | #FF6B8A                  | Maximum     |

## Touch & Accessibility

- Touch targets: `min-h-[44px] touch-manipulation`
- iOS zoom prevention: inputs use `text-[16px]` minimum

## Animation

- Hover: `transition-colors duration-100`
- Opacity: `transition-opacity`
- Loading spinner: `animate-spin` (Loader2 icon)
- Equalizer: custom `eq-bounce` keyframes

## Scrollbar

Custom webkit: 6px width, `--color-border` thumb (dark), `#b0b0b0` thumb (light), transparent track
