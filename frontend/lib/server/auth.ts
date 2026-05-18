import { SignJWT, jwtVerify } from 'jose'
import { NextRequest } from 'next/server'

function getSecret() {
  const key = process.env.JWT_SECRET_KEY
  if (!key) throw new Error('JWT_SECRET_KEY environment variable is not set')
  return new TextEncoder().encode(key)
}

export async function signToken(payload: Record<string, unknown>, expiresIn = '15m') {
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

export async function getTokenFromRequest(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  try {
    return await verifyToken(auth.slice(7))
  } catch {
    return null
  }
}
