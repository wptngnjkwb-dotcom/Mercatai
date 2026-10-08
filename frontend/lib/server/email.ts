/**
 * Email notifications via Resend.
 * Free tier: 3 000 emails/month.
 * Set RESEND_API_KEY in Vercel env vars.
 *
 * Falls back silently if RESEND_API_KEY is not set (dev/test).
 */

const FROM = 'Mercatai <noreply@mercatai.eu>'
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://mercatai.eu'

function escapeEmailHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function emailSubjectText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

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
    const result = await resend.emails.send({ from: FROM, to, subject, html })
    if (result?.error) throw new Error(`Resend rejected the email: ${result.error.message}`)
  } catch (err) {
    console.error('[email] send failed:', err)
  }
}

export async function sendExecutionAuthorized(params: {
  to: string
  taskId: string
  deliveryDeadlineAt: string
}) {
  const taskUrl = `${BASE_URL}/agent/deliver/${encodeURIComponent(params.taskId)}`
  await send(
    params.to,
    'Mercatai: payment confirmed — work is now authorized',
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#15803d">You may begin work</h2>
      <p>Stripe has confirmed the payment and Mercatai has marked the task as funded.</p>
      <p>The authenticated API now reports <code>funding_status: funded</code> and <code>execution_authorized: true</code> for your assigned agent.</p>
      <p><strong>Delivery deadline:</strong> ${escapeEmailHtml(params.deliveryDeadlineAt)}</p>
      <a href="${taskUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">Open assigned task</a>
      <p style="font-size:12px;color:#6b7280">This message follows payment confirmation. A prior task-posted or bid-selection notification never authorizes work by itself.</p>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `,
  )
}

export const OPPORTUNITY_ALERT_PAYLOAD_VERSION = 1

export interface FrozenOpportunityAlertPayload {
  from: string
  to: string
  subject: string
  html: string
  payloadVersion: number
}

const OPPORTUNITY_COPY = {
  en: {
    subject: 'New Mercatai task open for bids',
    heading: 'New genuine buyer task',
    intro: 'A non-demo buyer task matching your saved alert is now open for bids.',
    warning: 'This task is not funded yet. Do not begin substantive work unless your bid is selected and the authenticated API reports funding_status: funded and execution_authorized: true.',
    button: 'Inspect task and bid',
    manage: 'Manage or disable opportunity alerts',
  },
  cs: {
    subject: 'Nový úkol Mercatai je otevřený pro nabídky',
    heading: 'Nový skutečný úkol zadavatele',
    intro: 'Nový nedemonstrační úkol odpovídající vašemu uloženému filtru je otevřený pro nabídky.',
    warning: 'Úkol zatím není financovaný. Nezačínejte pracovat, dokud nebude vaše nabídka vybrána a autentizované API nebude vracet funding_status: funded a execution_authorized: true.',
    button: 'Prohlédnout úkol a podat nabídku',
    manage: 'Spravovat nebo vypnout upozornění',
  },
  de: {
    subject: 'Neue Mercatai-Aufgabe offen für Angebote',
    heading: 'Neue echte Käuferaufgabe',
    intro: 'Eine neue, nicht als Demo gekennzeichnete Käuferaufgabe passt zu Ihrem gespeicherten Filter und ist offen für Angebote.',
    warning: 'Diese Aufgabe ist noch nicht finanziert. Beginnen Sie erst mit der Arbeit, wenn Ihr Angebot ausgewählt wurde und die authentifizierte API funding_status: funded sowie execution_authorized: true meldet.',
    button: 'Aufgabe prüfen und Angebot abgeben',
    manage: 'Benachrichtigungen verwalten oder deaktivieren',
  },
  es: {
    subject: 'Nueva tarea de Mercatai abierta a ofertas',
    heading: 'Nueva tarea real de un comprador',
    intro: 'Una nueva tarea no demostrativa coincide con su filtro guardado y está abierta a ofertas.',
    warning: 'La tarea aún no está financiada. No empiece el trabajo hasta que se seleccione su oferta y la API autenticada indique funding_status: funded y execution_authorized: true.',
    button: 'Revisar la tarea y ofertar',
    manage: 'Gestionar o desactivar alertas',
  },
} as const

export function buildOpportunityAlertProviderPayload(params: {
  to: string
  locale: keyof typeof OPPORTUNITY_COPY
  taskId: string
  title: string
  category: string
  budgetMaxEur: number
  deadlineHours: number
  capabilities: string[]
}): FrozenOpportunityAlertPayload {
  const copy = OPPORTUNITY_COPY[params.locale] ?? OPPORTUNITY_COPY.en
  const taskUrl = `${BASE_URL}/marketplace/${encodeURIComponent(params.taskId)}`
  const settingsUrl = `${BASE_URL}/agent/autobid#opportunity-alerts`
  const safeTitle = escapeEmailHtml(params.title)
  const safeCategory = escapeEmailHtml(params.category)
  const safeCapabilities = params.capabilities.map(escapeEmailHtml).join(', ') || '—'
  return {
    from: FROM,
    to: params.to,
    subject: emailSubjectText(`${copy.subject}: ${params.title}`),
    html: `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#4f46e5">${copy.heading}</h2>
      <p>${copy.intro}</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:6px;color:#6b7280">Task</td><td style="padding:6px;font-weight:600">${safeTitle}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Category</td><td style="padding:6px">${safeCategory}</td></tr>
        <tr><td style="padding:6px;color:#6b7280">Budget ceiling</td><td style="padding:6px">€${Number(params.budgetMaxEur).toFixed(2)}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Task deadline</td><td style="padding:6px">${params.deadlineHours}h</td></tr>
        <tr><td style="padding:6px;color:#6b7280">Capabilities</td><td style="padding:6px">${safeCapabilities}</td></tr>
      </table>
      <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:12px;margin:16px 0"><strong>Important:</strong> ${copy.warning}</div>
      <a href="${taskUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">${copy.button}</a>
      <p style="font-size:12px;color:#6b7280"><a href="${settingsUrl}" style="color:#4f46e5">${copy.manage}</a></p>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `,
    payloadVersion: OPPORTUNITY_ALERT_PAYLOAD_VERSION,
  }
}

export async function sendOpportunityAlertOrThrow(
  payload: FrozenOpportunityAlertPayload,
  idempotencyKey: string,
): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured — opportunity alert cannot be delivered')
  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)
  const { data, error } = await resend.emails.send(
    { from: payload.from, to: payload.to, subject: payload.subject, html: payload.html },
    { idempotencyKey },
  )
  if (error) throw new Error(`Resend rejected the opportunity alert: ${error.message}`)
  if (!data?.id) throw new Error('Resend accepted the opportunity alert but returned no email id')
  return data.id
}

// ─── Templates ────────────────────────────────────────────────────────────────

export async function sendTaskCreated(params: {
  to: string
  taskTitle: string
  taskId: string
  buyerToken: string
  budgetMax: number
  kind?: 'marketplace_task' | 'store_hire'
  assignedAgentName?: string
}) {
  const buyerAccessUrl = `${BASE_URL}/buyer/tasks/${encodeURIComponent(params.taskId)}/bids#buyer_token=${encodeURIComponent(params.buyerToken)}`
  const safeTitle = escapeEmailHtml(params.taskTitle)
  const isStoreHire = params.kind === 'store_hire'
  const safeAgentName = params.assignedAgentName ? escapeEmailHtml(params.assignedAgentName) : 'the selected agent'
  await send(
    params.to,
    emailSubjectText(isStoreHire
      ? `✅ Your Mercatai hire "${params.taskTitle}" is ready for payment`
      : `✅ Your task "${params.taskTitle}" is live on Mercatai`),
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#4f46e5">${isStoreHire ? 'Your direct hire is ready' : 'Your task is live!'}</h2>
      <p>${isStoreHire
        ? `<strong>${safeAgentName}</strong> has been selected for <strong>${safeTitle}</strong>. Payment must be confirmed before work may begin.`
        : `AI agents are now reviewing <strong>${safeTitle}</strong> and may submit bids during the published bidding window.`}</p>
      <p><strong>Budget:</strong> up to €${params.budgetMax}</p>
      <a href="${buyerAccessUrl}"
         style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        Open buyer dashboard
      </a>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
      <p style="font-size:12px;color:#6b7280">🔑 The button contains a private, task-scoped buyer access token. Do not forward the link. Your browser stores the token locally and removes it from the address bar after opening it.</p>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">
        Mercatai · mercatai.eu · <a href="${BASE_URL}/terms" style="color:#9ca3af">Terms</a>
      </p>
    </div>
    `
  )
}

export interface BidAcceptedActionEmailParams {
  to: string
  taskTitle: string
  taskId: string
  agentId: string
  priceEur: number
  deliveryHours: number
  stripeAccountType: 'standard' | 'express'
  onboardingRequired: boolean
}

export function buildBidAcceptedActionEmail(params: BidAcceptedActionEmailParams): { subject: string; html: string } {
  const taskUrl = `${BASE_URL}/marketplace/${encodeURIComponent(params.taskId)}`
  const onboardingBody = params.stripeAccountType === 'express'
    ? `{"country":"<account-holder country>","task_id":"${params.taskId}"}`
    : '{"country":"<account-holder country>"}'
  const onboardingStep = params.onboardingRequired
    ? `
      <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:14px;margin:16px 0">
        <strong>Action required before the buyer can fund this task</strong>
        <p>Authenticate as your agent, then call:</p>
        <code style="display:block;background:#fff;padding:10px;border-radius:6px;font-size:11px;word-break:break-all">POST /api/v1/agents/${escapeEmailHtml(params.agentId)}/stripe-onboard</code>
        <p>JSON body:</p>
        <code style="display:block;background:#fff;padding:10px;border-radius:6px;font-size:11px;word-break:break-all">${escapeEmailHtml(onboardingBody)}</code>
        <p>The country must be the real country of the human or business that owns the payout account. The human account holder must open the returned <code>onboarding_url</code> and complete Stripe-hosted identity, business and bank-account verification.</p>
        <p>Do not email credentials or identity documents to Mercatai.</p>
      </div>
    `
    : '<p>Your required Stripe account is already recorded. The buyer can now attempt funding; Stripe readiness is checked live before any payment is created.</p>'

  return {
    subject: emailSubjectText(`Mercatai: your bid was accepted — ${params.taskTitle}`),
    html: `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#111">
      <h2 style="color:#4f46e5">Your bid was accepted</h2>
      <table style="width:100%;border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:6px;color:#6b7280">Task</td><td style="padding:6px;font-weight:600">${escapeEmailHtml(params.taskTitle)}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Task ID</td><td style="padding:6px;font-family:monospace">${escapeEmailHtml(params.taskId)}</td></tr>
        <tr><td style="padding:6px;color:#6b7280">Accepted price</td><td style="padding:6px">€${Number(params.priceEur).toFixed(2)}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Delivery time</td><td style="padding:6px">${params.deliveryHours} hours after funding is confirmed</td></tr>
      </table>
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:14px;margin:16px 0">
        <strong>Do not start work yet.</strong>
        <p>The bid selection does not authorize execution. Start only when the authenticated task API reports <code>status: in_progress</code>, <code>funding_status: funded</code> and <code>execution_authorized: true</code>.</p>
      </div>
      ${onboardingStep}
      <p>Check onboarding status with <code>GET /api/v1/agents/${escapeEmailHtml(params.agentId)}/stripe-onboard${params.stripeAccountType === 'express' ? `?task_id=${encodeURIComponent(params.taskId)}` : ''}</code>. After onboarding is complete, the buyer can authorize payment. Mercatai will send a separate execution-authorized notice only after Stripe confirms funding.</p>
      <a href="${taskUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">View task</a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `,
  }
}

export async function sendBidAcceptedActionRequired(params: BidAcceptedActionEmailParams) {
  const payload = buildBidAcceptedActionEmail(params)
  await send(params.to, payload.subject, payload.html)
}

export async function sendBuyerAccessRecovery(params: {
  to: string
  taskTitle: string
  taskId: string
  buyerToken: string
}) {
  // The token lives in the URL fragment, which browsers do not send to the
  // web server or include in ordinary request logs. The buyer page consumes
  // it into localStorage and immediately removes it from the address bar.
  const accessUrl = `${BASE_URL}/buyer/tasks/${encodeURIComponent(params.taskId)}/bids#buyer_token=${encodeURIComponent(params.buyerToken)}`
  const safeTitle = escapeEmailHtml(params.taskTitle)
  await send(
    params.to,
    emailSubjectText(`Mercatai: restore buyer access to ${params.taskTitle}`),
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#4f46e5">Restore buyer access</h2>
      <p>A buyer-access link was requested for <strong>${safeTitle}</strong>.</p>
      <a href="${accessUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">Restore access</a>
      <p style="font-size:12px;color:#6b7280">This link grants task-scoped buyer access for 30 days. Do not forward it. If you did not request it, you can ignore this email.</p>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `,
  )
}

export interface TaskDeliveredBuyerEmailParams {
  to: string
  taskTitle: string
  taskId: string
  buyerToken: string
  reviewDeadlineAt: string
}

function formatEmailDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toUTCString()
}

/**
 * Sent to the task's buyer once a delivery is atomically recorded. It links
 * to the buyer review page (task-scoped buyer token in the URL fragment, the
 * same mechanism as sendTaskCreated/sendBuyerAccessRecovery) and states when
 * the payment becomes eligible for automatic release. The delivered work
 * itself is never put in the email — it stays behind the buyer-only API.
 */
export function buildTaskDeliveredBuyerEmail(params: TaskDeliveredBuyerEmailParams): { subject: string; html: string } {
  const reviewUrl = `${BASE_URL}/buyer/tasks/${encodeURIComponent(params.taskId)}/bids#buyer_token=${encodeURIComponent(params.buyerToken)}`
  const safeTitle = escapeEmailHtml(params.taskTitle)
  const safeDeadline = escapeEmailHtml(formatEmailDateTime(params.reviewDeadlineAt))
  return {
    subject: emailSubjectText(`Mercatai: work delivered for "${params.taskTitle}" — please review`),
    html: `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#4f46e5">Your task has been delivered</h2>
      <p>The assigned agent has delivered <strong>${safeTitle}</strong>. Open the task to read the delivered work, then approve it or report a quality issue.</p>
      <p><strong>Review deadline:</strong> ${safeDeadline}</p>
      <p>If you neither approve nor report a quality issue by then, the payment becomes eligible for automatic release to the agent (the daily release run may take up to 24 more hours).</p>
      <a href="${reviewUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">Review delivered work</a>
      <p style="font-size:12px;color:#6b7280">🔑 The button contains a private, task-scoped buyer access token valid for 30 days. Do not forward the link. Your browser stores the token locally and removes it from the address bar after opening it.</p>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `,
  }
}

export async function sendTaskDelivered(params: TaskDeliveredBuyerEmailParams) {
  const payload = buildTaskDeliveredBuyerEmail(params)
  await send(params.to, payload.subject, payload.html)
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
 * persisted. `to` IS the administrator's own email address — real PII,
 * not a credential — which is exactly why markAdminAlertSent clears the
 * stored snapshot back to NULL once the send is confirmed rather than
 * keeping it around indefinitely.
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
/**
 * Shared delivery mechanics for every critical, retryable admin alert
 * (payout failures, payment disputes, ...) — `alertKind` only affects
 * error-message wording, never behavior. See
 * sendPayoutFailedAdminAlertOrThrow and sendDisputeAdminAlertOrThrow
 * below for the two current callers; each keeps its own name so a
 * stack trace or log line still says which kind of alert failed.
 */
async function sendAdminAlertOrThrow(payload: FrozenAdminAlertPayload, idempotencyKey: string, alertKind: string): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error(`RESEND_API_KEY is not configured — a critical ${alertKind} alert cannot be delivered`)
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
      throw new Error(`Resend rejected the ${alertKind} alert — idempotency key reused with a different payload (invalid_idempotent_request): ${error.message}`)
    }
    if (error.name === 'concurrent_idempotent_requests') {
      // A different request with the SAME key is still being processed
      // by Resend right now — a genuinely transient, retryable state
      // (the caller's normal retry-via-lease path handles it like any
      // other failure), not a permanent rejection.
      throw new Error(`Resend is still processing a concurrent request with this idempotency key (concurrent_idempotent_requests): ${error.message}`)
    }
    throw new Error(`Resend rejected the ${alertKind} alert: ${error.message}`)
  }
  if (!data?.id) {
    throw new Error(`Resend accepted the ${alertKind} alert but returned no email id`)
  }
  return data.id
}

export async function sendPayoutFailedAdminAlertOrThrow(payload: FrozenAdminAlertPayload, idempotencyKey: string): Promise<string> {
  return sendAdminAlertOrThrow(payload, idempotencyKey, 'payout-failure')
}

/**
 * Delivers the charge.dispute.* admin alert, or throws — same
 * at-least-once, lease-retried, Resend-idempotency-keyed contract as
 * sendPayoutFailedAdminAlertOrThrow. See
 * frontend/lib/server/paymentDisputes.ts for the caller (ensureDisputeAdminAlertSent)
 * and frontend/sql/18_payment_charge_identity_and_disputes.sql for the
 * claim/lease table this backs.
 */
export async function sendDisputeAdminAlertOrThrow(payload: FrozenAdminAlertPayload, idempotencyKey: string): Promise<string> {
  return sendAdminAlertOrThrow(payload, idempotencyKey, 'payment-dispute')
}

/**
 * Builds the charge.dispute.* admin-alert email exactly as it would be
 * sent right now — same "build once at first claim, freeze forever"
 * contract as buildAdminAlertProviderPayload above. Throws if
 * ADMIN_ALERT_EMAIL is not configured, for the same reason: that failure
 * belongs to the first attempt that discovers it, not a later retry.
 * Never includes card data — only the dispute id, its Stripe status/
 * reason enum, and the amount.
 */
export function buildDisputeAdminAlertProviderPayload(params: {
  disputeId: string
  status: string
  reason: string | null
  amountLabel: string
  transactionId: string | null
  chargeId: string | null
}): FrozenAdminAlertPayload {
  const to = process.env.ADMIN_ALERT_EMAIL
  if (!to) {
    throw new Error('ADMIN_ALERT_EMAIL is not configured — a critical payment-dispute alert cannot be built')
  }
  return {
    from: FROM,
    to,
    subject: `⚠️ Stripe dispute ${params.status} — ${params.amountLabel}`,
    html: `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#dc2626">Payment dispute</h2>
      <p>A Stripe dispute of <strong>${params.amountLabel}</strong> is now <strong>${params.status}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:6px;color:#6b7280">Dispute ID</td><td style="padding:6px;font-weight:600"><code>${params.disputeId}</code></td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Reason</td><td style="padding:6px;font-weight:600">${params.reason ?? 'not provided'}</td></tr>
        <tr><td style="padding:6px;color:#6b7280">Charge</td><td style="padding:6px;font-weight:600">${params.chargeId ? `<code>${params.chargeId}</code>` : 'unknown'}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:6px;color:#6b7280">Mercatai transaction</td><td style="padding:6px;font-weight:600">${params.transactionId ?? 'no matching transaction found'}</td></tr>
      </table>
      <p style="font-size:12px;color:#6b7280">No card data is stored by Mercatai — check the Stripe Dashboard for full detail and to respond before the evidence deadline. This alert is informational only; Mercatai never automatically refunds or reverses a transfer in response to a dispute.</p>
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

/**
 * Sent to the assigned agent when a buyer reports a quality issue — see
 * frontend/sql/22_quality_issue_facilitation.sql. Without this, an agent
 * would only ever find out by polling GET /api/v1/tasks/{id}/issues.
 * Never includes the buyer's identity or the issue's message text —
 * those stay inside the private thread, reachable only with the agent's
 * own token.
 */
export async function sendQualityIssueOpened(params: { to: string; taskTitle: string; taskId: string }) {
  const taskTitle = escapeEmailHtml(params.taskTitle)
  await send(
    params.to,
    `A buyer reported a quality issue — "${emailSubjectText(params.taskTitle)}"`,
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#b45309">Quality issue reported</h2>
      <p>The buyer of <strong>${taskTitle}</strong> reported a quality issue with your delivery and opened a private message thread.</p>
      <p>This does not move or hold any money by itself. You can respond in the thread, and you may voluntarily accept a full refund if you agree with the buyer — Mercatai never decides this for either of you. If nothing is agreed before the review deadline, the platform's usual auto-release rule applies.</p>
      <a href="${BASE_URL}/agent/tasks/${params.taskId}/review"
         style="display:inline-block;background:#b45309;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        View and respond
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `
  )
}

/**
 * Sent to whichever side did NOT author a new quality-issue message, so
 * neither party is stuck polling the thread. Never includes the message
 * text or the other side's identity.
 */
export async function sendQualityIssueMessage(params: {
  to: string
  taskTitle: string
  taskId: string
  recipientRole: 'buyer' | 'agent'
}) {
  const taskTitle = escapeEmailHtml(params.taskTitle)
  const link = params.recipientRole === 'agent'
    ? `${BASE_URL}/agent/tasks/${params.taskId}/review`
    : `${BASE_URL}/buyer/tasks/${params.taskId}/bids`
  await send(
    params.to,
    `New message on the quality issue — "${emailSubjectText(params.taskTitle)}"`,
    `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#4f46e5">New message</h2>
      <p>There's a new reply on the quality-issue thread for <strong>${taskTitle}</strong>.</p>
      <a href="${link}"
         style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        View thread
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `
  )
}
