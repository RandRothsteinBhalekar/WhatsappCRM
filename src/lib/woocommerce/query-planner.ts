/**
 * Turn recent customer WhatsApp messages into a catalogue filter plan.
 *
 * Each customer turn is read on its own, then merged latest-wins: size,
 * colour, type and budget each come from the newest turn that states
 * them, so "actually king" replaces an earlier "queen" instead of both
 * sticking. The last turn decides the intent:
 *   - search  — filter the catalogue (size / type / colour / price / design)
 *   - browse  — "what products do you have?", a varied sample
 *   - colors  — "what colours do you have?", list colour names
 *   - sizes   — "what sizes?", list sizes
 *   - order   — "place an order" / "checkout": keep earlier filters and
 *               send the customer to checkout with that item
 *   - none    — greeting, thanks, policy, human: no product block at all
 */
import type { ProductType } from './catalogue'

export type QueryIntent = 'search' | 'browse' | 'colors' | 'sizes' | 'order' | 'none'
export type WantedType = Exclude<ProductType, 'other'>

export interface PlannedQuery {
  intent: QueryIntent
  /** `pa_size` slugs (hard filter). */
  sizeSlugs: string[]
  /** Colour family keys from `COLOR_FAMILIES`. */
  colors: string[]
  /** Product types; empty = any. */
  types: WantedType[]
  /** Customer said "comforter" (comforters only come in Standard). */
  comforterExplicit: boolean
  /** Major-unit ceiling from "under 100", or null. */
  maxPrice: number | null
  /** Catalogue design names the customer named ("Heritage Motif"). */
  designs: string[]
  /** "7 piece" → 7. */
  pieces: number | null
}

export interface PlanOptions {
  /** Design names from the catalogue snapshot, longest first. */
  designs?: string[]
}

interface TurnSignals {
  sizeSlugs: string[]
  colors: string[]
  types: WantedType[]
  comforterExplicit: boolean
  maxPrice: number | null
  designs: string[]
  pieces: number | null
  genericBedding: boolean
  asksColors: boolean
  asksSizes: boolean
  asksBrowse: boolean
  asksOrder: boolean
  followUp: boolean
  nonProduct: boolean
}

const MAX_TURNS = 6

/** Longest-first so "super king" wins over "king". */
const SIZE_PATTERNS: { re: RegExp; slug: string }[] = [
  { re: /\bsuper[\s-]?kings?\b/gi, slug: 'super-king' },
  { re: /\bking[\s-]?singles?\b/gi, slug: 'king-single' },
  { re: /\bkings?\b/gi, slug: 'king' },
  { re: /\bqueens?\b/gi, slug: 'queen' },
  { re: /\bdoubles?\b/gi, slug: 'double' },
  { re: /\bsingles?\b/gi, slug: 'single' },
]

const TYPE_PATTERNS: { re: RegExp; types: WantedType[]; comforter?: boolean }[] = [
  {
    re: /\bbed[\s-]?spreads?\b|\bcoverlets?\b|\bduvets?(?:\s+covers?)?\b|\bdoonas?(?:\s+covers?)?\b/gi,
    types: ['quilt_cover', 'comforter'],
  },
  { re: /\bquilts?(?:\s+covers?)?\b/gi, types: ['quilt_cover'] },
  { re: /\bcomforters?\b/gi, types: ['comforter'], comforter: true },
  {
    re: /\bbed[\s-]?sheets?\b|\bsheet\s+sets?\b|\b(?:fitted|flat)\s+sheets?\b|\bsheets?\b|\bpillow\s*cases?\b/gi,
    types: ['sheet_set'],
  },
]

/** Words a customer uses for each family (catalogue shade words live in colors.ts). */
const CUSTOMER_COLOR_WORDS: Record<string, string[]> = {
  orange: ['orange', 'peach', 'terracotta', 'rust', 'coral', 'apricot', 'amber', 'marigold', 'tangerine'],
  pink: ['pink', 'blush', 'rose', 'magenta', 'fuchsia'],
  blue: ['blue', 'navy', 'azure', 'indigo', 'cobalt'],
  teal: ['teal', 'turquoise', 'aqua'],
  green: ['green', 'sage', 'mint', 'olive', 'emerald'],
  grey: ['grey', 'gray', 'silver', 'slate', 'charcoal'],
  white: ['white', 'ivory', 'cream', 'off[\\s-]?white'],
  beige: ['beige', 'neutral', 'sand', 'taupe', 'nude'],
  purple: ['purple', 'violet', 'lilac', 'lavender', 'mauve', 'plum'],
  yellow: ['yellow', 'gold', 'golden', 'mustard'],
  red: ['red', 'maroon', 'burgundy', 'crimson', 'wine'],
  black: ['black', 'noir'],
  brown: ['brown', 'chocolate', 'mocha'],
  multi: ['multi[\\s-]?colou?r(?:ed)?', 'colou?rful'],
}

const COLOR_PATTERNS: { re: RegExp; family: string }[] = Object.entries(
  CUSTOMER_COLOR_WORDS,
).map(([family, words]) => ({
  re: new RegExp(`\\b(?:${words.join('|')})s?\\b`, 'gi'),
  family,
}))

const PRICE_RE =
  /\b(?:under|below|less\s+than|up\s+to|upto|max(?:imum)?|within|budget(?:\s+of)?|cheaper\s+than)\s*(?:aud\s*)?\$?\s*(\d+(?:\.\d+)?)/gi

const PIECES_RE = /\b(\d+)\s*-?\s*(?:piece|pc|pcs)\b/i
const GENERIC_BEDDING_RE =
  /\bbedding\b|\bbed\s+linen\b|\blinens?\b|\bbeds?\b|\bcotton\b|\bmicrofib(?:er|re)\b|\bthread\s*count\b|\b\d{3}\s*tc\b|\b3d\b|\bsets?\b/i

const MIXED_RE = /\bmixed\s+colou?rs?\b|\bvariety\b|\bdifferent\s+(?:designs|styles|products)\b/i
const BROWSE_RE =
  /\bcatalog(?:ue)?\b|\bwhat\s+(?:do\s+you|products?|items?|else|all)\b[^?]*\b(?:sell|have|offer|stock|carry|products?|items?)\b|\bwhat\s+products?\b|\bshow\s+me\s+(?:some|all|your|what|the)\b|\ball\s+(?:your\s+)?products?\b|\byour\s+(?:range|collection|products)\b|\bnew\s+arrivals?\b|\bbest[\s-]?sellers?\b|\bwhat\s+(?:do\s+)?you\s+(?:sell|have|offer)\b/i
const COLOR_WORD_RE = /\bcolou?rs?\b|\bshades?\b/i
const SIZE_WORD_RE = /\bsizes?\b/i
const FACET_QUESTION_RE =
  /\b(?:what|which|other|different|available|more|any|all|list|options?|have|got|come|comes)\b/i

const GREETING_RE = /^\s*(?:hi+|hello|hey+|hiya|good\s+(?:morning|afternoon|evening|day)|namaste|yo|g'?day)\b/i
const THANKS_RE =
  /\b(?:thanks?|thank\s*you|thx|ty|cheers|appreciate|great|perfect|awesome|ok(?:ay)?|cool|bye|goodbye|noted)\b/i
const POLICY_RE =
  /\b(?:return|returns|refund|exchange|shipping|ship|deliver(?:y|ies)?|track(?:ing)?|order|payment|pay|afterpay|warranty|policy|address|hours|open|location|contact|email|phone)\b/i
const HUMAN_RE =
  /\b(?:human|person|agent|someone|somebody|staff|manager|call\s+me|speak|talk)\b/i
/** "where is my order" / "track my order" — support, not a new purchase. */
const ORDER_STATUS_RE =
  /\b(?:where(?:'s|\s+is)|where\s+are|track(?:ing)?|status|cancel(?:led|ed)?|refund)\b[^.?!]{0,48}\border\b|\border\s+(?:status|tracking|number|update)\b|\b(?:track|cancel|refund)\s+(?:my\s+)?order\b/i
/** Buying the item already discussed. "check out the range" is browsing, not checkout. */
const ORDER_RE =
  /\b(?:plac(?:e|ing)(?:\s+(?:an|the))?\s+order|(?:need|want|like|ready)\s+to\s+(?:place\s+)?(?:an\s+|the\s+)?order|(?:i(?:['’]d| would)\s+like|i(?:['’]ll| will))\s+(?:to\s+)?(?:place\s+(?:an|the)\s+)?order|buy\s+(?:this|it|the|that)|i(?:['’]ll| will)\s+take\s+(?:it|this|that)(?:\s+one)?|purchase\s+(?:this|it|the|that)|check\s*-?\s*out\b(?!\s+(?:the|your|these|those|our|some)))/i
const FOLLOW_UP_RE =
  /\b(?:links?|url|price|prices|cost|how\s+much|cheaper|cheapest|expensive|available|availability|stock|send|show|more|other|another|options?|that\s+one|this\s+one|it|them|those|these|which\s+one|recommend|suggest|similar|any)\b/i

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripAll(text: string, re: RegExp): { text: string; matched: boolean } {
  re.lastIndex = 0
  const next = text.replace(re, ' ')
  re.lastIndex = 0
  return { text: next, matched: next !== text }
}

function pushUnique<T>(list: T[], values: T[]): void {
  for (const v of values) if (!list.includes(v)) list.push(v)
}

function analyseTurn(raw: string, opts: PlanOptions): TurnSignals {
  let text = ` ${raw.replace(/[\u2010-\u2014]/g, '-')} `

  const designs: string[] = []
  for (const design of opts.designs ?? []) {
    if (design.trim().split(/\s+/).length < 2) continue
    const re = new RegExp(`\\b${escapeRe(design).replace(/\s+/g, '\\s*')}\\b`, 'gi')
    const next = stripAll(text, re)
    if (next.matched) {
      designs.push(design)
      text = next.text
    }
  }

  let maxPrice: number | null = null
  PRICE_RE.lastIndex = 0
  for (const match of text.matchAll(PRICE_RE)) {
    const n = Number(match[1])
    if (Number.isFinite(n)) maxPrice = maxPrice == null ? n : Math.min(maxPrice, n)
  }
  text = stripAll(text, PRICE_RE).text

  const piecesMatch = text.match(PIECES_RE)
  const pieces = piecesMatch ? Number(piecesMatch[1]) : null

  const sizeSlugs: string[] = []
  for (const { re, slug } of SIZE_PATTERNS) {
    const next = stripAll(text, re)
    if (next.matched) pushUnique(sizeSlugs, [slug])
    text = next.text
  }

  const types: WantedType[] = []
  let comforterExplicit = false
  for (const { re, types: mapped, comforter } of TYPE_PATTERNS) {
    const next = stripAll(text, re)
    if (next.matched) {
      pushUnique(types, mapped)
      if (comforter) comforterExplicit = true
    }
    text = next.text
  }

  const mixed = MIXED_RE.test(text)
  const colors: string[] = []
  if (!mixed) {
    for (const { re, family } of COLOR_PATTERNS) {
      const next = stripAll(text, re)
      if (next.matched) pushUnique(colors, [family])
      text = next.text
    }
  }

  const asksColors =
    !mixed && colors.length === 0 && COLOR_WORD_RE.test(raw) && FACET_QUESTION_RE.test(raw)
  const asksSizes =
    sizeSlugs.length === 0 && SIZE_WORD_RE.test(raw) && FACET_QUESTION_RE.test(raw)
  const asksBrowse = mixed || BROWSE_RE.test(raw)

  return {
    sizeSlugs,
    colors,
    types,
    comforterExplicit,
    maxPrice,
    designs,
    pieces,
    genericBedding: GENERIC_BEDDING_RE.test(raw),
    asksColors,
    asksSizes,
    asksBrowse,
    asksOrder: ORDER_RE.test(raw) && !ORDER_STATUS_RE.test(raw),
    followUp: FOLLOW_UP_RE.test(raw),
    nonProduct:
      GREETING_RE.test(raw) || THANKS_RE.test(raw) || POLICY_RE.test(raw) || HUMAN_RE.test(raw),
  }
}

function hasFilters(s: {
  sizeSlugs: string[]
  colors: string[]
  types: string[]
  designs: string[]
  maxPrice: number | null
  pieces: number | null
}): boolean {
  return (
    s.sizeSlugs.length > 0 ||
    s.colors.length > 0 ||
    s.types.length > 0 ||
    s.designs.length > 0 ||
    s.maxPrice != null ||
    s.pieces != null
  )
}

function productSignal(s: TurnSignals): boolean {
  return (
    hasFilters(s) || s.genericBedding || s.asksColors || s.asksSizes || s.asksBrowse
  )
}

function emptyPlan(intent: QueryIntent): PlannedQuery {
  return {
    intent,
    sizeSlugs: [],
    colors: [],
    types: [],
    comforterExplicit: false,
    maxPrice: null,
    designs: [],
    pieces: null,
  }
}

/** Plan from the customer's recent turns, oldest first. */
export function planConversation(turns: string[], opts: PlanOptions = {}): PlannedQuery {
  const recent = turns
    .map((t) => (t ?? '').trim())
    .filter(Boolean)
    .slice(-MAX_TURNS)
  if (recent.length === 0) return emptyPlan('none')

  const signals = recent.map((t) => analyseTurn(t, opts))
  const last = signals[signals.length - 1]

  // "ok" and "order" also match thanks/policy, so a buy phrase has to win
  // before that early return — otherwise "need to place order" is `none`.
  if (!last.asksOrder && !productSignal(last) && (last.nonProduct || !last.followUp)) {
    return emptyPlan('none')
  }
  if (
    !last.asksOrder &&
    last.asksBrowse &&
    !hasFilters(last) &&
    !last.asksColors &&
    !last.asksSizes
  ) {
    return emptyPlan('browse')
  }

  const state = emptyPlan('search')
  for (const s of signals) {
    if (s.asksBrowse && !hasFilters(s)) {
      Object.assign(state, emptyPlan('search'))
      continue
    }
    if (s.sizeSlugs.length > 0) state.sizeSlugs = s.sizeSlugs
    if (s.types.length > 0) {
      state.types = s.types
      state.comforterExplicit = s.comforterExplicit
      if (s.designs.length === 0) state.designs = []
    }
    if (s.designs.length > 0) state.designs = s.designs
    // A colour-list question keeps the earlier colour: the list itself ignores
    // it, and a follow-up like "do you have it in king?" still means that colour.
    if (s.colors.length > 0) state.colors = s.colors
    if (s.maxPrice != null) state.maxPrice = s.maxPrice
    if (s.pieces != null) state.pieces = s.pieces
  }

  if (last.asksOrder) state.intent = 'order'
  else if (last.asksColors) state.intent = 'colors'
  else if (last.asksSizes) state.intent = 'sizes'
  else if (!hasFilters(state)) state.intent = 'browse'
  return state
}

/** Single-message convenience (newlines are treated as separate turns). */
export function planProductQuery(text: string, opts: PlanOptions = {}): PlannedQuery {
  return planConversation((text ?? '').split(/\n+/), opts)
}
