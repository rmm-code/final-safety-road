# Product

## Register

product

## Users

- **Road-maintenance operators and engineers** in Tashkent work at an office desk in daylight. They spend long sessions on the dashboard, the map and the pothole list, deciding what to inspect or repair next.
- **Drivers** glance at a windshield-mounted phone running `/drive`. They start a drive while parked and stop it after parking; they never tap small controls while moving.
- **Citizens** see the public `/live` map, which is in Russian.

## Product Purpose

A phone on a windshield detects potholes. The system tracks each one, grades its visual severity, places it on a map and merges repeated sightings into physical potholes. Success means operators trust the map: every marker is a real defect, with evidence, a location, a severity and a history.

## Brand Personality

Calm, precise, trustworthy. The console is an operations tool, so it speaks plainly and shows evidence before conclusions. Color carries meaning (severity, state, action); it is never decoration.

## Anti-references

- Dark "cyber" dashboards with neon accents.
- Pastel, low-contrast UIs where status colors wash out.
- Decorative charts that show no real data.
- Busy admin templates with nested cards and badges everywhere.

The visual reference is the "Trackline" dashboard the team shared: a light, cool canvas; white rounded cards with soft borders; card headers with an icon, title and subtitle; status pills with a colored dot; segmented progress bars; crisp blue, orange and green accents.

## Design Principles

1. **Evidence first.** Show the photo, the counts and the uncertainty (GPS accuracy, visual-only severity) next to every claim.
2. **One meaning per color.** Severity (green/amber/red) and verification state (purple/red/green) are separate scales and never mix.
3. **Glanceable while driving.** The drive screen uses big targets, few words and no small controls mid-drive.
4. **Honest emptiness.** No fake data or placeholder charts. Empty and error states explain what is missing and why.
5. **Familiar over clever.** Standard sidebar, cards, tables and pills that a user of Linear or Stripe would trust.

## Accessibility & Inclusion

Target WCAG 2.2 AA: body text contrast ≥ 4.5:1, visible focus rings, and keyboard access to every control. Severity is always encoded with a label or an icon, never color alone (for color-blind operators). Motion respects `prefers-reduced-motion`.
