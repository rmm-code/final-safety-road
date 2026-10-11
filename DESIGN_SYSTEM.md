# Pothole Intelligence — Design System

Use this as the visual source of truth for the web app.

The product should feel like a **calm internal operations dashboard**: light, structured, data-focused, practical, and slightly soft, modelled on the Trackline reference the team shared (revised 2026-10-11 from the latest screenshots).

Avoid the typical “AI/vibecoded SaaS” look.

---

## 1. Visual Direction

### We want
- a light, cool workspace: white cards on a pale gray canvas
- **fills, not strokes**: surfaces are separated by a flat fill or a soft shadow, never an outline
- severity and status as **a coloured icon beside a word** (rising bars, filled check/alert marks)
- legends with small solid squares, as in the reference's "Tasks" card
- card headers with an icon tile, title and subtitle; footer strips for the next step
- Lucide line icons, 20px in navigation and 16–18px elsewhere
- restrained colour, dense but readable data, real data views, simple charts
- desktop-first, responsive down to the phone that records the drives

### Avoid
- **outlined pills**: tinted fill plus coloured border plus dot. This is what made the first redesign look cheap
- see-through colour (`bg-red/50`, `border-red/25`); every colour is a solid, opaque value
- dots as status markers
- borders on icon tiles, inner tiles, filters or decorative chips
- harsh gradients, neon, purple/black AI looks, rainbow accents
- glassmorphism, glowing orbs, dot-grid backgrounds, sparkles, emoji icons
- heavy drop shadows, excessive hover animation
- oversized heroes, bento marketing grids, three identical feature cards in a row
- generic "AI generated" copy ("It's not X, it's Y")

Color should communicate **meaning**, not decoration.

---

## 2. Color Palette

Tokens live in `apps/web/app/globals.css` (`@theme`). This section explains them; the
CSS is the source of truth. Revised 2026-10-11 toward the Trackline reference: a cool,
clean canvas instead of green-gray, and crisp accents instead of pastels.

### Neutrals

```css
--color-app:           #F5F6F8;  /* canvas: cool, near-neutral gray */
--color-sidebar:       #FFFFFF;  /* sidebar is a white working surface */
--color-surface:       #FFFFFF;  /* cards, tables, panels */
--color-subtle:        #F8F9FB;  /* inset tiles, table header band, card footers */
--color-hover:         #F5F6F9;  /* row and nav hover */
--color-fill:          #F1F3F6;  /* icon tiles, filter tracks, secondary buttons, active nav */
--color-fill-strong:   #E7EAF0;  /* hover on a fill; unlit severity bars */
--color-divider:       #EEF0F3;  /* the only lines: table rows */
--color-border:        #E7E9EE;
--color-border-strong: #D9DDE4;
--color-primary:       #111827;  /* text, ~17:1 on white */
--color-secondary:     #4A5363;  /* body and labels, ~7.5:1 */
--color-muted:         #6B7280;  /* hints, ~4.8:1: still passes AA */
```

No text tone fails 4.5:1 on white. Light gray "for elegance" is how the old palette lost readability.

### Primary Accent

One blue, for actions, the current selection, links, focus and single-series charts. Never decoration.

```css
--color-blue:        #3B82F6;  /* fills, strokes */
--color-blue-strong: #2563EB;  /* primary buttons, focus ring, active nav icon */
--color-blue-soft:   #EEF4FF;  /* active nav item, info pill */
--color-blue-ink:    #1D4ED8;  /* text on blue-soft, button hover */
```

### Supporting Accents

Each accent has a soft fill and an ink tone for text on that fill. The accents themselves are for fills and strokes only.

```css
green  #22A06B / soft #E8F7EF / ink #137A4E   success, small severity, repaired
yellow #F5A524 / soft #FFF5E0 / ink #A15C00   warning, medium severity
red    #E5484D / soft #FDECEC / ink #B42328   danger, large severity, confirmed defect
purple #8B5CF6 / soft #F3EEFF / ink #6D3FD6   ONE meaning: not yet verified
orange #F7A23B / soft #FFF1E2                 chart series only
```

Chart series (comparisons of several things): `--color-series-1` #4C8DF6, `-2` #F7A23B, `-3` #34C17A.

### Pothole Severity

Semantic, and may appear together:

```css
--color-severity-small:   #22A06B;
--color-severity-medium:  #F5A524;
--color-severity-large:   #E5484D;
--color-severity-unknown: #9AA2AF;
```

Verification state (public map) is a separate scale: unverified #8B5CF6, confirmed #E5484D, fixed #22A06B.

Canvas overlays and MapLibre cannot read CSS variables, so they hold copies (`features/map/lib/map-style.ts`, `features/analyze/lib/overlay.ts`, `features/live/lib/state-style.ts`). `map-style.test.ts` reads `globals.css` and fails if any copy drifts.

---

## 3. Typography

Avoid Inter, Geist, and Space Grotesk.

Use a neutral product font:

```css
font-family:
  "IBM Plex Sans",
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;
```

### Scale

```text
Page title       24px / 32px / 600
Section title    16px / 24px / 600
Card title       14px / 20px / 600
Body             14px / 20px / 400
Small            12px / 18px / 400
Metric           28px / 34px / 600
Table            13px / 20px / 400
```

Use sentence case.

Avoid oversized typography.

---

## 4. Spacing

Use a 4px base grid.

```text
4px   tiny
8px   compact
12px  control gap
16px  standard
20px  card padding
24px  section spacing
32px  page spacing
```

Dashboard content should be compact rather than airy.

---

## 5. Radius

```text
pills, badges ............ full (999px)
controls, nav items ...... 8–10px (rounded-lg)
cards, map frame ......... 14px (rounded-xl)
```

---

## 6. Fills and Shadows

No decorative strokes. A surface is told apart from its neighbour by a fill or a shadow:

```css
--shadow-card: 0 1px 2px rgb(16 24 40 / 0.05), 0 2px 8px rgb(16 24 40 / 0.04);  /* every card */
--shadow-pop:  0 8px 24px rgb(16 24 40 / 0.08), 0 2px 6px rgb(16 24 40 / 0.04);  /* floating panels */
```

- **Cards:** `rounded-xl bg-surface shadow-card`, with no border.
- **Inner tiles** (metric groups, steps): `rounded-lg bg-subtle`, with no border.
- **Icon tiles, filter tracks, secondary buttons and filled inputs:** `bg-fill`.
- **The one line allowed:** table row dividers (`divide-divider`), which carry structure, not decoration.
- **Alerts:** a soft solid fill (`bg-red-soft`, `bg-yellow-soft`) with an ink title, and no border.

---

## 7. Sidebar

White, 248px, a right border. From the top:

1. Brand: a blue rounded mark and "Pothole Intelligence / Road-damage console".
2. Navigation in three groups with plain sentence-case labels:
   - Monitor: Overview, Dashboard, Map, Potholes.
   - Capture: Live drive, Analyze video.
   - Models: Model comparison.
3. Footer: the sign-in status and the visual-severity note.

Icons are Lucide at 20px. The active item is a neutral fill (`bg-fill`, primary text, medium weight, dark icon), as in the reference; hover is `bg-hover`. Below `lg` the sidebar becomes a top bar, and the items scroll horizontally without group labels.

---

## 8. Cards

`Panel` (`components/ui.tsx`) is the only card: borderless, white, `shadow-card`. Its header holds an icon tile (36px, `bg-fill`, no border), then the title (15px semibold) and a muted subtitle, with actions on the right. An optional `footer` adds the reference's quiet strip at the bottom (`bg-subtle`, a label and an arrow), for the card's next step.

- Never nest cards. Inner tiles (`bg-subtle`, border, `rounded-lg`) are allowed for metric groups.
- Tables sit flush: pass `bodyClassName="p-0 sm:p-0"`.
- Do not repeat identical icon+heading+text cards across a page.

---

## 9. Buttons

Height 36px, `rounded-lg`, 13.5px medium. Labels are verb + object ("Mark as repaired", not "Repaired").

### Primary
`bg-blue-strong text-white`, hover `bg-blue-ink`. Use one per screen area.

### Secondary
A flat `bg-fill` with primary text, hover `bg-fill-strong`, and no border.

### Destructive
`bg-red`, hover `bg-red-ink`. Use it only for actions that lose data or end a drive.

The drive screen's Start/Stop buttons are 48px tall and full width, because they are pressed with the car stopped.

---

## 10. Inputs

Filled, not outlined: `h-9 rounded-lg bg-fill px-2.5`, primary text. Focus is the global 2px blue ring (`--color-blue-strong`, 2px offset). Avoid oversized search bars and pill-shaped fields.

Filters use `FilterTabs`, a `bg-fill` track where the chosen option is lifted onto white with `shadow-card`. Every option carries its word and may lead with an icon (for example, the severity bars).

---

## 11. Tables

Use the shared `TABLE` classes from `components/ui.tsx`:

- the header row is a quiet band (`bg-subtle`, muted 12.5px text) with sentence-case column names, never uppercase-tracked and with no rule under it;
- rows have 12px vertical padding, `divide-border`, and a `hover:bg-hover` tint;
- numbers are `tabular`, and coordinates are mono at 12px;
- the last column is a "Details ›" link in blue.

---

## 12. Severity and Status Marks

A coloured mark beside a word. There are no pills, no outlines and no dots.

```text
Severity (SeverityBadge / SeverityIcon)
  three rising bars, as many lit as the pothole is bad, the rest in fill-strong gray:
  small   1 bar  green
  medium  2 bars yellow
  large   3 bars red
  unknown 0 bars gray, labelled "Not graded"
  The count of lit bars carries the level, so it survives colour blindness.

Status (StatusBadge): a filled Lucide circle mark with a white glyph, then the word in secondary text
  reported            circle-help   purple   (a claim nobody has corroborated)
  active              circle-alert  red      (confirmed, open)
  suspected repaired  clock         yellow
  repaired            circle-check  green
  false positive      circle-x      gray
  ignored / archived  eye-off / archive, gray line icon

Badge: a small flat label (rounded-md, solid soft fill and ink text, optional icon), for counts and short facts only.
```

Every mark carries its word.

---

## 13. Map

The map is a primary product surface. Keep the surrounding UI neutral so map data stands out. The map frame is a borderless card (`rounded-xl shadow-card`).

```text
Markers   Small green · Medium yellow · Large red (the severity tokens)
Legends   severity bars beside each count; public-map states use small solid squares
```

- Cluster markers at lower zoom levels.
- The selected pothole uses a stronger marker outline, never a glow.
- Popups and side panels are normal cards, with no glass effect.

---

## 14. Live Drive Screen

This page should prioritize the camera.

Suggested layout:

```text
┌────────────────────────────────────┐
│ Live Drive                 00:18:42│
├────────────────────────────────────┤
│                                    │
│          CAMERA PREVIEW            │
│                                    │
│       [POTHOLE · 92%]              │
│                                    │
├────────────────────────────────────┤
│ AI  Running   GPS ±7m   7.2 FPS    │
│ Detected 4                         │
│                                    │
│              Stop Drive            │
└────────────────────────────────────┘
```

Detection overlay:
- thin 2px stroke
- severity color
- small label
- no glowing box
- no unnecessary animation

---

## 15. Analyze Video Screen

Main layout:

```text
Header
Upload control

Large video panel

Analysis summary
Detection timeline
Detection table
```

Do not create three decorative feature cards.

Use actual product information.

Example summary:

```text
17 potholes detected
3 large · 8 medium · 6 small
Average confidence 89%
```

---

## 16. Dashboard

Prefer a structured grid based on information importance rather than a trendy bento layout.

Recommended structure:

```text
Top row:
Active potholes | New today | Large potholes | Drive sessions

Middle:
Large map preview

Bottom:
Recent detections
Severity distribution
Recent drive sessions
```

Cards should align to a clear column system.

---

## 17. Charts

Charts should use very few colors.

Default:
- primary blue
- green for positive/healthy
- semantic severity colors when required

Avoid:
- gradients
- 3D charts
- rainbow series
- decorative charts with no operational value

Grid lines should be very light.

---

## 18. Icons

[Lucide](https://lucide.dev) (`lucide-react`, pinned), through `components/icons.tsx` only. Components ask for a product name (`"potholes"`, `"drive"`), never a Lucide import, so the set stays small and consistent.

- Sizes: 20px in navigation, 16–18px in tables, buttons and card headers.
- Stroke: 1.75 by default; 2 for the filled status marks.
- Use icons when they speed scanning. Don't put one in every card just because there is room.
- The severity bars are a small custom SVG, `SeverityIcon` in `components/ui.tsx`. Lucide's signal icons collapse into a dot at table size.

---

## 19. Motion

Motion should be subtle and functional.

Allowed:
- 120–180ms background transition
- menu opening
- map marker selection
- drawer open/close
- detection overlay updates

Avoid:
- bouncing
- floating
- pulsing decoration
- animated arrows
- constant hover movement
- scroll-reveal effects on dashboard pages

---

## 20. Loading States

Do not use a generic skeleton for every screen.

Prefer:
- small spinner for actions
- inline `Loading map…`
- progress percentage for video analysis
- real camera/model status for Live Drive

Example:

```text
Analyzing video… 64%
421 / 658 frames processed
```

Loading states should communicate real system progress when possible.

---

## 21. Writing Style

UI copy should be direct and operational.

Good:

```text
Start Drive
Analyze Video
17 potholes detected
Location unavailable
Mark as repaired
Model confidence
Last seen
```

Avoid:

```text
Unlock smarter roads
Supercharge your road intelligence
It’s not monitoring, it’s a second brain
AI-powered magic
```

Do not use em dashes in UI copy.

---

## 22. CSS Variables

The token set is `apps/web/app/globals.css` (Tailwind `@theme`); section 2 lists and explains it. Components use the generated utilities (`bg-surface`, `text-secondary`, `border-border`, `bg-severity-large`, `shadow-card`...). Hard-coded hex values are allowed only where CSS variables cannot reach (canvas, MapLibre paint), and those copies are tested against the tokens.

---

## 23. Final Design Rule

When making a UI decision, prefer:

```text
clear > clever
structured > decorative
real data > placeholder marketing
fills > strokes
neutral > colorful
compact > oversized
functional motion > decorative motion
```

The interface should look like a **real road operations product used every day**, not a landing page generated from a generic AI SaaS template.
