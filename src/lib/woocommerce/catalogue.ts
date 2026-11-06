/**
 * Full-catalogue snapshot for local filtering.
 *
 * Woo's `search=` only returns the newest page of loose text hits, so a
 * "queen, orange" ask never saw the older queen products. The catalogue
 * here is small (hundreds of rows), so every page is read once and kept
 * in memory; size, type, colour and price are then filtered locally.
 */
import { colorFamiliesOf } from './colors'
import { fetchRestProductPage } from './rest-api'
import { fetchStoreProductPage, type WooProduct } from './store-api'
import { normalizeStoreUrl } from './store-url'

export type ProductType = 'quilt_cover' | 'sheet_set' | 'comforter' | 'other'

export interface CatalogueItem {
  id: number
  name: string
  /** Design line without piece count / type / colour ("Heritage Motif"). */
  design: string
  /** Name suffix after the last dash ("Marigold Ember"), or null. */
  colorName: string | null
  colorFamilies: string[]
  type: ProductType
  pieces: number | null
  size: string | null
  sizeSlug: string | null
  threadCount: string | null
  priceAmount: number | null
  priceLabel: string
  inStock: boolean
  permalink: string
}

export interface CatalogueSnapshot {
  storeUrl: string
  items: CatalogueItem[]
  /** Distinct design names, longest first (for phrase matching). */
  designs: string[]
  fetchedAt: number
  isKnownPermalink(url: string): boolean
}

export interface CatalogueCredentials {
  storeUrl: string
  consumerKey: string | null
  consumerSecret: string | null
}

const CACHE_TTL_MS = 10 * 60 * 1000
const PAGE_SIZE = 100
const MAX_PAGES = 20
const PAGE_TIMEOUT_MS = 15_000

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&#038;': '&',
  '&#38;': '&',
  '&quot;': '"',
  '&#039;': "'",
  '&#8217;': '\u2019',
  '&#8211;': '\u2013',
  '&#8212;': '\u2014',
  '&nbsp;': ' ',
}

export function cleanProductName(raw: string): string {
  let name = raw
  for (const [entity, char] of Object.entries(ENTITIES)) {
    name = name.split(entity).join(char)
  }
  return name
    .replace(/[\u2010\u2011\u2012]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

const TYPE_TAIL_RE =
  /\s*(?:\d+\s*-?\s*piece\b.*|quilt\s+cover\s+set\b.*|bedsheet\s+set\b.*|comforter\b.*)$/i

/** Split a cleaned name into design, colour, type and piece count. */
export function parseProductName(name: string): {
  design: string
  colorName: string | null
  type: ProductType
  pieces: number | null
} {
  const dash = name.match(/^(.*\S)\s*[\u2013\u2014]\s*(.+)$/) ?? name.match(/^(.*\S)\s+-\s+(.+)$/)
  const base = dash ? dash[1].trim() : name
  const colorName = dash ? dash[2].trim() : null

  let type: ProductType = 'other'
  if (/quilt\s*cover/i.test(base)) type = 'quilt_cover'
  else if (/comforter/i.test(base)) type = 'comforter'
  else if (/piece|bedsheet|sheet/i.test(base)) type = 'sheet_set'

  const piecesMatch = base.match(/(\d+)\s*-?\s*piece/i)
  const pieces = piecesMatch ? Number(piecesMatch[1]) : null

  const design = base.replace(TYPE_TAIL_RE, '').trim() || base
  return { design, colorName, type, pieces }
}

export function normalizePermalink(url: string): string {
  try {
    const u = new URL(url.trim())
    let path = u.pathname
    if (!path.endsWith('/')) path += '/'
    return `${u.host.toLowerCase()}${path.toLowerCase()}`
  } catch {
    return url.trim().toLowerCase()
  }
}

export function toCatalogueItem(product: WooProduct): CatalogueItem {
  const name = cleanProductName(product.name)
  const parsed = parseProductName(name)
  return {
    id: product.id,
    name,
    design: parsed.design,
    colorName: parsed.colorName,
    colorFamilies: colorFamiliesOf(parsed.colorName),
    type: parsed.type,
    pieces: parsed.pieces,
    size: product.size,
    sizeSlug: product.sizeSlug,
    threadCount: product.threadCount,
    priceAmount: product.priceAmount,
    priceLabel: product.priceLabel,
    inStock: product.inStock,
    permalink: product.permalink,
  }
}

export function buildSnapshot(
  storeUrl: string,
  products: WooProduct[],
  fetchedAt = Date.now(),
): CatalogueSnapshot {
  const byId = new Map<number, CatalogueItem>()
  for (const product of products) byId.set(product.id, toCatalogueItem(product))
  const items = [...byId.values()]
  const designs = [...new Set(items.map((i) => i.design).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )
  const permalinks = new Set(items.map((i) => normalizePermalink(i.permalink)))
  return {
    storeUrl,
    items,
    designs,
    fetchedAt,
    isKnownPermalink: (url: string) => permalinks.has(normalizePermalink(url)),
  }
}

async function fetchPage(creds: CatalogueCredentials, page: number) {
  if (creds.consumerKey && creds.consumerSecret) {
    return fetchRestProductPage({
      storeUrl: creds.storeUrl,
      consumerKey: creds.consumerKey,
      consumerSecret: creds.consumerSecret,
      perPage: PAGE_SIZE,
      page,
      timeoutMs: PAGE_TIMEOUT_MS,
    })
  }
  return fetchStoreProductPage({
    storeUrl: creds.storeUrl,
    perPage: PAGE_SIZE,
    page,
    timeoutMs: PAGE_TIMEOUT_MS,
  })
}

async function fetchAllProducts(creds: CatalogueCredentials): Promise<WooProduct[]> {
  const first = await fetchPage(creds, 1)
  const total = Math.min(first.totalPages, MAX_PAGES)
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, total - 1) }, (_, i) => fetchPage(creds, i + 2)),
  )
  return [first, ...rest].flatMap((p) => p.products)
}

interface CacheEntry {
  snapshot: CatalogueSnapshot | null
  inflight: Promise<CatalogueSnapshot> | null
}

const cache = new Map<string, CacheEntry>()

function cacheKey(creds: CatalogueCredentials): string {
  const mode = creds.consumerKey && creds.consumerSecret ? 'rest' : 'store'
  return `${normalizeStoreUrl(creds.storeUrl)}|${mode}`
}

/**
 * Snapshot of every published product, cached per store for 10 minutes.
 * A failed refresh keeps serving the last good snapshot; with none, it throws.
 */
export async function loadCatalogue(
  creds: CatalogueCredentials,
  opts: { now?: number } = {},
): Promise<CatalogueSnapshot> {
  const now = opts.now ?? Date.now()
  const key = cacheKey(creds)
  const entry = cache.get(key) ?? { snapshot: null, inflight: null }
  cache.set(key, entry)

  if (entry.snapshot && now - entry.snapshot.fetchedAt < CACHE_TTL_MS) {
    return entry.snapshot
  }
  if (!entry.inflight) {
    entry.inflight = fetchAllProducts(creds)
      .then((products) => {
        const snapshot = buildSnapshot(normalizeStoreUrl(creds.storeUrl), products, now)
        entry.snapshot = snapshot
        return snapshot
      })
      .finally(() => {
        entry.inflight = null
      })
  }
  try {
    return await entry.inflight
  } catch (err) {
    if (entry.snapshot) {
      console.error('[woocommerce] catalogue refresh failed, serving cached snapshot:', err)
      return entry.snapshot
    }
    throw err
  }
}

/** Test hook: forget cached snapshots. */
export function clearCatalogueCache(): void {
  cache.clear()
}
