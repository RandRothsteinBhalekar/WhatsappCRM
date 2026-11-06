import type { SupabaseClient } from '@/lib/db/supabase-types'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  loadCatalogue,
  normalizePermalink,
  type CatalogueItem,
  type CatalogueSnapshot,
  type ProductType,
} from './catalogue'
import { COLOR_FAMILY_LABEL } from './colors'
import { planConversation, type PlannedQuery } from './query-planner'

const MAX_EXCERPTS = 5
const MAX_COLOR_NAMES = 12

export type MatchLevel = 'exact' | 'partial' | 'none'

export interface CatalogueCustomer {
  name: string | null
  phone: string | null
}

export interface CatalogueSelection {
  items: CatalogueItem[]
  /** Short statements computed from the whole catalogue for the prompt. */
  facts: string[]
  /** exact = every filter met; partial = budget / piece count relaxed;
   *  none = requested size, type, design or colour is not stocked. */
  match: MatchLevel
  /** First line for a deterministic product-list reply. */
  headline: string
  /** Contact name and phone, when the caller loaded them for an order. */
  customer?: CatalogueCustomer | null
}

export interface SelectOptions {
  /** Permalinks already sent in the latest assistant message. */
  citedPermalinks?: string[]
  customer?: CatalogueCustomer | null
}

export interface ProductRetrieval extends CatalogueSelection {
  /** Account has an active WooCommerce store URL. */
  configured: boolean
  plan: PlannedQuery
  excerpts: string[]
  isKnownPermalink: (url: string) => boolean
}

const SIZE_ORDER = ['single', 'king-single', 'double', 'queen', 'king', 'super-king', 'standard']
const SIZE_LABEL: Record<string, string> = {
  single: 'Single',
  'king-single': 'King Single',
  double: 'Double',
  queen: 'Queen',
  king: 'King',
  'super-king': 'Super King',
  standard: 'Standard',
}
const TYPE_LABEL: Record<ProductType, string> = {
  quilt_cover: 'quilt cover sets',
  sheet_set: 'bedsheet sets',
  comforter: 'comforters',
  other: 'other products',
}
const TYPE_SINGULAR: Record<ProductType, string> = {
  quilt_cover: 'Quilt cover set',
  sheet_set: 'Bedsheet set',
  comforter: 'Comforter',
  other: 'Product',
}

function sizeLabel(slug: string): string {
  return SIZE_LABEL[slug] ?? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function joinOr(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`
}

function colorPhrase(colors: string[]): string {
  return joinOr(colors.map((c) => (COLOR_FAMILY_LABEL[c] ?? c).toLowerCase()))
}

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`
}

/** "Queen quilt cover sets in orange / terracotta tones under $100". */
export function describeScope(
  plan: PlannedQuery,
  parts: { size?: boolean; type?: boolean; color?: boolean; price?: boolean; design?: boolean } = {},
): string {
  const use = { size: true, type: true, color: true, price: true, design: true, ...parts }
  const bits: string[] = []
  if (use.size && plan.sizeSlugs.length > 0) bits.push(joinOr(plan.sizeSlugs.map(sizeLabel)))
  if (use.design && plan.designs.length > 0) bits.push(joinOr(plan.designs))
  bits.push(
    use.type && plan.types.length > 0
      ? joinOr(plan.types.map((t) => TYPE_LABEL[t]))
      : 'products',
  )
  let out = bits.join(' ')
  if (use.color && plan.colors.length > 0) out += ` in ${colorPhrase(plan.colors)}`
  if (use.price && plan.maxPrice != null) out += ` at or under ${money(plan.maxPrice)}`
  return out
}

function inStockFirst(items: CatalogueItem[]): CatalogueItem[] {
  return [...items].sort((a, b) => Number(b.inStock) - Number(a.inStock))
}

/** Distinct colour (then design) first so five rows are not one colourway. */
function diversify(items: CatalogueItem[], limit: number, key = (i: CatalogueItem) => i.colorName ?? i.design): CatalogueItem[] {
  const seen = new Set<string>()
  const first: CatalogueItem[] = []
  const rest: CatalogueItem[] = []
  for (const item of items) {
    const k = key(item).toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      first.push(item)
    } else {
      rest.push(item)
    }
  }
  return [...first, ...rest].slice(0, limit)
}

function sizesLine(items: CatalogueItem[]): string {
  const counts = new Map<string, number>()
  for (const i of items) if (i.sizeSlug) counts.set(i.sizeSlug, (counts.get(i.sizeSlug) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => {
      const ia = SIZE_ORDER.indexOf(a[0])
      const ib = SIZE_ORDER.indexOf(b[0])
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    .map(([slug, n]) => `${sizeLabel(slug)} (${n})`)
    .join(', ')
}

function typesLine(items: CatalogueItem[]): string {
  const counts = new Map<ProductType, number>()
  for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1)
  return [...counts.entries()].map(([t, n]) => `${TYPE_LABEL[t]} (${n})`).join(', ')
}

function colorNamesByFamily(items: CatalogueItem[]): string[] {
  const byFamily = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.colorName) continue
    const key = item.colorName.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const family = item.colorFamilies[0] ?? 'other'
    const list = byFamily.get(family) ?? []
    list.push(item.colorName)
    byFamily.set(family, list)
  }
  const order = [...Object.keys(COLOR_FAMILY_LABEL), 'other']
  return order
    .filter((f) => byFamily.has(f))
    .map((f) => `- ${COLOR_FAMILY_LABEL[f] ?? 'Other'}: ${byFamily.get(f)!.join(', ')}`)
}

function distinctColorNames(items: CatalogueItem[], limit: number): string[] {
  const out: string[] = []
  for (const item of items) {
    if (item.colorName && !out.includes(item.colorName)) out.push(item.colorName)
    if (out.length >= limit) break
  }
  return out
}

export function formatCatalogueExcerpt(item: CatalogueItem): string {
  return [
    item.name,
    TYPE_SINGULAR[item.type],
    item.size ? `Size: ${item.size}` : null,
    item.colorName ? `Colour: ${item.colorName}` : null,
    item.threadCount,
    item.priceLabel,
    item.inStock ? 'In stock' : 'Out of stock',
    item.permalink,
  ]
    .filter(Boolean)
    .join(' | ')
}

/** `{store}/checkout/?add-to-cart={id}` so checkout opens with this item in the cart. */
export function checkoutUrlFor(item: CatalogueItem): string | null {
  try {
    return `${new URL(item.permalink).origin}/checkout/?add-to-cart=${item.id}`
  } catch {
    return null
  }
}

/**
 * Deterministic reply when the customer wants to buy and the model handed
 * off or left the checkout link out. No card details, no bare /checkout/.
 */
export function buildOrderReply(
  items: CatalogueItem[],
  customer?: CatalogueCustomer | null,
): string {
  const knownName = customer?.name?.trim() || null
  const knownPhone = customer?.phone?.trim() || null
  const details = knownName
    ? `I have your name as ${knownName}${knownPhone ? ` and phone ${knownPhone}` : ''}. Please reply with your delivery address.`
    : `Please reply with your full name and delivery address. ${
        knownPhone
          ? `We'll use ${knownPhone} unless you send a different number.`
          : "We'll use this WhatsApp number unless you send a different one."
      }`
  const pay = "Payment is on the checkout page — please don't send card details here."
  const chosen = items
    .slice(0, 3)
    .map((item) => ({ item, url: checkoutUrlFor(item) }))
    .filter((row): row is { item: CatalogueItem; url: string } => !!row.url)

  if (chosen.length === 0) {
    return `Which product would you like to order? ${details} ${pay}`
  }
  if (chosen.length === 1) {
    const { item, url } = chosen[0]
    return `You can check out the ${item.name} (${item.priceLabel}) here:\n${url}\n\n${details} ${pay}`
  }
  const lines = chosen.map(({ item, url }) => `• ${item.name} — ${item.priceLabel} — ${url}`)
  return `Which one should I add to checkout?\n\n${lines.join('\n')}\n\n${details} ${pay}`
}

interface FilterStep {
  active: boolean
  hard: boolean
  test: (item: CatalogueItem) => boolean
  miss: (pool: CatalogueItem[]) => string
}

/**
 * Apply filters in order. A filter that would empty the pool is skipped
 * (the pool stays as the closest options) and explained in a fact.
 */
function runFilters(
  items: CatalogueItem[],
  steps: FilterStep[],
): { pool: CatalogueItem[]; facts: string[]; match: MatchLevel } {
  let pool = items
  const facts: string[] = []
  let hardMiss = false
  let softMiss = false
  for (const step of steps) {
    if (!step.active) continue
    const next = pool.filter(step.test)
    if (next.length > 0) {
      pool = next
      continue
    }
    facts.push(step.miss(pool))
    if (step.hard) hardMiss = true
    else softMiss = true
  }
  const match: MatchLevel = hardMiss ? 'none' : softMiss ? 'partial' : 'exact'
  return { pool, facts, match }
}

/** Pure catalogue filter + facts for one plan. */
export function selectFromCatalogue(
  items: CatalogueItem[],
  plan: PlannedQuery,
  opts: SelectOptions = {},
): CatalogueSelection {
  if (plan.intent === 'none' || items.length === 0) {
    return { items: [], facts: [], match: 'none', headline: '' }
  }

  if (plan.intent === 'browse') {
    const stocked = inStockFirst(items)
    const byType = new Map<ProductType, CatalogueItem[]>()
    for (const item of stocked) {
      const list = byType.get(item.type) ?? []
      list.push(item)
      byType.set(item.type, list)
    }
    const lists = [...byType.values()].map((l) => diversify(l, MAX_EXCERPTS))
    const picked: CatalogueItem[] = []
    for (let i = 0; picked.length < MAX_EXCERPTS && lists.some((l) => i < l.length); i++) {
      for (const list of lists) if (list[i] && picked.length < MAX_EXCERPTS) picked.push(list[i])
    }
    const prices = items.map((i) => i.priceAmount).filter((p): p is number => p != null)
    const facts = [
      `Product types in the store: ${typesLine(items)}.`,
      `Sizes in the store: ${sizesLine(items)}.`,
    ]
    if (prices.length > 0) {
      facts.push(`Price range: ${money(Math.min(...prices))} to ${money(Math.max(...prices))}.`)
    }
    if (items.some((i) => i.type === 'comforter')) {
      facts.push('Comforters come in one Standard size.')
    }
    return {
      items: picked,
      facts,
      match: 'exact',
      headline: 'Here are a few of our current products:',
    }
  }

  const sizes = new Set(plan.sizeSlugs)
  const sizeStep: FilterStep = {
    active: plan.sizeSlugs.length > 0 && plan.intent !== 'sizes',
    hard: true,
    test: (i) =>
      (!!i.sizeSlug && sizes.has(i.sizeSlug)) ||
      (plan.comforterExplicit && i.type === 'comforter'),
    miss: (pool) =>
      `We do not stock ${describeScope(plan, { color: false, price: false, design: false })}. Sizes available: ${sizesLine(pool)}.`,
  }
  const typeStep: FilterStep = {
    active: plan.types.length > 0,
    hard: true,
    test: (i) => plan.types.includes(i.type as never),
    miss: (pool) =>
      `We do not stock ${describeScope(plan, { color: false, price: false, design: false })}. Available instead: ${typesLine(pool)}.`,
  }
  const designStep: FilterStep = {
    active: plan.designs.length > 0,
    hard: true,
    test: (i) => plan.designs.includes(i.design),
    miss: () => {
      const all = items.filter((i) => plan.designs.includes(i.design))
      return `${joinOr(plan.designs)} is not available as ${describeScope(plan, { design: false, color: false, price: false })}. ${joinOr(plan.designs)} comes in: ${sizesLine(all) || 'no current sizes'}.`
    },
  }
  const piecesStep: FilterStep = {
    active: plan.pieces != null,
    hard: false,
    test: (i) => i.pieces === plan.pieces,
    miss: (pool) => {
      const counts = [...new Set(pool.map((i) => i.pieces).filter((n): n is number => n != null))]
        .sort((a, b) => a - b)
        .map((n) => `${n}-piece`)
      return `No ${plan.pieces}-piece sets in this selection. Available: ${counts.join(', ') || 'none'}.`
    },
  }
  const colorStep: FilterStep = {
    active: plan.colors.length > 0 && plan.intent !== 'colors',
    hard: true,
    test: (i) => i.colorFamilies.some((f) => plan.colors.includes(f)),
    miss: (pool) =>
      `We do not have ${describeScope(plan, { price: false })}. Closest available colours for ${describeScope(plan, { color: false, price: false })}: ${distinctColorNames(pool, MAX_COLOR_NAMES).join(', ')}.`,
  }
  const priceStep: FilterStep = {
    active: plan.maxPrice != null,
    hard: false,
    test: (i) => i.priceAmount != null && i.priceAmount <= (plan.maxPrice as number),
    miss: (pool) => {
      const prices = pool.map((i) => i.priceAmount).filter((p): p is number => p != null)
      const low = prices.length > 0 ? money(Math.min(...prices)) : 'unknown'
      return `Nothing in ${describeScope(plan, { price: false })} is at or under ${money(plan.maxPrice as number)}. The lowest price there is ${low}.`
    },
  }

  const facts: string[] = []
  if (plan.types.includes('comforter') && plan.sizeSlugs.length > 0 && !plan.comforterExplicit) {
    facts.push('Comforters come in one Standard size, so they are not listed under a bed size.')
  } else if (plan.comforterExplicit) {
    facts.push('Comforters come in one Standard size.')
  }

  if (plan.intent === 'colors') {
    const res = runFilters(items, [sizeStep, typeStep, designStep])
    const scope = describeScope(plan, { color: false, price: false })
    return {
      items: diversify(inStockFirst(res.pool), MAX_EXCERPTS),
      facts: [
        ...facts,
        ...res.facts,
        `Colours available for ${scope} (${res.pool.length} products):`,
        ...colorNamesByFamily(res.pool),
      ],
      match: res.match,
      headline: `Here are some ${scope} in different colours:`,
    }
  }

  if (plan.intent === 'sizes') {
    const res = runFilters(items, [typeStep, designStep, colorStep])
    const scope = describeScope(plan, { size: false, price: false })
    const line = `Sizes available for ${scope}: ${sizesLine(res.pool)}.`
    return {
      items: diversify(inStockFirst(res.pool), MAX_EXCERPTS, (i) => i.sizeSlug ?? i.design),
      facts: [...facts, ...res.facts, line],
      match: res.match,
      headline: `Here are ${scope} in different sizes:`,
    }
  }

  const res = runFilters(items, [sizeStep, typeStep, designStep, piecesStep, colorStep, priceStep])
  let pool = inStockFirst(res.pool)
  if (plan.maxPrice != null) {
    pool = [...pool].sort(
      (a, b) =>
        Number(b.inStock) - Number(a.inStock) ||
        (a.priceAmount ?? Infinity) - (b.priceAmount ?? Infinity),
    )
  }
  const scope = describeScope(plan)
  if (plan.intent === 'order') {
    return orderSelection(items, pool, res.match, facts, opts)
  }
  if (res.match === 'exact') {
    facts.push(`Matching products: ${res.pool.length} ${scope}.`)
  }
  return {
    items: diversify(pool, MAX_EXCERPTS),
    facts: [...facts, ...res.facts],
    match: res.match,
    headline:
      res.match === 'none'
        ? `We don't have an exact match for ${scope}, but here are the closest options:`
        : `Here are some ${scope} from our store:`,
  }
}

const ORDER_LINKS = 3

function orderSelection(
  all: CatalogueItem[],
  filtered: CatalogueItem[],
  match: MatchLevel,
  priorFacts: string[],
  opts: SelectOptions,
): CatalogueSelection {
  const cited = new Set((opts.citedPermalinks ?? []).map((url) => normalizePermalink(url)))
  let pool = filtered
  let citedHit = false
  if (cited.size > 0) {
    const inFiltered = filtered.filter((item) => cited.has(normalizePermalink(item.permalink)))
    const anywhere = all.filter((item) => cited.has(normalizePermalink(item.permalink)))
    if (inFiltered.length > 0) {
      pool = inFiltered
      citedHit = true
    } else if (anywhere.length > 0) {
      pool = inStockFirst(anywhere)
      citedHit = true
    } else if (match === 'none') {
      pool = []
    }
  } else if (match === 'none') {
    pool = []
  }
  const chosen = pool.slice(0, ORDER_LINKS)
  const facts = ['The customer wants to place an order.', ...priorFacts]
  const name = opts.customer?.name?.trim()
  const phone = opts.customer?.phone?.trim()
  if (name) {
    facts.push(
      `Customer name on file: ${name}. Confirm it and only ask for the delivery address.`,
    )
  }
  if (phone) {
    facts.push(
      `Customer phone on file: ${phone}. Use this unless they send a different number.`,
    )
  }
  if (chosen.length === 0) {
    facts.push(
      'No product is selected yet. Ask which product they want. Do not invent a checkout link. Do not hand off.',
    )
  } else if (chosen.length === 1) {
    const item = chosen[0]
    const url = checkoutUrlFor(item)
    facts.push(
      url
        ? `Order this product: ${item.name} (${item.priceLabel}). Checkout link, with the item already added: ${url}. Do not hand off. Confirm the name, price, and this exact URL. Ask for their full name and delivery address. This WhatsApp number is the contact number unless they send another. Tell them to pay on the checkout page and not to send card details here.`
        : `Order this product: ${item.name} (${item.priceLabel}). Do not hand off. Ask which product they want if this link cannot be built.`,
    )
  } else {
    facts.push(
      'More than one product still fits. Ask which one they want and include each checkout link below. Do not hand off. Ask for their full name and delivery address. Do not ask for card details.',
    )
    for (const item of chosen) {
      const url = checkoutUrlFor(item)
      if (url) facts.push(`${item.name} — ${item.priceLabel} — ${url}`)
    }
  }
  return {
    items: chosen,
    facts,
    match: chosen.length > 0 ? (citedHit || match === 'exact' ? 'exact' : match) : 'none',
    headline:
      chosen.length === 1
        ? `Checkout for ${chosen[0].name}:`
        : chosen.length > 1
          ? 'Which product should I add to checkout?'
          : 'Which product would you like to order?',
    customer: opts.customer ?? null,
  }
}

function decryptSecret(ciphertext: string | null): string | null {
  if (!ciphertext) return null
  try {
    return decrypt(ciphertext)
  } catch (err) {
    console.error('[woocommerce] stored REST credential could not be decrypted:', err)
    return null
  }
}

function emptyRetrieval(configured: boolean): ProductRetrieval {
  return {
    configured,
    plan: planConversation([]),
    items: [],
    excerpts: [],
    facts: [],
    match: 'none',
    headline: '',
    isKnownPermalink: () => false,
  }
}

/**
 * Plan + filter the live catalogue for the customer's recent turns.
 * Best-effort: config or fetch failures return an empty retrieval.
 */
export async function retrieveCatalogue(
  db: SupabaseClient,
  accountId: string,
  customerTurns: string[],
  opts: {
    loadSnapshot?: typeof loadCatalogue
    citedPermalinks?: string[]
    customer?: CatalogueCustomer | null
  } = {},
): Promise<ProductRetrieval> {
  let configured = false
  try {
    const { data, error } = await db
      .from('woocommerce_configs')
      .select('store_url, is_active, consumer_key, consumer_secret')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[woocommerce] config load failed:', error)
      return emptyRetrieval(false)
    }
    if (!data?.is_active || !data.store_url) return emptyRetrieval(false)
    configured = true

    let consumerKey = decryptSecret((data.consumer_key as string | null) ?? null)
    let consumerSecret = decryptSecret((data.consumer_secret as string | null) ?? null)
    if (!consumerKey || !consumerSecret) {
      consumerKey = null
      consumerSecret = null
    }

    const snapshot: CatalogueSnapshot = await (opts.loadSnapshot ?? loadCatalogue)({
      storeUrl: data.store_url as string,
      consumerKey,
      consumerSecret,
    })
    const plan = planConversation(customerTurns, { designs: snapshot.designs })
    const selection = selectFromCatalogue(snapshot.items, plan, {
      citedPermalinks: opts.citedPermalinks,
      customer: opts.customer,
    })
    return {
      configured,
      plan,
      ...selection,
      excerpts: selection.items.map((item) => {
        if (plan.intent !== 'order') return formatCatalogueExcerpt(item)
        const checkout = checkoutUrlFor(item)
        return checkout
          ? `${formatCatalogueExcerpt(item)} | Checkout: ${checkout}`
          : formatCatalogueExcerpt(item)
      }),
      isKnownPermalink: snapshot.isKnownPermalink,
    }
  } catch (err) {
    console.error('[woocommerce] retrieveCatalogue failed:', err)
    return emptyRetrieval(configured)
  }
}
