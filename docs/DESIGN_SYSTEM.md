# WECOMMANDER design system (v1.1 item 5a)

The React app (`gateway/ui`) takes every visual decision from one token file:
`gateway/ui/src/tokens.css`. The logo assets (`gateway/public/assets/wecommander-*.svg`)
and the `Brand` component are not part of the token set and must not change.

## Tokens

| Group | Names | Notes |
|---|---|---|
| Neutrals | `--bg`, `--surface`, `--surface-2`, `--surface-raised`, `--hover`, `--subtle-surface`, `--input`, `--stroke`, `--stroke-strong`, `--sidebar`, `--overlay` | dark by default, light under `:root.light` |
| Text | `--text`, `--muted`, `--faint` | `--muted` meets AA on `--surface` in both themes |
| Brand and status | `--accent`, `--success`, `--warning`, `--danger`, `--info`, each with a `-soft` tint; `--danger-strong` for destructive buttons; `--focus-ring` | |
| Type | `--wc-font-ui`, `--wc-font-display`, `--wc-font-mono`, `--wc-text-xs … --wc-text-display`, `--wc-leading-*`, `--wc-weight-*` | |
| Spacing | `--wc-space-0 … --wc-space-20` (4 px grid) | |
| Radius | `--wc-radius-xs … --wc-radius-full` | |
| Elevation | `--wc-shadow-sm/md/lg` | |
| Motion | `--wc-ease-standard`, `--wc-duration-fast/base/slow` | all motion is disabled under `prefers-reduced-motion` |
| Layers | `--wc-z-header … --wc-z-toast` | |

Scale tokens carry a `--wc-` prefix so they never override Tailwind's own
`--radius-*`, `--text-*` and `--shadow-*` theme variables. Colours are mapped
into Tailwind, so new code can write `bg-surface`, `text-muted`, `border-stroke`,
`bg-danger-soft`, `text-success` and so on.

## Shared components (`src/components/ui.tsx`)

`Button` (default, outline, ghost, secondary, link, danger), `Card`, `Input`,
`Badge`, `Dialog`, and for every screen state: `Alert` (info, success, warning,
danger; warning and danger use `role="alert"`), `EmptyState`, `Skeleton`,
`Spinner` and `PageHeader`.

## Shell rules

- Each layout has a skip link (`.skip-link`) to a single `main#main-content`.
- Navigation items are real links with `aria-current="page"`.
- Drawers and menus close on Escape; overlays are labelled buttons.
- Pages are loaded per route (`React.lazy`); the public first load is about
  120 KB gzip.

## Quality gates

- `gateway/test/i18n-keys.test.mjs` (in `npm test`): every literal passed to
  `translate()` has an English entry, and no key has two different English texts.
- `gateway/test/modern-ui-visual.mjs` (Playwright/CDP): desktop, 390 px and
  360 px without horizontal overflow, the skip link, a single main landmark,
  `aria-current` and closing the drawer with Escape. Screenshots are uploaded
  as the `dashboard-visual-acceptance` CI artifact.
