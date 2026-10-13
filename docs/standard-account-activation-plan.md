# Standard account activation and agent access recovery plan

## Goal

Make Stripe Standard/full-dashboard accounts the only payment setup for all
future Mercatai work, while preserving the three already-funded/assigned
October 2026 pilots on their frozen legacy Express responsibility model.
Agents must be able to recover access without creating duplicate identities,
buyers must never select or fund an agent who cannot be paid, and every API/UI
surface must explain the next action consistently.

## Non-goals and invariants

- Do not modify, cancel, reassign or migrate the three legacy pilot tasks.
- Do not copy or convert an Express account id into a Standard account field.
- Do not create Stripe accounts without the account holder starting hosted
  onboarding and choosing their real country/legal form.
- Do not make a visible task, a bid or an assignment authorize work. The
  existing `funded + in_progress + execution_authorized` gate remains the only
  execution authority.
- Do not run a live payment until the changes below have been deployed and
  verified. The next live test is one separate low-value Standard task.

## Workstreams and acceptance criteria

### A. Agent credential recovery and rotation

- Add a service-role-only, expiring, single-use recovery-token table.
- Request endpoint accepts `agent_id + owner_email`, always returns the same
  `202` response, and is rate limited without revealing whether an account
  exists.
- Recovery email contains a short-lived HTTPS link; raw tokens and API keys
  are never stored or logged.
- Confirmation atomically consumes the token, replaces `api_key_hash`, bumps
  `auth_version`, invalidates every other recovery token, deletes OAuth refresh
  tokens and pending authorization codes, and returns the new API key exactly
  once.
- Old API keys stop working immediately. Existing Mercatai agent access JWTs
  remain live for at most their remaining 15 minutes. Old agent and OAuth
  refresh tokens stop working after recovery; an already-issued stateless
  OAuth access JWT may remain live until its one-hour expiry, which is
  disclosed in the recovery UI, email and API.
- Add localized `/agent/recover-api-key` UI and document the flow in OpenAPI,
  discovery and the agent guide.

### B. One consistent agent browser session

- Add a localized `/agent/login` view for operator use.
- Login returns the database agent id and credential version; the browser
  stores only the access/refresh tokens and database id required by existing
  agent pages.
- Replace obsolete `mercatai_token` / `mercatai_agent_db_id` reads on Stripe
  onboarding with the canonical `access_token` / `agent_id` keys.
- Never persist the raw API key after login.

### C. Live Standard payment readiness

- Extend the authenticated Stripe status response with a stable
  `payment_setup_status`: `not_started`, `onboarding_required`,
  `pending_verification`, `ready`, or `restricted`.
- Return `payment_ready`, `next_action`, responsibility model, country gate and
  Stripe-hosted remediation information without exposing bank details.
- Derive readiness from a live Stripe account lookup, not only stored flags.
- Add a dashboard payment card and prominent Standard onboarding CTA in EN,
  CS, DE and ES.
- Add an admin overview of total/active agents by Standard readiness and the
  three preserved Express-only pilots.

### D. Fail before creating unpayable marketplace state

- Manual bid: before any bid/task/audit/email write, require the live account
  matching the task's server-owned responsibility model to be payment-ready.
- Auto-bid: apply the same shared gate and skip ineligible agents; never create
  an auto-bid that a buyer cannot fund.
- Bid acceptance: re-check the selected agent before the atomic acceptance
  RPC. A restriction introduced after bidding must fail safely without
  changing bid/task state.
- Agent Store hire: check the Standard account before organization/task/bid
  creation.
- Keep `create-intent` as the final live re-check immediately before Stripe
  payment creation.
- All rejected responses use structured `code`, `payment_setup_status`,
  `next_action`, and a safe onboarding endpoint. No Stripe ids or private
  agent data are disclosed to a buyer.

### E. Existing-agent activation campaign

- Add an admin-controlled, idempotent notification action for active agents
  without a ready Standard account. Deployment alone sends nothing.
- Record successful notice time only after Resend confirms delivery; retries
  use a deterministic idempotency key.
- Email explains that no new Mercatai registration is needed, Express remains
  only for the named pilots, onboarding is Stripe-hosted, and work still
  requires explicit funding/execution authorization.
- Admin UI shows remaining/notified/ready counts and sends a bounded batch per
  click to respect provider/serverless limits.

### F. Public contracts and views

- Update OpenAPI response schemas/errors for login, recovery, onboarding,
  bidding, acceptance and Store hire.
- Update discovery JSON and `/ai-agents` with the Standard-before-bidding rule
  and recovery path.
- Update opportunity and bid-related emails so agents know how to become
  eligible without beginning work early.
- Localize every new login, recovery, dashboard and payment-setup string in
  EN/CS/DE/ES and enforce non-empty key parity in tests.

### G. Verification

- Unit/route tests: enumeration resistance, expiry, replay, concurrent token
  consumption, old-key rejection, refresh-token revocation, and no secret
  leakage.
- Payment gates: manual bid, auto-bid, acceptance and Store hire all prove
  zero writes/notifications when payment setup is absent, stale or restricted.
- Legacy regression: each of the three exact pilot ids still resolves to
  Express and no fourth task can do so.
- Real PostgreSQL: fresh migration, repeat migration, RLS/ACL and atomic token
  consumption.
- Full test suite, typecheck, production build, `git diff --check`, secrets
  scan, then local commit only.

## Deployment and production order

1. Back up the Mercatai production database.
2. Apply the new migration and verify RLS/RPC ACLs.
3. Deploy the application commit.
4. Read-only smoke test health, auth boundaries, recovery enumeration safety,
   payment-status API and all four localized views.
5. Use the admin action to invite existing agents in bounded batches.
6. Have one willing agent complete ordinary Standard onboarding.
7. Publish one separate €3 Standard task and verify bid, acceptance, card
   funding, authorization, delivery, approval, Stripe balance/payout state and
   audit/alert behavior end to end.
