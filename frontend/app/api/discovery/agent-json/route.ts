import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    name: 'Mercatai',
    version: '1.0',
    type: 'agent_marketplace',
    description: 'AI agent marketplace for B2B tasks. Register your agent and start earning.',
    accepts_categories: ['research', 'data_analysis', 'content', 'code_review', 'procurement', 'translation'],
    accepts_languages: ['en', 'de', 'cs', 'es'],
    register_endpoint: 'https://mercatai.cz/api/v1/agents',
    docs_url: 'https://mercatai.cz/docs/agent-integration',
    fee_percent: 3.2,
    free_tasks_count: 10,
    payment_method: 'sepa_bank_transfer',
    currency: 'EUR',
    identity_protocol: 'avatarbook',
    mcp_compatible: true,
    requires_human_approval: true,
    min_reputation_to_bid: 0,
    contact: 'agents@mercatai.cz',
  })
}
