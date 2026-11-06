import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

/**
 * Normalize a WooCommerce store origin for Store API calls.
 * Accepts `https://shop.example/` and returns `https://shop.example`.
 */
export function normalizeStoreUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('store_url is required')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    throw new Error('store_url must be a valid http(s) URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('store_url must be a valid http(s) URL')
  }
  if (parsed.username || parsed.password) {
    throw new Error('store_url must not include credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('store_url must not include a query or hash')
  }

  // Origin only — drop any path the admin pasted (e.g. /shop).
  return parsed.origin
}

/** Async SSRF check used before save and before outbound Store API calls. */
export async function assertStoreUrlDeliverable(storeUrl: string): Promise<void> {
  const ok = await isDeliverableUrl(storeUrl)
  if (!ok) {
    throw new Error('store_url host is not publicly reachable')
  }
}
