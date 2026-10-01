import dns from 'dns'
import net from 'net'

/**
 * Blocks webhook URLs that resolve to private/internal/reserved addresses
 * (loopback, RFC1918, link-local incl. cloud metadata 169.254.169.254,
 * CGNAT, IPv6 ULA/link-local). The server fetches these URLs itself on
 * every subscribed event, so an unrestricted URL is a standing SSRF
 * primitive against internal infrastructure.
 */

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true
  const [a, b, c] = parts
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // protocol assignments + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast and reserved/future-use space
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe8') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('ff')) return true // multicast
  if (normalized.startsWith('2001:db8:')) return true // documentation prefix
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check the embedded IPv4
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIPv4(mapped[1])
  return false
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip)
  if (net.isIPv6(ip)) return isPrivateIPv6(ip)
  return true // unrecognized format — fail closed
}

export async function validateWebhookUrl(rawUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, error: 'url must be a valid HTTP/HTTPS URL' }
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    return { ok: false, error: 'url must be a valid HTTP/HTTPS URL' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'url must not contain embedded credentials' }
  }

  const hostname = parsed.hostname.toLowerCase()
  if (
    hostname === 'localhost'
    || (!net.isIP(hostname) && !hostname.includes('.'))
    || ['.localhost', '.local', '.internal', '.lan', '.home', '.corp'].some((suffix) => hostname.endsWith(suffix))
  ) {
    return { ok: false, error: 'url must not point to a local/internal host' }
  }

  let addresses: string[]
  try {
    const results = await dns.promises.lookup(hostname, { all: true, verbatim: true })
    addresses = results.map((r) => r.address)
  } catch {
    return { ok: false, error: 'url host could not be resolved' }
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    return { ok: false, error: 'url must not point to a private/internal address' }
  }

  return { ok: true }
}
