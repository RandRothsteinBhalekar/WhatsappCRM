import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({
  generateReply: vi.fn(),
  retrieveCatalogue: vi.fn(),
}))

vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: vi.fn(async () => []) }))
vi.mock('@/lib/woocommerce/retrieve-products', async (orig) => ({
  ...(await orig<typeof import('@/lib/woocommerce/retrieve-products')>()),
  retrieveCatalogue: h.retrieveCatalogue,
}))

import { fixtureSnapshot } from '@/lib/woocommerce/catalogue-fixtures'
import { planConversation } from '@/lib/woocommerce/query-planner'
import { selectFromCatalogue, type ProductRetrieval } from '@/lib/woocommerce/retrieve-products'
import { composeGroundedReply } from './compose-reply'

const snap = fixtureSnapshot()

function orderRetrieval(): ProductRetrieval {
  const turns = ['What is comforters?', 'Ok looks good need to place order']
  const plan = planConversation(turns, { designs: snap.designs })
  const sel = selectFromCatalogue(snap.items, plan)
  return {
    configured: true,
    plan,
    ...sel,
    excerpts: sel.items.map((item) => item.name),
    isKnownPermalink: snap.isKnownPermalink,
  }
}

const config: AiConfig = {
  provider: 'openai',
  model: 'gpt-test',
  baseUrl: null,
  apiKey: 'sk-test',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 20,
  handoffAgentId: null,
  embeddingsApiKey: null,
}

beforeEach(() => {
  h.generateReply.mockReset()
  h.retrieveCatalogue.mockReset()
})

describe('composeGroundedReply — order', () => {
  it('sends the checkout link instead of pausing when the model hands off', async () => {
    const retrieval = orderRetrieval()
    h.retrieveCatalogue.mockResolvedValue(retrieval)
    h.generateReply.mockResolvedValue({ text: '', handoff: true, usage: null })

    const reply = await composeGroundedReply({
      db: {} as never,
      accountId: 'acct',
      config,
      messages: [{ role: 'user', content: 'Ok looks good need to place order' }],
      mode: 'auto_reply',
    })

    expect(reply.handoff).toBe(false)
    expect(reply.outcome).toBe('fallback')
    expect(reply.text).toContain(`checkout/?add-to-cart=${retrieval.items[0].id}`)
    expect(reply.text).toMatch(/full name and delivery address/i)
    expect(reply.text).toMatch(/card details/i)
    expect(h.generateReply).toHaveBeenCalledOnce()
  })
})
