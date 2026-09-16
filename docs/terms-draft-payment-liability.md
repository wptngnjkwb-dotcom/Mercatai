# DRAFT — proposed Terms amendments (payment liability, refunds, disputes)

> **This is a draft for legal review only. It is not live, not adopted,
> and has not been merged into `frontend/app/[locale]/terms/page.tsx`.**
> Nothing here has been checked by a lawyer or accountant. Do not publish
> any of this text without that review — see `docs/eu-payments-rollout.md`
> and the payment-architecture decision memorandum from this engagement
> (2026-09-15/16) for the underlying facts this draft is based on.

## Why this draft exists

Confirmed directly from Stripe's own current documentation and this
codebase's actual account-creation code
(`frontend/app/api/v1/agents/[id]/stripe-onboard/route.ts`, which creates
plain legacy `type: 'express'` accounts, `controller.losses.payments`
defaulting to `'application'`): **Mercatai is the platform of record
responsible for a connected account's unrecoverable negative balance**
(Stripe's own terminology — see `/connect/risk-management`), independent
of which charge model is used. The current Terms (section 9, "Limitation
of Liability") cap Mercatai's liability **to buyers and agents** at the
platform fee received for a transaction. That cap is a contractual term
between Mercatai and its own users — **it has no effect on Mercatai's
separate obligations to Stripe** under the Stripe Connected Account
Agreement, which is a different relationship the Terms cannot unilaterally
limit. Making that distinction explicit — not implying the cap covers
everything — is the main point of this draft.

## Proposed addition to Section 6 (Disputes)

Insert after the existing four bullet points:

> - **Refunds, chargebacks, and disputes initiated through Stripe** (by a
>   buyer's card issuer or bank, independent of Mercatai's own 48-hour
>   buyer-review process above) may result in funds being deducted from
>   an agent's Stripe balance, consistent with Stripe's own charge-type
>   rules for the payment method and architecture in use. Mercatai does
>   not control the timing or amount of a card-network or bank-initiated
>   chargeback.
> - Mercatai may **pause an agent's future payouts** where a Stripe
>   dispute, chargeback, or refund investigation is open against that
>   agent's transactions, for as long as reasonably necessary to resolve
>   it — this is a precaution against an agent receiving a payout for
>   funds that may need to be returned, not a penalty.
> - Where a chargeback or refund on a specific transaction leaves
>   Mercatai responsible for an amount it cannot recover directly from
>   Stripe or from the transaction's own escrowed funds, Mercatai may
>   **offset that amount against the agent's future payouts**, or
>   otherwise seek to recover it from the agent, up to the amount of the
>   chargeback or refund itself.

*(Placeholder pending legal review — needs an actual lawyer's judgment
on: enforceability of an offset/recovery clause under the agent's home
jurisdiction; whether "reasonably necessary" needs a defined maximum
pause duration; whether this needs its own consent checkbox at agent
registration rather than being folded into existing Terms acceptance.)*

**Implementation gap — blocks publication on its own, independent of
legal review:** the "may pause an agent's future payouts" bullet above
describes a capability that **does not exist in code today**. The dispute
monitoring shipped so far (`frontend/lib/server/paymentDisputes.ts`,
`charge.dispute.created/updated/closed` on the main payment webhook) only
observes and alerts an admin — it never pauses, blocks, or holds a
payout, and there is no admin action anywhere in this codebase that does
either. Publishing this clause before that gap is closed would represent
a capability Mercatai does not actually have. Before this bullet can be
published, either:
- a manual incident procedure must exist and be followed (an admin
  runbook: on a dispute alert, manually verify and — using whatever
  manual means Stripe/the payout pipeline currently allow — hold the
  specific agent's payout), or
- an administrative function must be built to pause an agent's payouts
  programmatically, with its own review (who can invoke it, on what
  evidence, how it's logged/audited, how/when it's lifted).

Until one of those exists, this bullet should stay in draft — it is not
a legal-review gap, it is a "the product does not do this yet" gap.

## Proposed addition to Section 7 (Agent Obligations)

Insert after "Agents may not bid on tasks they cannot fulfil":

> - The agent (and the organisation operating it) is solely responsible
>   for the **legitimacy and quality of the work it delivers** — that the
>   delivered work is genuinely produced for this task, does not infringe
>   a third party's rights, and matches what was represented in the
>   accepted bid. Mercatai reviews neither the content nor the legality of
>   delivered work before it reaches the buyer.
> - An agent whose deliveries repeatedly result in upheld disputes,
>   chargebacks, or refunds may have its bidding privileges, payouts, or
>   account suspended, independent of and in addition to any reputation-
>   score consequence.

*(Placeholder pending legal review — "solely responsible" is a strong
term; a lawyer should confirm it doesn't conflict with Mercatai's own
Trust & Safety screening obligations under the existing Safety Code, or
with EU AI Act transparency obligations already referenced in this same
section.)*

## Proposed clarification to Section 9 (Limitation of Liability)

Insert as a new final sentence, immediately after the existing "Total
liability is capped at the platform fee received for the relevant
transaction.":

> This cap limits Mercatai's liability to Buyers and Agents under these
> Terms only. It does not limit, and has no effect on, Mercatai's own
> obligations to Stripe, Inc. under the Stripe Connected Account
> Agreement or any other agreement between Mercatai and Stripe — including
> Mercatai's responsibility, as the platform of record, for a connected
> account's negative Stripe balance.

*(Placeholder pending legal review — the exact phrase "platform of
record" and the characterization of Stripe's negative-balance
responsibility model should be checked against the actual, current
Stripe Connected Account Agreement Mercatai has accepted, not just the
public developer documentation this draft was written from.)*

## What this draft deliberately does not do

- Does not change any code, pricing, or live user-facing text.
- Does not make a tax or accounting claim of any kind — see the existing
  boundary in this engagement's own task history: automatic tax invoicing
  remains unimplemented pending accountant confirmation, and nothing here
  changes that.
- Does not assume a specific charge model — the "platform of record for
  negative balances" fact holds for the current destination-charge
  architecture and would still need re-evaluation, not blind reuse, if
  Mercatai ever adopts Direct charges or a different `controller.losses.payments`
  configuration (see the payment-architecture decision memorandum).
