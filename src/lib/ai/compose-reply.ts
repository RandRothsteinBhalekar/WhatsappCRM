import type { SupabaseClient } from '@/lib/db/supabase-types'
import {
  buildOrderReply,
  retrieveCatalogue,
  type CatalogueCustomer,
  type ProductRetrieval,
} from '@/lib/woocommerce/retrieve-products'
import { guardProductReply, productUrls } from '@/lib/woocommerce/reply-guard'
import { buildSystemPrompt } from './defaults'
import { generateReply } from './generate'
import { retrieveKnowledge } from './knowledge'
import {
  latestUserMessage,
  previousAssistantMessage,
  recentCustomerTurns,
} from './query'
import type { AiConfig, AiUsage, ChatMessage } from './types'

export type ComposeOutcome =
  /** Model text sent as-is (possibly with unknown links removed / links appended). */
  | 'model'
  /** Model text from the corrective retry. */
  | 'retried'
  /** Deterministic product list after a repeated refusal. */
  | 'fallback'
  | 'handoff'

export interface ComposedReply {
  text: string
  handoff: boolean
  outcome: ComposeOutcome
  /** One entry per provider call (2 when the guard asked for a retry). */
  usages: (AiUsage | null)[]
  retrieval: ProductRetrieval
}

/**
 * Knowledge + live catalogue retrieval → prompt → generate → guard, with
 * at most one corrective retry. Shared by auto-reply, draft and the
 * playground so all three answer a customer identically. Never sends or
 * writes anything; callers own delivery, handoff side effects and usage
 * logging.
 */
export async function composeGroundedReply(args: {
  db: SupabaseClient
  accountId: string
  config: AiConfig
  messages: ChatMessage[]
  mode: 'draft' | 'auto_reply'
  /** When set, name and phone already on the contact are added to an order reply. */
  contactId?: string | null
}): Promise<ComposedReply> {
  const { db, accountId, config, messages, mode } = args

  const previousAssistant = previousAssistantMessage(messages)
  const [knowledge, retrieval] = await Promise.all([
    retrieveKnowledge(db, accountId, config, latestUserMessage(messages)),
    loadContact(db, args.contactId).then((customer) =>
      retrieveCatalogue(db, accountId, recentCustomerTurns(messages), {
        citedPermalinks: productUrls(previousAssistant ?? ''),
        customer,
      }),
    ),
  ])

  const systemPrompt = buildSystemPrompt({
    userPrompt: config.systemPrompt,
    mode,
    knowledge,
    products: retrieval.excerpts,
    catalogueFacts: retrieval.facts,
  })
  const sharedUrls = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => productUrls(m.content))
  const usages: (AiUsage | null)[] = []
  const handoff = (): ComposedReply => ({
    text: '',
    handoff: true,
    outcome: 'handoff',
    usages,
    retrieval,
  })
  // Buying is not a reason to pause the bot. A handoff or an empty draft
  // becomes the checkout message instead.
  const orderReply = (): ComposedReply | null => {
    if (retrieval.plan.intent !== 'order') return null
    return {
      text: buildOrderReply(retrieval.items, retrieval.customer),
      handoff: false,
      outcome: 'fallback',
      usages,
      retrieval,
    }
  }

  const first = await generateReply({ config, systemPrompt, messages })
  usages.push(first.usage)
  if (first.handoff || !first.text.trim()) return orderReply() ?? handoff()

  const verdict = guardProductReply({
    text: first.text,
    retrieval,
    previousAssistant,
    sharedUrls,
    allowRetry: true,
  })
  if (verdict.action === 'send') {
    return {
      text: verdict.text,
      handoff: false,
      outcome: verdict.fallback ? 'fallback' : 'model',
      usages,
      retrieval,
    }
  }
  if (verdict.action === 'handoff') return orderReply() ?? handoff()

  const second = await generateReply({
    config,
    systemPrompt: `${systemPrompt}\n\n${verdict.instruction}`,
    messages,
  })
  usages.push(second.usage)
  if (second.handoff || !second.text.trim()) return orderReply() ?? handoff()

  const final = guardProductReply({
    text: second.text,
    retrieval,
    previousAssistant,
    sharedUrls,
    allowRetry: false,
  })
  if (final.action !== 'send') return orderReply() ?? handoff()
  return {
    text: final.text,
    handoff: false,
    outcome: final.fallback ? 'fallback' : 'retried',
    usages,
    retrieval,
  }
}

async function loadContact(
  db: SupabaseClient,
  contactId: string | null | undefined,
): Promise<CatalogueCustomer | null> {
  if (!contactId) return null
  try {
    const { data, error } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    if (error || !data) return null
    const row = data as { name?: string | null; phone?: string | null }
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const phone = typeof row.phone === 'string' ? row.phone.trim() : ''
    if (!name && !phone) return null
    return { name: name || null, phone: phone || null }
  } catch (err) {
    console.error('[ai] contact lookup for order reply failed:', err)
    return null
  }
}
