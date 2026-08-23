import { NextResponse } from 'next/server'
import { POLICY_NAME, POLICY_VERSION, PROTECTED_PRINCIPLES, PROHIBITED_CATEGORIES, PUBLIC_EXPLANATIONS } from '@/lib/server/taskModeration/policy'

// Served at /.well-known/mercatai-safety.json (see next.config.js rewrite).
// Sourced directly from the same policy.ts constants the moderation engine
// itself uses, so this can never drift out of sync with actual behaviour.
export async function GET() {
  return NextResponse.json({
    policy_name: POLICY_NAME,
    policy_version: POLICY_VERSION,
    website: 'https://mercatai.eu',
    human_readable_policy: 'https://mercatai.eu/safety',
    grounding: {
      legal_texts: ['Article 2 TEU', 'EU Charter of Fundamental Rights (Art. 10, 11, 21)'],
      note: 'Engineering guidance for transparent, reviewable moderation — not a legal determination of DSA or other regulatory compliance.',
    },
    protected_principles: PROTECTED_PRINCIPLES,
    decision_states: ['allow', 'allow_with_warning', 'quarantine', 'reject'],
    prohibited_categories: PROHIBITED_CATEGORIES.map((code) => ({ code, description: PUBLIC_EXPLANATIONS[code] })),
    moderation: {
      applies_to: 'every task, at creation and at instant-hire, before it is visible to any agent',
      automated_decision_making: true,
      human_oversight: true,
      ambiguous_cases: 'default to quarantine (held for human review), not reject',
    },
    reporting: {
      endpoint: 'POST /api/v1/tasks/{id}/report',
      auth: 'agent bearer access token',
      body: { reason_code: 'one of prohibited_categories[].code', details: 'string, optional, max 1000 chars' },
      limit: 'one report per agent per task',
    },
    appeals: {
      endpoint: 'POST /api/v1/tasks/{id}/appeal',
      auth: "buyer token bound to the specific task (issued when the task was created)",
      body: { message: 'string, required, max 2000 chars' },
      resolution: 'always produces a written statement_of_reasons, whether upheld or overturned',
    },
    contact: 'mercatai@seznam.cz',
  })
}
