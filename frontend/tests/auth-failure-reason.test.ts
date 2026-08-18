import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { SignJWT } from 'jose'
import { signToken, getTokenFromRequest, describeAuthFailure } from '@/lib/server/auth'

// Real jose verification, not mocked — this exercises the actual failure
// classification a caller sees, not a stand-in for it.
process.env.JWT_SECRET_KEY = 'test-secret-for-auth-failure-classification-32ch'

function requestWithAuth(header?: string) {
  return new NextRequest('http://localhost/api/v1/bids', {
    headers: header ? { authorization: header } : {},
  })
}

describe('getTokenFromRequest / describeAuthFailure', () => {
  it('reports missing_token when there is no Authorization header', async () => {
    const request = requestWithAuth()
    expect(await getTokenFromRequest(request)).toBeNull()
    expect(await describeAuthFailure(request)).toBe('missing_token')
  })

  it('reports missing_token when the header is not a Bearer token', async () => {
    const request = requestWithAuth('Basic dXNlcjpwYXNz')
    expect(await describeAuthFailure(request)).toBe('missing_token')
  })

  it('reports invalid_token for a garbage token', async () => {
    const request = requestWithAuth('Bearer not-a-real-jwt')
    expect(await getTokenFromRequest(request)).toBeNull()
    expect(await describeAuthFailure(request)).toBe('invalid_token')
  })

  it('reports invalid_token for a well-formed JWT signed with the wrong secret', async () => {
    const wrongSecret = new TextEncoder().encode('a-completely-different-secret-32ch')
    const forged = await new SignJWT({ agent_id: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(wrongSecret)

    const request = requestWithAuth(`Bearer ${forged}`)
    expect(await getTokenFromRequest(request)).toBeNull()
    expect(await describeAuthFailure(request)).toBe('invalid_token')
  })

  it('reports token_expired for a token past its exp claim — this is the reported bug', async () => {
    const expired = await signToken({ agent_id: 'x' }, Math.floor(Date.now() / 1000) - 10)
    const request = requestWithAuth(`Bearer ${expired}`)

    expect(await getTokenFromRequest(request)).toBeNull()
    expect(await describeAuthFailure(request)).toBe('token_expired')
  })

  it('rejects a refresh token used as an access token — the actual security bug', async () => {
    // Same shape /auth/login issues: a validly-signed, non-expired JWT that
    // just happens to carry type: 'refresh'. Before this fix it passed
    // getTokenFromRequest like any other token, letting a 7-day refresh
    // token stand in for a 15-minute access token on every protected route.
    const refreshToken = await signToken({ agent_id: 'x', type: 'refresh' }, '7d')
    const request = requestWithAuth(`Bearer ${refreshToken}`)

    expect(await getTokenFromRequest(request)).toBeNull()
    // Classified as invalid_token, not a distinct "that's a refresh token"
    // reason — the failure taxonomy must not reveal internal token shape.
    expect(await describeAuthFailure(request)).toBe('invalid_token')
  })

  it('does not misreport a currently valid access token as a failure reason', async () => {
    const valid = await signToken({ agent_id: 'x' }, '15m')
    const request = requestWithAuth(`Bearer ${valid}`)

    expect(await getTokenFromRequest(request)).not.toBeNull()
  })
})
