# Login Page — Design Documentation

Source: `app/auth/login/page.tsx`

## 1. Layout

A single centered auth card on a full-viewport background. No header, footer, or nav chrome — this page stands alone.

```
┌─────────────────────────────────────────────┐
│                                               │
│                                               │
│              ┌───────────────┐               │
│              │  [card, 448px │               │
│              │   max-width]  │               │
│              └───────────────┘               │
│                                               │
│                                               │
└─────────────────────────────────────────────┘
```

- Outer container: `min-h-screen flex items-center justify-center` — the card is centered both horizontally and vertically in the viewport at any height.
- Card: `max-w-md w-full` (max-width 448px, full width of its own space below that) — on narrow viewports the card fills the width minus the outer container's implicit edge spacing; there are no explicit responsive breakpoints on this page, the flex-centering + max-width combination is what handles all viewport sizes.

## 2. Background

Class: `bg-background dotted-bg`

- Base fill: `--background` token (near-white, warm-toned: `oklch(0.982 0.003 85)`).
- Pattern: a dot grid laid over it —
  ```css
  .dotted-bg {
    background-image: radial-gradient(
      color-mix(in oklch, oklch(var(--foreground)) 14%, transparent) 1px,
      transparent 1px
    );
    background-size: 20px 20px;
  }
  ```
  A 1px dot every 20px, colored at 14% of the foreground (near-black) tint mixed straight into the background — a very faint texture, not a visible grid line.

## 3. Card

Classes: `bg-card border border-border rounded-2xl shadow-sm p-8`

| Property | Value |
|---|---|
| Background | `--card` token (`oklch(0.99 0.003 85)`) — a hair lighter than the page background, giving it very subtle separation without a hard edge |
| Border | 1px, `--border` token (`oklch(0.9 0.004 75)`) |
| Corner radius | `rounded-2xl` → `calc(var(--radius) * 1.8)` = 0.625rem × 1.8 = **1.125rem (18px)** |
| Elevation | Tailwind default `shadow-sm` (soft, minimal drop shadow — this is a flat design, not a heavily elevated modal) |
| Padding | `p-8` = 2rem (32px) on all sides |

## 4. Header block (inside the card, top)

```
[bolt-J][JETZT] | [Dialer]
Sign in to access the dialer
```

- Renders `<Logo />` (see §5), margin-bottom on the wrapping div: `mb-8` (2rem).
- Below the logo: `Sign in to access the dialer` — `text-muted-foreground text-sm mt-2` (`--muted-foreground`, 14px, 0.5rem top margin from the logo).

## 5. Logo mark (`components/Logo.tsx`, reused as-is — not custom to this page)

Two nested pieces:

**`JetztLogo`** — an inline SVG, viewBox `0 0 120 60`, height class `h-7` (28px) on this page:
- A bolt glyph standing in for a stylized "J": a downward-pointing triangle (`polygon points="8,5 16,5 12,15"`, fill `#FF9500`) sitting directly above a rectangle stem (`x=10 y=15 width=5 height=30`, same fill) — together reading as one flag/bolt shape immediately before the wordmark, not a separate decoration.
- Wordmark: `<text x="25" y="42" font-size="35" font-weight="700" fill="#1a1a1a">JETZT</text>`, system-ui/-apple-system/sans-serif stack (not the page's Instrument Sans var — this SVG hardcodes its own font stack).

**`Logo` wrapper** (what the login page actually renders): the `JetztLogo` mark, then a vertical divider (`border-l border-border`), then `Dialer` in `text-sm text-muted-foreground pl-2` — a muted secondary label distinguishing this specific product from the JETZT mark itself. Flex row, `gap-2` between the mark and the divider/label group.

## 6. Error state (conditional)

Rendered only when `error` state is non-null (set in the catch block of the sign-in handler):

```
┌─────────────────────────────────────────┐
│  ⚠ <error message text>                  │
└─────────────────────────────────────────┘
```

- `mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm`
- Background: destructive red at 10% opacity; border: same red at 20% opacity; text: full-strength destructive red.
- Content is literally the thrown error's `.message` (Supabase auth error text) or the fallback string `"Sign in failed"` — no custom copy/mapping per error type.

## 7. Primary action — Google Sign-In button

Full-width button, the single interactive element on the page.

```html
<button class="w-full bg-foreground hover:bg-foreground/90 disabled:opacity-50
               text-background font-medium py-2.5 px-4 rounded-lg
               transition-all active:translate-y-px
               flex items-center justify-center gap-2.5">
  [Google "G" mark, 16×16] Sign in with Google
</button>
```

**Deliberate exception to the app's own color system:** everywhere else, the primary action color is brand orange (`--brand` / `bg-primary`). This button is explicitly carved out to `bg-foreground` (near-black) / `text-background` (near-white text) instead — a code comment on this exact line states why: *"Google's own sign-in button conventions call for a neutral background, not a third-party brand color."* This is the only button in the app that intentionally does not use the brand primary color.

- Icon: the official 4-color Google "G" mark, inlined as raw SVG paths (not an external asset/icon font) — yellow `#FFC107`, red-orange `#FF3D00`, green `#4CAF50`, blue `#1976D2`, at native Google-brand geometry, sized to `w-4 h-4` (16px).
- Label swaps in place on click: `"Sign in with Google"` → `"Signing in..."` while `loading` is true. No spinner icon, no skeleton — text swap is the only loading affordance.
- States:
  - Default: `bg-foreground`
  - Hover: `hover:bg-foreground/90` (90% opacity, a subtle darken/lighten depending on theme)
  - Active (pressed): `active:translate-y-px` — the whole button nudges down 1px, a tactile "pressed" cue
  - Disabled (while `loading`): `disabled:opacity-50`, and the button's `disabled` attribute is bound to the same `loading` flag, so it can't be clicked twice while a sign-in is already in flight
- Radius: `rounded-lg` → `var(--radius)` = 0.625rem (10px) — one size down from the outer card's `rounded-2xl`, a deliberate nested-radius relationship (inner elements get smaller radii than the container they sit in).

## 8. Footer microcopy

```
──────────────────────────────
Only authorized agents can access this application.
```

- `mt-6 pt-6 border-t border-border` — a divider line 1.5rem below the button, with 1.5rem of its own top padding before the text.
- Text: `text-xs text-muted-foreground text-center` (12px, centered, muted gray).
- Purely informational — not a link, not interactive.

## 9. Interaction / state flow

| State | Trigger | Behavior |
|---|---|---|
| Mount | Page loads | Splash/loading gate is released immediately (`setReady()` fires on mount, before any auth check resolves) — the form is never hidden behind a spinner waiting on the silent already-logged-in check |
| Silent redirect check | Runs in the background on mount | If a session already exists, `router.push("/dashboard")` fires with no visible transition state on this page itself |
| Idle | Default | Button enabled, no error banner |
| Loading | Button clicked | `loading = true`, `error` cleared, button disabled + dimmed, label → "Signing in..." |
| Redirect (success path) | Supabase OAuth call resolves without throwing | Browser navigates away to Google's OAuth consent screen (`redirectTo` is set to this app's `/auth/callback`) — there is no "success" UI state on this page itself, since the tab leaves it |
| Error | Supabase OAuth call throws | `error` state set to the thrown message (or the fallback string), `loading` reset to `false`, error banner appears above the button |

## 10. Typography

- Body/UI font: **Instrument Sans** (`--font-instrument-sans`, loaded via `next/font/google`), the `sans` stack — used for every text element on this page.
- Monospace (`--font-jetbrains-mono`) is defined app-wide but not used anywhere on this page.
- Sizes present on this page: 14px (subtitle, error text, footer text is 12px), plus the logo SVG's own internal 35px (in its own 120×60 coordinate space, rendered at 28px actual height).

## 11. Color tokens used on this page

| Token | Value | Used for |
|---|---|---|
| `--background` | `oklch(0.982 0.003 85)` | Page background |
| `--card` | `oklch(0.99 0.003 85)` | Card fill |
| `--card-foreground` | `oklch(0.16 0.004 60)` | (inherited, not directly overridden on this page) |
| `--border` | `oklch(0.9 0.004 75)` | Card border, logo divider, footer divider |
| `--muted-foreground` | `oklch(0.53 0.006 60)` | Subtitle, footer text |
| `--foreground` | `oklch(0.16 0.004 60)` | Google button background (neutral-exception treatment) |
| `--destructive` / `--destructive-foreground` | `oklch(0.577 0.245 27.325)` | Error banner |
| `--brand` (`#FF9500`) | `rgb(255 149 0)` | Bolt mark only, inside the logo — this page does not otherwise use the brand color |

## 12. Accessibility notes (as-built, not aspirational)

- The Google button's loading state is communicated only via a text-content change (`"Sign in with Google"` → `"Signing in..."`) plus `disabled` — there is no `aria-live` region, so a screen reader will announce the change only if it happens to be focused/reading that button already.
- The error banner is a plain `<div>`, not marked with `role="alert"` — a screen-reader user won't be proactively notified when it appears.
- Color contrast: near-black text on the near-white card/background, and the destructive-red-on-red-10%-tint error banner, both read as high-contrast combinations at a glance; no contrast ratios have been formally computed against WCAG thresholds.
- No visible focus-ring override on this page — button focus styling falls back to the browser default (an explicit `ring` token exists in the design system but isn't applied here).
