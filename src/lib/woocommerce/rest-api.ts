import { assertStoreUrlDeliverable, normalizeStoreUrl } from './store-url'
import type { WooProduct } from './store-api'

const DEFAULT_TIMEOUT_MS = 8_000
const BLURB_MAX = 240

interface RestAttribute {
  name?: string
  options?: string[]
  option?: string
}

interface RestCategory {
  name?: string
}

export interface RestProductRaw {
  id?: number
  name?: string
  permalink?: string
  price?: string
  regular_price?: string
  sale_price?: string
  stock_status?: string
  short_description?: string
  attributes?: RestAttribute[]
  categories?: RestCategory[]
}

/** Basic auth header. The secret is never placed on the URL. */
export function restAuthorizationHeader(
  consumerKey: string,
  consumerSecret: string,
): string {
  const token = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')
  return `Basic ${token}`
}

export function buildRestProductsUrl(
  storeUrl: string,
  args: { search?: string; perPage: number; inStockOnly?: boolean; page?: number },
): URL {
  const url = new URL(`${normalizeStoreUrl(storeUrl)}/wp-json/wc/v3/products`)
  url.searchParams.set('per_page', String(args.perPage))
  if (args.page && args.page > 1) url.searchParams.set('page', String(args.page))
  url.searchParams.set('status', 'publish')
  if (args.search?.trim()) url.searchParams.set('search', args.search.trim())
  if (args.inStockOnly) url.searchParams.set('stock_status', 'instock')
  return url
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function attrValues(attributes: RestAttribute[] | undefined, names: string[]): string[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const attr = (attributes ?? []).find((a) => wanted.has((a.name ?? '').toLowerCase()))
  if (!attr) return []
  if (Array.isArray(attr.options) && attr.options.length > 0) {
    return attr.options.map((o) => String(o).trim()).filter(Boolean)
  }
  if (attr.option && attr.option.trim()) return [attr.option.trim()]
  return []
}

function restPriceAmount(raw: RestProductRaw): number | null {
  const value = raw.price || raw.sale_price || raw.regular_price
  if (!value) return null
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

export function mapRestProduct(raw: RestProductRaw): WooProduct | null {
  if (typeof raw.id !== 'number' || !raw.name || !raw.permalink) return null
  const size = attrValues(raw.attributes, ['size'])[0] ?? null
  const colors = attrValues(raw.attributes, ['color', 'colour'])
  const thread = attrValues(raw.attributes, ['thread count', 'thread-count'])[0] ?? null
  const categories = (raw.categories ?? [])
    .map((c) => c.name?.trim())
    .filter((n): n is string => !!n)
  const amount = restPriceAmount(raw)
  const blurb = raw.short_description
    ? stripHtml(raw.short_description).slice(0, BLURB_MAX)
    : null
  const attributeBits = [
    colors.length > 0 ? `Color: ${colors.join(', ')}` : null,
    categories.length > 0 ? `Categories: ${categories.slice(0, 2).join(', ')}` : null,
  ].filter(Boolean)
  return {
    id: raw.id,
    name: raw.name,
    permalink: raw.permalink,
    priceLabel: amount == null ? 'Price unavailable' : `$${amount.toFixed(2)}`,
    priceAmount: amount,
    size,
    sizeSlug: size ? size.toLowerCase().replace(/\s+/g, '-') : null,
    threadCount: thread,
    inStock: raw.stock_status !== 'outofstock',
    color: colors[0]?.toLowerCase() ?? null,
    attributesLine: attributeBits.length > 0 ? attributeBits.join(' | ') : null,
    blurb: blurb || null,
  }
}

export interface SearchRestProductsArgs {
  storeUrl: string
  consumerKey: string
  consumerSecret: string
  search?: string
  perPage?: number
  /** 1-based page for paginated reads. */
  page?: number
  inStockOnly?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Live product read against WooCommerce REST API v3.
 * Authenticated with HTTP Basic — credentials are not put in the query.
 */
export async function searchRestProducts(
  args: SearchRestProductsArgs,
): Promise<WooProduct[]> {
  const page = await fetchRestProductPage({
    ...args,
    perPage: Math.min(50, Math.max(1, args.perPage ?? 20)),
  })
  return page.products
}

/** One page of REST v3 products (`per_page` up to 100). */
export async function fetchRestProductPage(
  args: SearchRestProductsArgs,
): Promise<{ products: WooProduct[]; totalPages: number }> {
  const storeUrl = normalizeStoreUrl(args.storeUrl)
  if (!storeUrl.startsWith('https://')) {
    throw new Error('WooCommerce REST API requires https')
  }
  await assertStoreUrlDeliverable(storeUrl)

  const perPage = Math.min(100, Math.max(1, args.perPage ?? 20))
  const url = buildRestProductsUrl(storeUrl, {
    search: args.search,
    perPage,
    inStockOnly: args.inStockOnly,
    page: args.page,
  })

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  args.signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: restAuthorizationHeader(args.consumerKey, args.consumerSecret),
      },
      signal: controller.signal,
      redirect: 'manual',
    })
    if (!res.ok) {
      throw new Error(`WooCommerce REST API returned ${res.status}`)
    }
    const totalPages = Math.max(1, Number(res.headers.get('x-wp-totalpages')) || 1)
    const json = (await res.json()) as unknown
    if (!Array.isArray(json)) return { products: [], totalPages }
    const out: WooProduct[] = []
    for (const row of json) {
      const mapped = mapRestProduct(row as RestProductRaw)
      if (mapped) out.push(mapped)
    }
    return { products: out, totalPages }
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener('abort', onAbort)
  }
}

export async function probeRestApi(
  storeUrl: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<void> {
  await searchRestProducts({
    storeUrl,
    consumerKey,
    consumerSecret,
    perPage: 1,
    timeoutMs: 10_000,
  })
}
