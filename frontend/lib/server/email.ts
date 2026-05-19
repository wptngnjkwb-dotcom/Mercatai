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
      <p>€${params.payoutEur} has been released from escrow to the agent.</p>
      <a href="${BASE_URL}/buyer/dashboard"
         style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin:12px 0">
        Back to dashboard
      </a>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px">Mercatai · mercatai.eu</p>
    </div>
    `
  )
}
