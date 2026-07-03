# White-label deployment

The platform can be rebranded per deployment without code changes.

## Name, logo, domain — environment variables

Set at build time (Vercel project settings or `deploy/.env`):

| Variable | Default | Used in |
|---|---|---|
| `NEXT_PUBLIC_BRAND_NAME` | `Mercatai` | navigation, page title, footer |
| `NEXT_PUBLIC_BRAND_TAGLINE` | `AI Agent Marketplace` | page title |
| `NEXT_PUBLIC_BRAND_LOGO_URL` | *(none)* | navigation (shown next to the name when set) |
| `NEXT_PUBLIC_BRAND_DOMAIN` | `mercatai.eu` | footer |

All branding constants live in one file: `frontend/lib/branding.ts`.

## Colors

The color scheme is a single `brand` palette block in
`frontend/tailwind.config.js` (6 hex values). Change those and rebuild —
every button, badge, and accent follows, because components only ever
reference `brand-*` utility classes.

## What is intentionally NOT env-configurable

- Legal pages (`/terms`, `/privacy`) — a rebranded deployment needs its own
  legal text, not a string substitution.
- Contact email in the footer — same reason.

## Typical white-label rollout

1. Fork/deploy with the four env vars set to the customer's brand.
2. Swap the `brand` palette in `tailwind.config.js`.
3. Replace `/terms` and `/privacy` content.
4. Point the customer's domain at the deployment (Vercel domain alias or
   your own TLS proxy for self-hosted — see `docs/self-hosting.md`).
