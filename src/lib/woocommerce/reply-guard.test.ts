import { describe, expect, it } from 'vitest'
import { fixtureSnapshot } from './catalogue-fixtures'
import { planConversation } from './query-planner'
import {
  buildProductListReply,
  guardProductReply,
  isInventoryRefusal,
  looksCutOff,
  stripUnknownProductUrls,
  type GuardRetrieval,
} from './reply-guard'
import { checkoutUrlFor, formatCatalogueExcerpt, selectFromCatalogue } from './retrieve-products'

const snap = fixtureSnapshot()

function retrievalFor(turns: string[], configured = true): GuardRetrieval {
  const plan = planConversation(turns, { designs: snap.designs })
  const sel = selectFromCatalogue(snap.items, plan)
  return {
    configured,
    plan,
    ...sel,
    excerpts: sel.items.map(formatCatalogueExcerpt),
    isKnownPermalink: snap.isKnownPermalink,
  }
}

const ORANGE = retrievalFor(['Light orange color, queen size bed'])
const KNOWN = ORANGE.items[0].permalink

describe('isInventoryRefusal', () => {
  it('detects capability refusals', () => {
    expect(isInventoryRefusal("I don't have access to the live inventory to check that.")).toBe(true)
    expect(isInventoryRefusal('I am unable to access the live inventory right now.')).toBe(true)
    expect(isInventoryRefusal("Sorry, I can't share product links here.")).toBe(true)
  })

  it('lets honest availability answers through', () => {
    expect(isInventoryRefusal("We don't have light orange in stock in Queen right now.")).toBe(false)
    expect(isInventoryRefusal("We don't have that colour in our catalogue, but here's the closest.")).toBe(false)
    expect(isInventoryRefusal(`Here is a Queen set for $89: ${KNOWN}`)).toBe(false)
  })
})

describe('stripUnknownProductUrls', () => {
  it('removes invented product links and keeps real ones', () => {
    const out = stripUnknownProductUrls(
      `Try ${KNOWN} or https://shop.example/product/made-up-thing/.`,
      snap.isKnownPermalink,
    )
    expect(out).toMatchObject({ removed: 1, known: 1 })
    expect(out.text).toContain(KNOWN)
    expect(out.text).not.toContain('made-up-thing')
  })
})

describe('guardProductReply', () => {
  it('asks for one retry on a refusal', () => {
    expect(
      guardProductReply({
        text: "I don't have access to the live inventory.",
        retrieval: ORANGE,
        previousAssistant: null,
        allowRetry: true,
      }),
    ).toMatchObject({ action: 'retry', reason: 'refusal' })
  })

  it('falls back to a sized product list after a second refusal', () => {
    const out = guardProductReply({
      text: "I don't have access to the live inventory.",
      retrieval: ORANGE,
      previousAssistant: null,
      allowRetry: false,
    })
    expect(out.action).toBe('send')
    if (out.action === 'send') {
      expect(out.fallback).toBe(true)
      expect(out.text).toMatch(/Queen products in orange/)
      expect(out.text).toContain('Queen')
      expect(out.text).toContain(KNOWN)
    }
  })

  it('hands off a refusal when nothing was retrieved', () => {
    const empty = { ...ORANGE, items: [], excerpts: [] }
    expect(
      guardProductReply({
        text: 'I am unable to access the live inventory.',
        retrieval: empty,
        previousAssistant: null,
        allowRetry: false,
      }),
    ).toMatchObject({ action: 'handoff' })
  })

  it('retries then hands off a reply identical to the previous one', () => {
    const args = {
      text: 'Here are our queen options.',
      retrieval: ORANGE,
      previousAssistant: 'Here are our  QUEEN options.',
    }
    expect(guardProductReply({ ...args, allowRetry: true })).toMatchObject({ action: 'retry', reason: 'duplicate' })
    expect(guardProductReply({ ...args, allowRetry: false })).toMatchObject({ action: 'handoff' })
  })

  it('appends real links to a search reply that has none', () => {
    const out = guardProductReply({
      text: 'We have a couple of warm orange queen options.',
      retrieval: ORANGE,
      previousAssistant: null,
      allowRetry: true,
    })
    expect(out.action).toBe('send')
    if (out.action === 'send') expect(out.text).toContain(KNOWN)
  })

  it('does not append links to a colour list or a non-product reply', () => {
    const colours = retrievalFor(['queen bed', 'What colours do you have?'])
    const out = guardProductReply({
      text: 'In Queen we have Marigold Ember, Clay Ember, Blush Rose and Ocean Blue.',
      retrieval: colours,
      previousAssistant: null,
      allowRetry: true,
    })
    expect(out).toEqual({
      action: 'send',
      text: 'In Queen we have Marigold Ember, Clay Ember, Blush Rose and Ocean Blue.',
    })
    const thanks = retrievalFor(['queen orange bed', 'Thanks!'])
    expect(
      guardProductReply({ text: "You're welcome!", retrieval: thanks, previousAssistant: null, allowRetry: true }),
    ).toEqual({ action: 'send', text: "You're welcome!" })
  })

  it('retries then hands off a reply cut off mid-sentence', () => {
    const args = { text: "You're very", retrieval: ORANGE, previousAssistant: null }
    expect(guardProductReply({ ...args, allowRetry: true })).toMatchObject({ action: 'retry', reason: 'truncated' })
    expect(guardProductReply({ ...args, allowRetry: false })).toEqual({ action: 'handoff', reason: 'truncated' })
    expect(looksCutOff('Thank you 🙏')).toBe(false)
    expect(looksCutOff('Hello')).toBe(false)
    expect(looksCutOff("You're welcome!")).toBe(false)
  })

  it('drops real catalogue links that were neither retrieved nor shared before', () => {
    const king = retrievalFor(['Light orange color, queen size bed', 'Do you have it in king?'])
    const kingUrl = king.items[0].permalink
    const queenUrl = ORANGE.items[0].permalink
    const text = `Try ${kingUrl} or ${queenUrl}`
    const fresh = guardProductReply({ text, retrieval: king, previousAssistant: null, allowRetry: true })
    expect(fresh.action === 'send' && fresh.text).toBe(`Try ${kingUrl} or`)

    const resent = guardProductReply({
      text,
      retrieval: king,
      previousAssistant: null,
      sharedUrls: [queenUrl],
      allowRetry: true,
    })
    expect(resent.action === 'send' && resent.text).toBe(text)
  })

  it('appends the checkout link when an order reply forgot it', () => {
    const order = retrievalFor([
      'What is comforters?',
      'Ok looks good need to place order',
    ])
    const url = checkoutUrlFor(order.items[0])!
    const out = guardProductReply({
      text: 'I can take that order for you.',
      retrieval: order,
      previousAssistant: null,
      allowRetry: true,
    })
    expect(out.action).toBe('send')
    if (out.action === 'send') expect(out.text).toContain(url)

    const kept = guardProductReply({
      text: `Pay here: ${url}`,
      retrieval: order,
      previousAssistant: null,
      allowRetry: true,
    })
    expect(kept).toEqual({ action: 'send', text: `Pay here: ${url}` })
  })
})

describe('buildProductListReply', () => {
  it('uses the retrieval headline and shows size per line', () => {
    const text = buildProductListReply(ORANGE)
    expect(text.split('\n')[0]).toBe(ORANGE.headline)
    expect(text).toContain('Leafora Serenity 3-Piece Quilt Cover Set – Marigold Ember — Queen — $89.00 AUD')
  })
})
