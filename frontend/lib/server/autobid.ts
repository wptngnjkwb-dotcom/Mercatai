/**
 * Auto-bidding engine.
 *
 * When a task is posted, agents with matching auto-bid rules automatically
 * submit a competitive bid — and agents with a registered webhook URL get
 * pushed a `task.matched` notification (so they never have to poll).
 *
 * Fully fire-and-forget safe: every path is wrapped so a failure (e.g. the
 * auto_bid_rules table not migrated yet) never breaks task creation.
 */

import crypto from 'crypto'
import { getSupabase } from './supabase'

interface TaskRow {
  id: string
  title: string
  category: string
  required_capabilities: string[] | null
  required_languages: string[] | null
  budget_min_eur: number | null
  budget_max_eur: number
  deadline_hours: number
}

interface AutoBidRule {
  id: string
  agent_id: string
  category: string | null
  capabilities: string[] | null
  min_budget_eur: number | null
  max_price_eur: number
  price_strategy: 'min' | 'mid' | 'max' | string
  delivery_hours: number
  proposal: string | null
  sample_preview: string | null
  is_active: boolean
  max_bids_per_day: number | null
}

/** Bid scoring — kept in sync with app/api/v1/bids/route.ts. */
function scoreBid(
  bid: { price_eur: number; delivery_hours: number; agent_reputation: number },
  task: { budget_max_eur: number; deadline_hours: number },
) {
  const rep = bid.agent_reputation / 100
  const price = task.budget_max_eur > 0 ? Math.max(0, 1 - bid.price_eur / task.budget_max_eur) : 0
  const speed = task.deadline_hours > 0 ? Math.max(0, 1 - bid.delivery_hours / task.deadline_hours) : 0
  return rep * 0.5 + price * 0.3 + speed * 0.2
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function arraysOverlap(a: string[], b: string[]) {
  return a.some(x => b.includes(x))
}

function computePrice(rule: AutoBidRule, task: TaskRow): number | null {
  const floor = Math.max(1, task.budget_min_eur ?? 0)
  const ceil = Math.min(rule.max_price_eur, task.budget_max_eur)
  if (ceil < floor) return null // our cap is below the task's floor — can't bid sensibly
  switch (rule.price_strategy) {
    case 'max': return round2(ceil)
    case 'mid': return round2((floor + ceil) / 2)
    case 'min':
    default:    return round2(floor)
  }
}

/** Fire a signed `task.matched` notification to an agent's webhook URL. */
async function notifyAgent(url: string, secret: string | null, payload: object): Promise<void> {
  try {
    const body = JSON.stringify(payload)
    const signature = secret
      ? 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
      : undefined
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mercatai-Event': 'task.matched',
        'User-Agent': 'Mercatai-Webhook/1.0',
        ...(signature ? { 'X-Mercatai-Signature': signature } : {}),
      },
      body,
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    // best-effort
  }
}

/**
 * Run auto-bidding + push notifications for a freshly created task.
 * Safe to await from the task-creation handler.
 */
export async function runAutoBids(task: TaskRow): Promise<{ bids_placed: number; agents_notified: number }> {
  let bidsPlaced = 0
  let agentsNotified = 0

  try {
    const db = getSupabase()

    // 1. Pull active rules that match this task's category (or any-category rules)
    const { data: rules, error } = await db
      .from('auto_bid_rules')
      .select('*')
      .eq('is_active', true)
      .or(`category.is.null,category.eq.${task.category}`)

    if (error || !rules || rules.length === 0) return { bids_placed: 0, agents_notified: 0 }

    const taskCaps = task.required_capabilities ?? []

    // 2. Filter rules by capability overlap + budget threshold + valid price
    const candidates = (rules as AutoBidRule[]).filter(rule => {
      if ((rule.min_budget_eur ?? 0) > task.budget_max_eur) return false
      const caps = rule.capabilities ?? []
      if (caps.length > 0 && taskCaps.length > 0 && !arraysOverlap(caps, taskCaps)) return false
      if (caps.length > 0 && taskCaps.length === 0) return false
      return computePrice(rule, task) !== null
    })

    if (candidates.length === 0) return { bids_placed: 0, agents_notified: 0 }

    // 3. Load the agents behind those rules (one query)
    const agentIds = Array.from(new Set(candidates.map(r => r.agent_id)))
    const { data: agents } = await db
      .from('agents')
      .select('id, reputation_score, is_active, webhook_url, webhook_secret')
      .in('id', agentIds)

    const agentMap = new Map((agents ?? []).map((a: any) => [a.id, a]))

    // 4. Which of these agents already bid on this task? (avoid duplicates)
    const { data: existingBids } = await db
      .from('bids')
      .select('agent_id')
      .eq('task_id', task.id)
      .in('agent_id', agentIds)
    const alreadyBid = new Set((existingBids ?? []).map((b: any) => b.agent_id))

    // 5. Daily-cap usage per agent (bids in the last 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const dailyCount = new Map<string, number>()
    await Promise.all(agentIds.map(async id => {
      const { count } = await db
        .from('bids')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', id)
        .gte('submitted_at', since)
      dailyCount.set(id, count ?? 0)
    }))

    // 6. Pick the single best rule per agent (lowest computed price wins)
    const bestRulePerAgent = new Map<string, { rule: AutoBidRule; price: number }>()
    for (const rule of candidates) {
      const price = computePrice(rule, task)!
      const cur = bestRulePerAgent.get(rule.agent_id)
      if (!cur || price < cur.price) bestRulePerAgent.set(rule.agent_id, { rule, price })
    }

    // 7. Build bid rows + collect agents to notify
    const bidRows: any[] = []
    const toNotify: Array<{ url: string; secret: string | null }> = []

    for (const [agentId, { rule, price }] of Array.from(bestRulePerAgent)) {
      const agent = agentMap.get(agentId)
      if (!agent || !agent.is_active) continue
      if (alreadyBid.has(agentId)) continue
      if ((dailyCount.get(agentId) ?? 0) >= (rule.max_bids_per_day ?? 20)) continue

      const deliveryHours = Math.max(1, Math.min(rule.delivery_hours, task.deadline_hours))
      const score = scoreBid(
        { price_eur: price, delivery_hours: deliveryHours, agent_reputation: agent.reputation_score ?? 50 },
        { budget_max_eur: task.budget_max_eur, deadline_hours: task.deadline_hours },
      )

      bidRows.push({
        task_id: task.id,
        agent_id: agentId,
        price_eur: price,
        delivery_hours: deliveryHours,
        approach_summary: rule.proposal || 'Auto-bid: I match the required capabilities and can deliver within your deadline.',
        sample_preview: rule.sample_preview || null,
        score,
        status: 'pending',
        auto_bid_rule_id: rule.id,
      })

      if (agent.webhook_url) {
        toNotify.push({ url: agent.webhook_url, secret: agent.webhook_secret })
      }
    }

    // 8. Insert all bids in one batch
    if (bidRows.length > 0) {
      const { error: insErr } = await db.from('bids').insert(bidRows)
      if (!insErr) {
        bidsPlaced = bidRows.length
        // Move task into bidding state
        await db.from('tasks').update({ status: 'bidding' }).eq('id', task.id).eq('status', 'open')
      } else {
        // Retry without the optional auto_bid_rule_id column (in case migration not applied)
        const fallback = bidRows.map(({ auto_bid_rule_id, ...rest }) => rest)
        const { error: insErr2 } = await db.from('bids').insert(fallback)
        if (!insErr2) {
          bidsPlaced = fallback.length
          await db.from('tasks').update({ status: 'bidding' }).eq('id', task.id).eq('status', 'open')
        }
      }
    }

    // 9. Fire push notifications (best-effort, bounded)
    const payload = {
      event: 'task.matched',
      created_at: new Date().toISOString(),
      data: {
        task_id: task.id,
        title: task.title,
        category: task.category,
        budget_max_eur: task.budget_max_eur,
        deadline_hours: task.deadline_hours,
        required_capabilities: taskCaps,
      },
    }
    await Promise.allSettled(toNotify.map(n => notifyAgent(n.url, n.secret, payload)))
    agentsNotified = toNotify.length
  } catch {
    // never throw — auto-bidding must not break task creation
  }

  return { bids_placed: bidsPlaced, agents_notified: agentsNotified }
}
