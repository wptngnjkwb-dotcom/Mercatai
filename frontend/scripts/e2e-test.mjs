#!/usr/bin/env node
/**
 * Mercatai end-to-end test for the marketplace growth features.
 *
 * Usage:
 *   BASE_URL=https://...vercel.app node scripts/e2e-test.mjs
 *
 * Optional env:
 *   BYPASS=<vercel-protection-bypass-secret>   # if preview is SSO-protected
 *   ADMIN_TOKEN=<admin JWT>                     # enables the full agent + auto-bid flow
 *
 * Read-only checks run without any secrets. The agent/auto-bid/SLA flow runs
 * only when ADMIN_TOKEN is provided (needed to approve a fresh test agent).
 */

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const BYPASS = process.env.BYPASS || ''
const ADMIN = process.env.ADMIN_TOKEN || ''

let pass = 0, fail = 0
const log = (ok, name, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

function H(extra = {}) {
  return { 'Content-Type': 'application/json', ...(BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {}), ...extra }
}
async function req(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: H(headers), ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = null }
  return { status: r.status, json, text }
}

const rnd = Math.random().toString(36).slice(2, 8)

async function main() {
  console.log(`\n=== Mercatai E2E — ${BASE} ===\n`)

  // 1. Activity feed
  {
    const r = await req('GET', '/api/v1/activity')
    const ok = r.status === 200 && r.json && r.json.stats && Array.isArray(r.json.events)
    log(ok, 'GET /activity', ok ? `tasks=${r.json.stats.tasks_total} bids=${r.json.stats.bids_total} agents=${r.json.stats.agents_active} events=${r.json.events.length}` : `status ${r.status}`)
  }

  // 2. Recommendations + Mercatai Score
  let sampleAgentId = null
  {
    const r = await req('GET', '/api/v1/agents/recommend?limit=5')
    const recs = r.json?.recommendations
    const ok = r.status === 200 && Array.isArray(recs)
    const scored = ok && recs.every(a => a.mercatai_score && typeof a.mercatai_score.score === 'number')
    if (ok && recs[0]) sampleAgentId = recs[0].id
    log(ok && (recs.length === 0 || scored), 'GET /agents/recommend', ok ? `${recs.length} agents${recs[0] ? `, top score=${recs[0].mercatai_score.score} (${recs[0].mercatai_score.grade})` : ''}` : `status ${r.status}`)
  }

  // 3. Agent detail carries Mercatai Score
  if (sampleAgentId) {
    const r = await req('GET', `/api/v1/agents/${sampleAgentId}`)
    const ok = r.status === 200 && r.json?.mercatai_score && typeof r.json.mercatai_score.score === 'number'
    log(ok, 'GET /agents/:id (score)', ok ? `score=${r.json.mercatai_score.score} components=${r.json.mercatai_score.components.length}` : `status ${r.status}`)
  } else {
    console.log('⏭️  GET /agents/:id — skipped (no agents in DB)')
  }

  // 4. Page loads
  for (const p of ['/en/try', '/en/live', '/en/marketplace', '/en/buyer/tasks/new']) {
    const r = await req('GET', p)
    log(r.status === 200, `page ${p}`, `status ${r.status}`)
  }

  // 5. Task creation triggers auto-bid path (write — creates one [E2E] task)
  let taskId = null, buyerToken = null
  {
    const r = await req('POST', '/api/v1/tasks', {
      title: `[E2E ${rnd}] Translate a short paragraph EN→DE`,
      description: 'Automated end-to-end test task — safe to delete.',
      category: 'translation',
      required_capabilities: ['translation'],
      required_languages: ['en', 'de'],
      budget_min_eur: 20, budget_max_eur: 50, deadline_hours: 24,
      org_name: `e2e-${rnd}`,
    })
    const ok = r.status === 201 && r.json?.id
    if (ok) { taskId = r.json.id; buyerToken = r.json.buyer_token }
    log(ok, 'POST /tasks (auto-bid path runs)', ok ? `task=${taskId.slice(0,8)} status=${r.json.status}` : `status ${r.status} ${r.text.slice(0,80)}`)
  }

  // 6. Bids endpoint returns enriched shape (+ any auto-bids)
  if (taskId) {
    await new Promise(r => setTimeout(r, 1500))
    const r = await req('GET', `/api/v1/tasks/${taskId}/bids`)
    const ok = r.status === 200 && Array.isArray(r.json?.bids)
    const n = ok ? r.json.bids.length : 0
    const enriched = n === 0 || r.json.bids.every(b => 'agent_mercatai_score' in b || 'agent_badges' in b)
    log(ok && enriched, 'GET /tasks/:id/bids', ok ? `${n} bid(s)${n ? ` (auto-bid fired — incl. score: ${!!r.json.bids[0].agent_mercatai_score})` : ' (no active agents w/ matching rules — expected)'}` : `status ${r.status}`)
  }

  // ── Full agent flow (needs ADMIN_TOKEN to approve a fresh agent) ──────────
  if (ADMIN) {
    console.log('\n--- Authenticated agent flow (ADMIN_TOKEN provided) ---')
    const slug = `e2e-agent-${rnd}`
    let agentUuid = null, apiKey = null, token = null

    {
      const r = await req('POST', '/api/v1/agents', {
        agent_id: slug, display_name: `E2E Agent ${rnd}`, description: 'E2E test agent',
        capabilities: ['translation'], languages: ['en', 'de'], gdpr_consent: true,
      })
      const ok = r.status === 201 && r.json?.api_key
      if (ok) { agentUuid = r.json.id; apiKey = r.json.api_key }
      log(ok, 'POST /agents (register)', ok ? `id=${agentUuid.slice(0,8)}` : `status ${r.status}`)
    }
    if (agentUuid) {
      const r = await req('PUT', `/api/v1/agents/${agentUuid}/approve`, {}, { Authorization: `Bearer ${ADMIN}` })
      log(r.status === 200, 'PUT /agents/:id/approve (admin)', `status ${r.status}`)
    }
    if (agentUuid && apiKey) {
      const r = await req('POST', '/api/v1/auth/login', { agent_id: slug, api_key: apiKey })
      const ok = r.status === 200 && r.json?.access_token
      if (ok) token = r.json.access_token
      log(ok, 'POST /auth/login', ok ? 'got access_token' : `status ${r.status}`)
    }
    if (token) {
      const auth = { Authorization: `Bearer ${token}` }
      let ruleId = null
      {
        const r = await req('POST', `/api/v1/agents/${agentUuid}/autobid`, {
          label: 'E2E EN→DE', category: 'translation', capabilities: ['translation'],
          max_price_eur: 45, price_strategy: 'min', delivery_hours: 6, proposal: 'E2E auto-bid',
        }, auth)
        const ok = r.status === 201 && r.json?.id
        if (ok) ruleId = r.json.id
        log(ok, 'POST /autobid (create rule)', ok ? `rule=${ruleId.slice(0,8)}` : `status ${r.status} ${r.text.slice(0,80)}`)
      }
      {
        const r = await req('GET', `/api/v1/agents/${agentUuid}/autobid`, null, auth)
        log(r.status === 200 && r.json?.rules?.length >= 1, 'GET /autobid (list)', `${r.json?.rules?.length ?? 0} rule(s)`)
      }
      {
        const r = await req('PUT', `/api/v1/agents/${agentUuid}/webhook`, { url: 'https://example.com/hook' }, auth)
        log(r.status === 200 && r.json?.secret, 'PUT /webhook', r.json?.secret ? 'secret issued' : `status ${r.status}`)
      }
      {
        const r = await req('GET', `/api/v1/agents/${agentUuid}/earnings`, null, auth)
        const ok = r.status === 200 && r.json?.summary
        log(ok, 'GET /earnings', ok ? `released=€${r.json.summary.total_released_eur} pending=€${r.json.summary.total_pending_eur}` : `status ${r.status}`)
      }
      // Auto-bid firing: new matching task should now get a bid from this active agent
      {
        const r = await req('POST', '/api/v1/tasks', {
          title: `[E2E ${rnd}] Auto-bid trigger task`, description: 'E2E auto-bid firing test — safe to delete.',
          category: 'translation', required_capabilities: ['translation'], required_languages: ['en','de'],
          budget_min_eur: 20, budget_max_eur: 50, deadline_hours: 24, org_name: `e2e-fire-${rnd}`,
        })
        if (r.status === 201) {
          await new Promise(r => setTimeout(r, 2000))
          const b = await req('GET', `/api/v1/tasks/${r.json.id}/bids`)
          const mine = (b.json?.bids || []).find(x => x.agent_id === agentUuid)
          log(!!mine, 'auto-bid FIRED for active agent', mine ? `price=€${mine.price_eur} score=${mine.agent_mercatai_score?.score}` : 'no bid from test agent')
        } else {
          log(false, 'auto-bid firing task', `create status ${r.status}`)
        }
      }
    }
  } else {
    console.log('\n⏭️  Skipping authenticated agent flow + auto-bid firing (no ADMIN_TOKEN).')
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
