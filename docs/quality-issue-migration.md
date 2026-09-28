# Historical `disputed` tasks — safe migration procedure

This is a **procedure to run once, manually, against production**, not
something any code in this change executes automatically. Nothing in
`frontend/sql/22_quality_issue_facilitation.sql` deletes, refunds, or
otherwise resolves an existing task. This document exists because
`PUT /api/v1/tasks/{id}/dispute` and `PUT /api/v1/admin/resolve/{taskId}`
both now return `410 Gone` (see `docs/compliance-payment-flow.md` §1a) —
any task that was already `status='disputed'` before this deploy has no
in-app path forward anymore, and needs one.

## Step 1 — identify what exists (read-only)

Run against production, read-only, before deciding anything:

```sql
select t.id, t.status, t.created_at, t.posted_by_org_id, t.assigned_agent_id,
       tr.escrow_status, tr.gross_amount_eur, tr.stripe_payment_intent_id,
       tr.stripe_charge_model, tr.stripe_connected_account_id
from tasks t
left join transactions tr on tr.task_id = t.id
where t.status = 'disputed'
order by t.created_at;
```

Every row falls into exactly one of two buckets — tell them apart before
doing anything else:

- **Genuine buyer disputes from the old flow** — reachable via a
  `task_disputed` audit_logs row for that task id
  (`select * from audit_logs where action = 'task_disputed' and resource_id = '<task id>'`).
  These are the ones this migration is actually about.
- **Objective Stripe authorization failures** — reached via
  `invalidate_task_funding` (migration 17), unrelated to buyer quality
  complaints, and *not* what this document is for. Their `transactions`
  row will typically show `escrow_status='failed'`, not `'held'`. Leave
  these alone; they are not a Quality Issue backlog, they are a payment
  that already failed on Stripe's side.

For the first bucket, further split by `tr.escrow_status`:

- **`held`** — real money is still authorized/settled and waiting. These
  need a real decision (see Step 2). Do not leave these long-term: a card
  authorization becomes uncapturable ~7 days after creation
  (`docs/compliance-payment-flow.md`, "Known constraint").
- **`refunded` / `released`** — already resolved financially (by the old
  `admin/resolve` endpoint, before it was retired). Nothing to do
  financially; only the task's `status` is stuck at `disputed` instead of
  `cancelled`/`completed`. Safe to leave as historical record, or see
  Step 3 for a cosmetic-only status cleanup.

## Step 2 — resolving a still-`held` legacy dispute

There is deliberately **no automated code path for this** — the entire
point of this change is that Mercatai does not make this financial
decision. For each `held` row found in Step 1:

1. Contact the buyer and the agent directly (outside the app — use the
   contact details already on file) and let them reach their own
   agreement, the same way a live Quality Issue would work.
2. If the agent agrees to refund: preserve that explicit written consent,
   but do **not** use `POST /api/v1/payments/refund/{taskId}` — that legacy
   buyer/admin endpoint now returns `410 Gone` and cannot move money. The
   new voluntary-refund endpoint intentionally applies only to a live,
   open Quality Issue on a task in `review`, so it also cannot be used to
   rewrite this historical state. A held legacy row therefore needs a
   separately reviewed, one-off recovery procedure that preserves the
   agent's explicit consent and performs the same Stripe + atomic database
   invariants as the new flow. Do not improvise that procedure in SQL.
3. If the buyer agrees to approve: use
   `PUT /api/v1/tasks/{id}/approve` with the buyer's token (unchanged).
4. If no agreement is reached, this is a genuine business decision
   outside this codebase's scope — do not force an outcome through direct
   database writes. Escalate manually; get the buyer or agent's explicit
   written agreement before moving any money.

**Deployment gate:** if Step 1 finds any genuine historical dispute with
`escrow_status='held'`, stop deployment until a reviewed recovery path has
been prepared for those exact rows. The retired endpoint is not a fallback.

**Never** run a direct SQL `UPDATE` on `transactions.escrow_status` or
`tasks.status` to force a financial outcome — every legitimate transition
in this codebase goes through `finalize_funded_task` or
`finalize_task_refund` specifically because they are the only places that
keep `transactions` and `tasks` consistent, update agent reputation
correctly, and write the matching audit log row.

## Step 3 — optional cosmetic status cleanup (no money movement)

For a task that is already financially resolved (Step 1's second bucket:
`transactions.escrow_status` is `refunded` or `released`) but whose
`tasks.status` is still the stale `'disputed'` value, you may update the
task's own status to match, purely for reporting/dashboard clarity. This
moves no money and reuses no RPC — it is safe precisely because the
financial state was already finalized by whichever mechanism resolved it
before this migration:

```sql
update tasks set status = 'cancelled'
where id = '<task id>' and status = 'disputed'
  and exists (
    select 1 from transactions tr
    where tr.task_id = tasks.id and tr.escrow_status = 'refunded'
  );

update tasks set status = 'completed'
where id = '<task id>' and status = 'disputed'
  and exists (
    select 1 from transactions tr
    where tr.task_id = tasks.id and tr.escrow_status = 'released'
  );
```

Run one task at a time, reviewed manually — this is not a bulk script to
automate, precisely because "was this actually resolved correctly before"
is a judgment call this document cannot make for you.
