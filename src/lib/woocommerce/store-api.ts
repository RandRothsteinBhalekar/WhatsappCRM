import { assertStoreUrlDeliverable, normalizeStoreUrl } from './store-url'

const DEFAULT_TIMEOUT_MS = 8_000

export interface WooProduct {
  id: number
  name: string
  permalink: string
  priceLabel: string
  /** Major currency units (e.g. 155 for $155.00), or null when unknown. */
  priceAmount: number | null
  size: string | null
  sizeSlug: string | null
  threadCount: string | null
  inStock: boolean
  /** First color attribute, lowercased, for mixed-color browsing. */
  color?: string | null
  /** Extra REST v3 facts (color options, categories). */
  attributesLine?: string | null
  /** Plain-text short description, HTML already stripped. */
  blurb?: string | null
}

interface StorePrices {
  price?: string
  regular_price?: string
  sale_price?: string
  currency_code?: string
  currency_symbol?: string
  currency_minor_unit?: number
  currency_prefix?: string
  currency_suffix?: string
}

interface StoreAttributeTerm {
  id?: number
  name?: string
  slug?: string
}

interface StoreAttribute {
  id?: number
  name?: string
  taxonomy?: string
  terms?: StoreAttributeTerm[]
}

interface StoreProductRaw {
  id?: number
  name?: string
  permalink?: string
  prices?: StorePrices
  is_in_stock?: boolean
  attributes?: StoreAttribute[]
}

function attrTerm(
  attributes: StoreAttribute[] | undefined,
  taxonomy: string,
): StoreAttributeTerm | null {
  const attr = (attributes ?? []).find(
    (a) => (a.taxonomy ?? '').toLowerCase() === taxonomy.toLowerCase(),
  )
  const term = attr?.terms?.[0]
  return term ?? null
}

/** Major-unit amount from Store API `prices` (minor units → dollars). */
export function storePriceAmount(prices: StorePrices | undefined): number | null {
  if (!prices) return null
  const minor = Number.isFinite(prices.currency_minor_unit)
    ? (prices.currency_minor_unit as number)
    : 2
  const raw = prices.price ?? prices.sale_price ?? prices.regular_price
  if (raw == null || raw === '') return null
  const minorUnits = Number(raw)
  if (!Number.isFinite(minorUnits)) return null
  return minorUnits / Math.pow(10, minor)
}

/** Format Store API `prices` into e.g. `$155.00 AUD`. */
export function formatStorePrice(prices: StorePrices | undefined): string {
  const amount = storePriceAmount(prices)
  if (amount == null || !prices) return 'Price unavailable'
  const minor = Number.isFinite(prices.currency_minor_unit)
    ? (prices.currency_minor_unit as number)
    : 2
  const prefix = prices.currency_prefix ?? prices.currency_symbol ?? ''
  const suffix = prices.currency_suffix ?? ''
  const code = prices.currency_code ? ` ${prices.currency_code}` : ''
  return `${prefix}${amount.toFixed(minor)}${suffix}${code}`.trim()
}

export function mapStoreProduct(raw: StoreProductRaw): WooProduct | null {
  if (typeof raw.id !== 'number' || !raw.name || !raw.permalink) return null
  const sizeTerm = attrTerm(raw.attributes, 'pa_size')
  const tcTerm = attrTerm(raw.attributes, 'pa_thread-count')
  return {
    id: raw.id,
    name: raw.name,
    permalink: raw.permalink,
    priceLabel: formatStorePrice(raw.prices),
    priceAmount: storePriceAmount(raw.prices),
    size: sizeTerm?.name?.trim() || null,
    sizeSlug: sizeTerm?.slug?.trim().toLowerCase() || null,
    threadCount: tcTerm?.name?.trim() || null,
    inStock: raw.is_in_stock !== false,
  }
}

export function formatProductExcerpt(product: WooProduct): string {
  const parts = [
    product.name,
    product.size ? `Size: ${product.size}` : null,
    product.threadCount ? product.threadCount : null,
    product.priceLabel,
    product.inStock ? 'In stock' : 'Out of stock',
    product.permalink,
    product.attributesLine || null,
    product.blurb || null,
  ].filter(Boolean)
  return parts.join(' | ')
}

export interface SearchProductsArgs {
  storeUrl: string
  search?: string
  perPage?: number
  /** 1-based page for paginated reads. */
  page?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ProductPage {
  products: WooProduct[]
  /** From `X-WP-TotalPages`; 1 when the header is missing. */
  totalPages: number
}

/**
 * Live product search against the public WooCommerce Store API.
 * Does not require consumer keys.
 */
export async function searchProducts(
  args: SearchProductsArgs,
): Promise<WooProduct[]> {
  const page = await fetchStoreProductPage({
    ...args,
    perPage: Math.min(50, Math.max(1, args.perPage ?? 20)),
  })
  return page.products
}

/** One page of the Store API product list (`per_page` up to 100). */
export async function fetchStoreProductPage(
  args: SearchProductsArgs,
): Promise<ProductPage> {
  const storeUrl = normalizeStoreUrl(args.storeUrl)
  await assertStoreUrlDeliverable(storeUrl)

  const perPage = Math.min(100, Math.max(1, args.perPage ?? 20))
  const url = new URL(`${storeUrl}/wp-json/wc/store/v1/products`)
  url.searchParams.set('per_page', String(perPage))
  if (args.page && args.page > 1) {
    url.searchParams.set('page', String(args.page))
  }
  if (args.search?.trim()) {
    url.searchParams.set('search', args.search.trim())
  }

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  args.signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'manual',
    })
    if (!res.ok) {
      throw new Error(`WooCommerce Store API returned ${res.status}`)
    }
    const totalPages = Math.max(1, Number(res.headers.get('x-wp-totalpages')) || 1)
    const json = (await res.json()) as unknown
    if (!Array.isArray(json)) return { products: [], totalPages }
    const out: WooProduct[] = []
    for (const row of json) {
      const mapped = mapStoreProduct(row as StoreProductRaw)
      if (mapped) out.push(mapped)
    }
    return { products: out, totalPages }
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener('abort', onAbort)
  }
}

/** Lightweight connectivity probe used when saving the store URL. */
export async function probeStoreApi(storeUrl: string): Promise<void> {
  await searchProducts({ storeUrl, perPage: 1, timeoutMs: 10_000 })
}
