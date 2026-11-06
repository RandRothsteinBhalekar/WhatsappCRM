/**
 * Post-generation guard for catalogue-grounded replies:
 *  - a "I can't access the inventory / website / links" claim gets one
 *    corrective retry, then a deterministic product list or a handoff;
 *  - product URLs that are neither this turn's retrieved rows nor already
 *    shared in the chat are removed (no invented or guessed links);
 *  - a reply identical to the previous assistant message is not re-sent;
 *  - a reply cut off after a few words gets one retry, then a handoff;
 *  - product asks still get clickable links when the model forgot them;
 *  - an order reply that forgot its checkout link gets that link appended.
 * It only ever judges *capability* refusals — "we don't have that colour
 * in stock" is an honest answer and passes through.
 */
import { normalizePermalink, type CatalogueItem } from './catalogue'
import { checkoutUrlFor, type ProductRetrieval } from './retrieve-products'

const CAPABILITY_REFUSAL_RE =
  /\b(?:do\s+not|don't|dont|cannot|can't|cant|unable\s+to|not\s+able\s+to)\s+(?:have\s+)?(?:real[\s-]?time\s+|direct\s+|live\s+)?(?:access|check|verify|browse|look\s+up|share|provide|send|confirm)\b[^.!?\n]{0,60}?\b(?:inventory|stock\s+(?:levels?|availability)|catalog(?:ue)?|website|product\s+links?|links?|real[\s-]?time\s+(?:data|information|info))\b/i

const URL_RE = /https?:\/\/[^\s<>()[\]"']+/gi
const PRODUCT_PATH_RE = /\/product\//i

export type GuardedReply =
  | { action: 'send'; text: string; fallback?: boolean }
  | { action: 'handoff'; reason: 'empty' | 'refusal' | 'duplicate' | 'truncated' }
  | { action: 'retry'; reason: 'refusal' | 'duplicate' | 'truncated'; instruction: string }

export type GuardRetrieval = Pick<
  ProductRetrieval,
  'configured' | 'plan' | 'items' | 'excerpts' | 'match' | 'headline' | 'isKnownPermalink'
>

export const RETRY_INSTRUCTIONS = {
  refusal:
    'Correction: your previous draft claimed you cannot access the inventory, website or product links. That is false — the Live product catalogue and Catalogue facts in this prompt ARE the live store. Rewrite the reply from them, with product names, prices and their exact permalink URLs.',
  duplicate:
    'Correction: your previous draft repeated your last message word for word. Answer the customer\'s latest message specifically, using the Catalogue facts and product rows in this prompt.',
  truncated:
    'Correction: your previous draft stopped mid-sentence. Write the complete reply.',
} as const

export function isInventoryRefusal(text: string): boolean {
  return CAPABILITY_REFUSAL_RE.test(text)
}

/**
 * A provider occasionally stops after a few tokens ("You're very"). Flag short
 * multi-word replies with no sentence ending, link or emoji anywhere.
 */
export function looksCutOff(text: string): boolean {
  const t = text.trim()
  if (t.length === 0 || t.length > 60) return false
  if (t.split(/\s+/).length < 2) return false
  return !/[.!?…:;)\]。！？]|https?:\/\/|\p{Extended_Pictographic}/u.test(t)
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?*_]+$/, '')
}

/** Every product-page URL in `text`. */
export function productUrls(text: string): string[] {
  return [...text.matchAll(URL_RE)]
    .map((m) => trimUrl(m[0]))
    .filter((u) => PRODUCT_PATH_RE.test(u))
}

/** Remove product URLs the catalogue does not know. */
export function stripUnknownProductUrls(
  text: string,
  isKnown: (url: string) => boolean,
): { text: string; removed: number; known: number } {
  let removed = 0
  let known = 0
  const replaced = text.replace(URL_RE, (match) => {
    const url = trimUrl(match)
    if (!PRODUCT_PATH_RE.test(url)) return match
    if (isKnown(url)) {
      known++
      return match
    }
    removed++
    return match.slice(url.length)
  })
  if (removed === 0) return { text, removed, known }
  const cleaned = replaced
    .replace(/\(\s*\)/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s*[—–:-]\s*$/, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: cleaned, removed, known }
}

function productLine(item: CatalogueItem): string {
  return [item.name, item.size, item.priceLabel, item.permalink].filter(Boolean).join(' — ')
}

/** Deterministic reply from the retrieved rows. */
export function buildProductListReply(retrieval: Pick<GuardRetrieval, 'items' | 'headline'>, limit = 3): string {
  const lines = retrieval.items.slice(0, limit).map((i) => `• ${productLine(i)}`)
  if (lines.length === 0) return ''
  const headline = retrieval.headline || 'Here are some current options from our store:'
  return `${headline}\n\n${lines.join('\n')}`
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function isDuplicate(text: string, previous: string | null): boolean {
  return !!previous && normalizeForCompare(text) === normalizeForCompare(previous)
}

/**
 * A product link may be sent only if it is one of this turn's retrieved rows or
 * was already shared in the chat. The model only ever sees those, so any other
 * catalogue URL was pattern-guessed and can point at the wrong size or colour.
 */
function citableUrlCheck(
  retrieval: GuardRetrieval,
  sharedUrls: readonly string[],
): (url: string) => boolean {
  const allowed = new Set(
    [...retrieval.items.map((i) => i.permalink), ...sharedUrls].map(normalizePermalink),
  )
  return (url) => retrieval.isKnownPermalink(url) && allowed.has(normalizePermalink(url))
}

export function guardProductReply(args: {
  text: string
  retrieval: GuardRetrieval
  previousAssistant: string | null
  /** Product URLs already sent earlier in this conversation. */
  sharedUrls?: readonly string[]
  allowRetry: boolean
}): GuardedReply {
  const { retrieval, previousAssistant, allowRetry } = args
  const text = (args.text ?? '').trim()
  if (!text) return { action: 'handoff', reason: 'empty' }
  if (looksCutOff(text)) {
    return allowRetry
      ? { action: 'retry', reason: 'truncated', instruction: RETRY_INSTRUCTIONS.truncated }
      : { action: 'handoff', reason: 'truncated' }
  }

  const fallback = (): GuardedReply => {
    const list = buildProductListReply(retrieval)
    if (!list || isDuplicate(list, previousAssistant)) {
      return { action: 'handoff', reason: 'refusal' }
    }
    return { action: 'send', text: list, fallback: true }
  }

  if (retrieval.configured && isInventoryRefusal(text)) {
    if (allowRetry) {
      return { action: 'retry', reason: 'refusal', instruction: RETRY_INSTRUCTIONS.refusal }
    }
    return fallback()
  }

  const stripped = stripUnknownProductUrls(
    text,
    citableUrlCheck(retrieval, args.sharedUrls ?? []),
  )
  if (!stripped.text) return fallback()

  if (isDuplicate(stripped.text, previousAssistant)) {
    if (allowRetry) {
      return { action: 'retry', reason: 'duplicate', instruction: RETRY_INSTRUCTIONS.duplicate }
    }
    return { action: 'handoff', reason: 'duplicate' }
  }

  if (retrieval.plan.intent === 'order' && retrieval.items.length > 0) {
    const lines = retrieval.items.slice(0, 3).flatMap((item) => {
      const url = checkoutUrlFor(item)
      return url ? [`• ${item.name} — ${item.priceLabel} — ${url}`] : []
    })
    const forgotAll = lines.length > 0 && lines.every((line) => {
      const url = line.slice(line.lastIndexOf('https://'))
      return !stripped.text.includes(url)
    })
    if (forgotAll) {
      return { action: 'send', text: `${stripped.text}\n\n${lines.join('\n')}` }
    }
    return { action: 'send', text: stripped.text }
  }

  const linkable =
    (retrieval.plan.intent === 'search' || retrieval.plan.intent === 'browse') &&
    retrieval.match !== 'none' &&
    retrieval.items.length > 0
  if (linkable && stripped.known === 0) {
    const links = retrieval.items
      .slice(0, 3)
      .map((i) => `• ${productLine(i)}`)
      .join('\n')
    return { action: 'send', text: `${stripped.text}\n\n${links}` }
  }

  return { action: 'send', text: stripped.text }
}
