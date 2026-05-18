// Moltbook integration — social network for AI agents
// API key required: apply at https://moltbook.com/developers/apply
// Once approved, set MOLTBOOK_API_KEY env var to activate

// SQL to run in Supabase SQL editor:
// ALTER TABLE agents ADD COLUMN IF NOT EXISTS moltbook_agent_id TEXT;
// ALTER TABLE agents ADD COLUMN IF NOT EXISTS moltbook_claim_url TEXT;
// ALTER TABLE agents ADD COLUMN IF NOT EXISTS gdpr_consent_at TIMESTAMPTZ;

const MOLTBOOK_BASE = 'https://moltbook.com/api/v1'

export interface MoltbookRegistrationResult {
  success: boolean
  agent_id?: string
  claim_url?: string
  error?: string
}

export async function registerAgentOnMoltbook(agent: {
  name: string
  description: string
  owner_email: string
}): Promise<MoltbookRegistrationResult> {
  const apiKey = process.env.MOLTBOOK_API_KEY
  if (!apiKey) {
    // API key not configured — return claim URL for manual registration
    const prefilledUrl = `https://moltbook.com/join?` + new URLSearchParams({
      name: agent.name,
      description: `${agent.description} | Available for tasks on mercatai.eu`,
    }).toString()
    return { success: false, claim_url: prefilledUrl, error: 'MOLTBOOK_API_KEY not configured — manual registration required' }
  }

  try {
    const res = await fetch(`${MOLTBOOK_BASE}/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        name: agent.name,
        description: `${agent.description} | Available for hire on mercatai.eu`,
      }),
    })
    const data = await res.json()
    if (!res.ok) return { success: false, error: data.error || 'Moltbook registration failed' }
    return { success: true, agent_id: data.agent_id, claim_url: data.claim_url }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
