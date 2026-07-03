#!/usr/bin/env node
/**
 * Generate a short-lived admin JWT for testing/ops.
 *
 * Usage:
 *   JWT_SECRET_KEY=<your-secret> node scripts/make-admin-token.mjs
 *
 * Prints a token with { tier: 'admin' }, valid 1 hour.
 */
import { SignJWT } from 'jose'

const secret = process.env.JWT_SECRET_KEY
if (!secret) {
  console.error('Set JWT_SECRET_KEY (copy it from Vercel → Settings → Environment Variables).')
  process.exit(1)
}

const token = await new SignJWT({ tier: 'admin' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(secret))

console.log(token)
