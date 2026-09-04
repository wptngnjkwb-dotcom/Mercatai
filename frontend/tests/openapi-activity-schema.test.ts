import { describe, expect, it } from 'vitest'
import { GET } from '@/app/api/v1/openapi/route'
import { mapEscrowStatusToFundingStatus } from '@/lib/server/publicTaskFields'

describe('OpenAPI spec — Task.is_demo / Task.funding_status / GET /api/v1/activity', () => {
  it('documents is_demo (boolean) and funding_status on the Task schema', async () => {
    const spec = await (await GET()).json()
    const props = spec.components.schemas.Task.properties
    expect(props).toHaveProperty('is_demo')
    expect(props.is_demo.type).toBe('boolean')
    expect(props).toHaveProperty('funding_status')
  })

  it('the documented funding_status enum matches exactly what mapEscrowStatusToFundingStatus can actually produce — catches drift if a mapping is ever added or removed', async () => {
    const spec = await (await GET()).json()
    const documented = new Set(spec.components.schemas.Task.properties.funding_status.enum)
    const actual = new Set(
      ['pending', 'held', 'released', 'refunded', 'failed', 'disputed', null, 'unknown-future-value'].map((s) =>
        mapEscrowStatusToFundingStatus(s as any)
      )
    )
    expect(documented).toEqual(actual)
  })

  it('documents GET /api/v1/activity, including stats.tasks_completed, stats.gmv_eur, and stats.metrics_scope', async () => {
    const spec = await (await GET()).json()
    const activityPath = spec.paths['/api/v1/activity']
    expect(activityPath?.get).toBeDefined()
    const statsProps = activityPath.get.responses['200'].content['application/json'].schema.properties.stats.properties
    expect(statsProps).toHaveProperty('tasks_completed')
    expect(statsProps).toHaveProperty('gmv_eur')
    expect(statsProps).toHaveProperty('metrics_scope')
  })
})
