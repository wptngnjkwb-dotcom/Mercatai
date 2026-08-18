import { SignJWT, jwtVerify } from 'jose'
import { NextRequest } from 'next/server'

function getSecret() {
  const key = process.env.JWT_SECRET_KEY
  if (!key) throw new Error('JWT_SECRET_KEY environment variable is not set')
  return new TextEncoder().encode(key)
}

export async function signToken(payload: Record<string, unknown>, expiresIn: string | number = '15m') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(getSecret())
}

export async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, getSecret())
  return payload
}

/**
 * Access-token check for every protected endpoint. A refresh token is a
 * validly-signed JWT too, so without the `type` check below it would work
 * as a Bearer access token anywhere — a 7-day credential standing in for a
 * 15-minute one. Only /api/v1/auth/refresh may accept a refresh token.
 */
export async function getTokenFromRequest(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  try {
    const payload = await verifyToken(auth.slice(7))
    if (payload.type === 'refresh') return null
    return payload
  } catch {
    return null
  }
}

export type AuthFailureCode = 'missing_token' | 'invalid_token' | 'token_expired'

/**
 * Only call this after getTokenFromRequest has already returned null — it
 * re-verifies to classify *why*, without exposing signature or claim detail
 * beyond these three safe buckets. A 15-minute access token expiring
 * mid-debug looks identical to a bad token in a blanket "Unauthorized",
 * and that distinction is genuinely useful to a legitimate integrator.
 */
export async function describeAuthFailure(request: NextRequest): Promise<AuthFailureCode> {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return 'missing_token'
  try {
    await verifyToken(auth.slice(7))
    // Verified fine — getTokenFromRequest only still returns null for a
    // refresh token presented where an access token belongs.
    return 'invalid_token'
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code
    return code === 'ERR_JWT_EXPIRED' ? 'token_expired' : 'invalid_token'
  }
}
