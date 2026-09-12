/**
 * Email notifications via Resend.
 * Free tier: 3 000 emails/month.
 * Set RESEND_API_KEY in Vercel env vars.
 *
 * Falls back silently if RESEND_API_KEY is not set (dev/test).
 */

const FROM = 'Mercatai <noreply@mercatai.eu>'
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://mercatai.eu'

function getResend() {
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  // Dynamic import so build doesn't fail when key is missing
  const { Resend } = require('resend')
  return new Resend(key)
}

async function send(to: string, subject: string, html: string) {
  const resend = getResend()
  if (!resend) {
    console.log(`[email] RESEND_API_KEY not set — skipping email to ${to}: ${subject}`)
    return
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html })
  } catch (err) {
    console.error('[email] send failed:', err)
  }
}

// ─── Templates ────────────────────────────────────────────────────────────────

export async function sendTaskCreated(params: {
  to: string
  taskTitle: string
  taskId: string
  buyerToken: string
  budgetMax: number
}) {
  await send(
    params.to,
    `✅ Your task "${params.taskTitle}" is live on Mercatai`,
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#4f46e5">Your task is live!</h2>
      <p>AI agents are now reviewing <strong>${params.taskTitle}</strong> and will submit bids within the next 4 hours.</p>
      <p><strong>Budget:</strong> up to €${params.budgetMax}</p>
      <a href="${BASE_URL}/buyer/tasks/${params.taskId}/bids"
         style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        View bids
      </a>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
      <p style="font-size:12px;color:#6b7280">
        🔑 <strong>Save your buyer token</strong> — you'll need it to approve or dispute delivery:
      </p>
      <code style="display:block;background:#f3f4f6;padding:10px;border-radius:6px;font-size:11px;word-break:break-all">
        ${params.buyerToken}
      </code>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">
        Mercatai · mercatai.eu · <a href="${BASE_URL}/terms" style="color:#9ca3af">Terms</a>
      </p>
    </div>
    `
  )
}

export async function sendNewBid(params: {
  to: string
  taskTitle: string
  taskId: string
  agentName: string
  priceEur: number
  deliveryHours: number
  totalBids: number
}) {
  await send(
    params.to,
    `💼 New bid on "${params.taskTitle}" — €${params.priceEur} by ${params.agentName}`,
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#4f46e5">New bid received</h2>
      <p><strong>${params.agentName}</strong> submitted a bid on <strong>${params.taskTitle}</strong>:</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:6px;color:#6b7280">Price</td><td style="padding:6px;font-weight:600">€${params.priceEur}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Delivery</td><td style="padding:6px;font-weight:600">${params.deliveryHours}h</td></tr>
        <tr><td style="padding:6px;color:#6b7280">Total bids</td><td style="padding:6px;font-weight:600">${params.totalBids}</td></tr>
      </table>
      <a href="${BASE_URL}/buyer/tasks/${params.taskId}/bids"
         style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        Review all bids
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `
  )
}

export async function sendModerationAlert(params: {
  taskId: string
  reportCount: number
  reasonCode: string
  autoQuarantined: boolean
}) {
  const to = process.env.ADMIN_ALERT_EMAIL
  if (!to) {
    console.log(`[email] ADMIN_ALERT_EMAIL not set — skipping moderation alert for task ${params.taskId}`)
    return
  }
  // Every report gets a human notified, not just the ones that cross the
  // automatic threshold — low volume today means a single report is
  // already a meaningful signal, and the threshold-based path alone would
  // silently swallow a lone report from an untrusted/new reporter that
  // doesn't count toward auto-quarantine (see the trust filter in
  // POST /tasks/[id]/report) but may still be exactly right.
  const subject = params.autoQuarantined
    ? `🚩 Task auto-quarantined after ${params.reportCount} reports`
    : `🚩 Task reported (${params.reportCount} total, not yet auto-quarantined)`
  const heading = params.autoQuarantined ? 'Task auto-quarantined' : 'Task reported'
  const body = params.autoQuarantined
    ? `Task <code>${params.taskId}</code> was quarantined after reaching ${params.reportCount} agent reports (most recent reason: <strong>${params.reasonCode}</strong>).`
    : `Task <code>${params.taskId}</code> was reported (most recent reason: <strong>${params.reasonCode}</strong>, ${params.reportCount} report(s) so far). It has not been automatically quarantined — worth a manual look.`
  await send(
    to,
    subject,
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#dc2626">${heading}</h2>
      <p>${body}</p>
      <a href="${BASE_URL}/admin/moderation"
         style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        Review in moderation queue
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `
  )
}

/** Bump when the admin-alert template changes in a way worth knowing about later — never interpreted by any code path, purely for humans reading a stored snapshot. */
export const ADMIN_ALERT_PAYLOAD_VERSION = 1

/**
 * The exact request stripeConnectMonitoring.ts will send to Resend for one
 * payout-failure alert — built once, at the first successful claim, and
 * then frozen (see admin_alert_payload_snapshot in
 * frontend/sql/14_stripe_connect_monitoring.sql). Deliberately excludes
 * the Resend API key: that is a runtime credential, never part of the
 * "payload" that must stay identical across retries, and must never be
 * persisted.
 */
export interface FrozenAdminAlertPayload {
  from: string
  to: string
  subject: string
  html: string
  payloadVersion: number
}

/**
 * Builds the admin-alert email exactly as it would be sent RIGHT NOW —
 * reading ADMIN_ALERT_EMAIL and NEXT_PUBLIC_BASE_URL and rendering the
 * CURRENT template. The caller (ensureAdminAlertSent in
 * stripeConnectMonitoring.ts) must call this ONLY when no
 * admin_alert_payload_snapshot exists yet for the payout — on every
 * later retry, the previously-frozen result is reused verbatim instead,
 * specifically so a later change to either env var or the template can
 * never cause a retry's payload to drift from what was already
 * (possibly) sent. Throws if ADMIN_ALERT_EMAIL is not configured — that
 * failure belongs to the FIRST attempt that discovers it, not to a
 * later retry that would otherwise not need this at all.
 */
export function buildAdminAlertProviderPayload(params: {
  payoutId: string
  stripeAccountId: string
  agentId: string | null
  amountLabel: string
  failureCode: string | null
}): FrozenAdminAlertPayload {
  const to = process.env.ADMIN_ALERT_EMAIL
  if (!to) {
    throw new Error('ADMIN_ALERT_EMAIL is not configured — a critical payout-failure alert cannot be built')
  }
  return {
    from: FROM,
    to,
    subject: `🚨 Stripe payout failed — ${params.amountLabel}`,
    html: `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#dc2626">Payout failed</h2>
      <p>A Stripe Connect payout of <strong>${params.amountLabel}</strong> failed.</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:6px;color:#6b7280">Payout ID</td><td style="padding:6px;font-weight:600"><code>${params.payoutId}</code></td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Connected account</td><td style="padding:6px;font-weight:600"><code>${params.stripeAccountId}</code></td></tr>
        <tr><td style="padding:6px;color:#6b7280">Agent</td><td style="padding:6px;font-weight:600">${params.agentId ?? 'unrecognized connected account — no matching agent record'}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Stripe failure code</td><td style="padding:6px;font-weight:600">${params.failureCode ?? 'not provided'}</td></tr>
      </table>
      <p style="font-size:12px;color:#6b7280">No bank account details are stored by Mercatai — check the Stripe Dashboard for this connected account for full detail.</p>
      <a href="${BASE_URL}/admin"
         style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        Open admin
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `,
    payloadVersion: ADMIN_ALERT_PAYLOAD_VERSION,
  }
}

/**
 * Delivers the critical payout.failed admin alert, or throws — never
 * swallows a failure the way `send()` above does. A missing
 * RESEND_API_KEY is itself a failure to throw on, not a reason to log
 * "skipping" and let the caller treat this as done: the caller
 * (ensureAdminAlertSent in stripeConnectMonitoring.ts) depends on a
 * thrown error here to keep the underlying webhook event un-completed so
 * it gets retried, and to keep the payout row's own admin_alert_status at
 * 'failed' rather than incorrectly 'sent'. Unlike ADMIN_ALERT_EMAIL
 * (baked into `payload.to` once, at the first claim), RESEND_API_KEY is a
 * runtime credential checked fresh on every call — it authenticates the
 * request, it is not part of the payload that must stay frozen, and it
 * is never itself stored.
 *
 * `payload` must be exactly what was frozen at the first successful
 * claim (see buildAdminAlertProviderPayload / admin_alert_payload_snapshot)
 * and `idempotencyKey` must be exactly buildPayoutAlertIdempotencyKey's
 * result for this payout — both identical on every retry. That pairing
 * is what lets Resend recognize a retry as a duplicate of an
 * already-accepted request (within Resend's own idempotency window,
 * currently 24 hours from the first send) and return the ORIGINAL send's
 * result instead of delivering a second email. Delivery here is
 * at-least-once, not exactly-once: outside that window — after a longer
 * outage, for instance — a retry can cause a second physical email, and
 * that is an accepted, deliberate tradeoff: a critical alert reaching an
 * administrator twice is safer than one silently never arriving at all.
 * Returns the id Resend assigned to the (possibly pre-existing) email on
 * success.
 */
export async function sendPayoutFailedAdminAlertOrThrow(payload: FrozenAdminAlertPayload, idempotencyKey: string): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured — a critical payout-failure alert cannot be delivered')
  }
  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)
  const { data, error } = await resend.emails.send(
    { from: payload.from, to: payload.to, subject: payload.subject, html: payload.html },
    { idempotencyKey }
  )
  // Resend's SDK does not throw on an API-level failure (invalid key,
  // rate limit, suppressed recipient, an idempotency conflict, ...) — it
  // resolves with { error } instead. Checking this explicitly is the
  // entire point of this function existing separately from `send()` above.
  if (error) {
    if (error.name === 'invalid_idempotent_request') {
      // The same idempotencyKey was reused with a DIFFERENT payload —
      // this must never be treated as success, and retrying with the
      // same (still-mismatched) payload will just keep failing; it is
      // not a transient condition the way concurrent_idempotent_requests
      // below is. In this codebase it should be structurally impossible
      // (the payload is frozen at first claim and reused verbatim), so
      // seeing this at all points at a real bug in that freezing, not a
      // normal operational hiccup.
      throw new Error(`Resend rejected the payout-failure alert — idempotency key reused with a different payload (invalid_idempotent_request): ${error.message}`)
    }
    if (error.name === 'concurrent_idempotent_requests') {
      // A different request with the SAME key is still being processed
      // by Resend right now — a genuinely transient, retryable state
      // (the caller's normal retry-via-lease path handles it like any
      // other failure), not a permanent rejection.
      throw new Error(`Resend is still processing a concurrent request with this idempotency key (concurrent_idempotent_requests): ${error.message}`)
    }
    throw new Error(`Resend rejected the payout-failure alert: ${error.message}`)
  }
  if (!data?.id) {
    throw new Error('Resend accepted the payout-failure alert but returned no email id')
  }
  return data.id
}

export async function sendPayoutFailedAgentNotice(params: { to: string; amountLabel: string }) {
  await send(
    params.to,
    `⚠️ A payout of ${params.amountLabel} to your bank account did not go through`,
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#b45309">Payout did not go through</h2>
      <p>Stripe attempted to pay out <strong>${params.amountLabel}</strong> to your connected bank account, but it failed.</p>
      <p>This is usually something on the bank side (a closed account, a mismatched account holder name, or similar) — check your Stripe Connect dashboard for what to fix, then Stripe retries automatically once it's resolved.</p>
      <a href="${BASE_URL}/agent/stripe-onboard"
         style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        Check your Stripe account status
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `
  )
}

export async function sendTaskCompleted(params: {
  to: string
  taskTitle: string
  taskId: string
  agentName: string
  payoutEur: number
}) {
  await send(
    params.to,
    `🎉 Task completed — "${params.taskTitle}"`,
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#16a34a">Task completed successfully!</h2>
      <p><strong>${params.agentName}</strong> completed <strong>${params.taskTitle}</strong>.</p>
      <p>€${params.payoutEur} has been released to the agent.</p>
      <a href="${BASE_URL}/buyer/dashboard"
         style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        Back to dashboard
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `
  )
}
